/** 清理仅覆盖本插件的数据目录；凭据与运行状态由各模块登记处理。 */
import { lstatSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'
import { presetForAgent } from './agent-preset.ts'
import { MAINTENANCE_PATH, type CleanupKind, type MaintenanceView } from './maintenance-types.ts'
import { isRecord, readJson, writeJson } from './storage.ts'

interface CleanupHooks {
  cache?(): void
  prepare?(): void
  credentials?(): Promise<void>
  reload?(): void
}

export class Maintenance {
  private readonly hooks = new Set<CleanupHooks>()
  private busy = false
  private disposed = false
  private writes = 0
  private cacheEpoch = randomUUID()
  private dataEpoch: string
  private readonly marker: string
  constructor(private readonly home: string, warn: (message: string) => void) {
    this.marker = join(home, 'qqbot', 'cleanup-state.json')
    const saved = readJson(this.marker, warn)
    this.dataEpoch = isRecord(saved) && typeof saved['dataEpoch'] === 'string' ? saved['dataEpoch'] : ''
  }
  register(hooks: CleanupHooks): () => void { this.hooks.add(hooks); return () => { this.hooks.delete(hooks) } }
  get active(): boolean { return this.busy }
  dispose(): void { this.disposed = true }
  assertAvailable(): void { if (this.busy) throw new Error('正在清理 QQ Bot 数据，请稍后再试。') }
  view(): MaintenanceView { return { cacheEpoch: this.cacheEpoch, dataEpoch: this.dataEpoch } }

  /** 清理期间拒绝写入，已有保存未结束时拒绝开始清理。 */
  route(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
    return async request => {
      if (request.method !== 'POST') return handler(request)
      if (this.busy) return Response.json({ message: '正在清理 QQ Bot 数据，请稍后再试。' }, { status: 409 })
      const epoch = request.headers.get('x-qqbot-data-epoch')
      if (epoch !== null && epoch !== this.dataEpoch) return Response.json({ message: 'QQ Bot 数据已清理，请重新打开设置后再操作。' }, { status: 409 })
      this.writes++
      try { return await handler(request) } finally { this.writes-- }
    }
  }

  async clear(kind: CleanupKind): Promise<MaintenanceView> {
    if (this.disposed) throw new Error('QQ Bot 已停用，清理操作已取消。')
    if (this.busy || this.writes > 0) throw new Error('QQ Bot 正在处理操作，请稍后再试。')
    // 固定两个目录，拒绝被改成联接的根目录；不接受客户端提供的路径。
    const targets = ['qqbot', 'toy-buttplug'].map(name => resolve(this.home, name))
    if (kind === 'all') for (const target of targets) {
      if (dirname(target) !== resolve(this.home)) throw new Error('数据目录超出清理范围。')
      try { if (lstatSync(target).isSymbolicLink()) throw new Error('数据目录是联接，无法清理。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.busy = true
    let deleting = false
    try {
      if (kind === 'all') {
        for (const hooks of this.hooks) hooks.prepare?.()
        for (const hooks of this.hooks) await hooks.credentials?.()
        if (this.disposed) throw new Error('QQ Bot 已停用，清理操作已取消。')
        deleting = true
        for (const target of targets) rmSync(target, { recursive: true, force: true })
      }
      for (const hooks of this.hooks) hooks.cache?.()
      this.cacheEpoch = randomUUID()
    } finally {
      try {
        if (deleting) {
          // 删除失败也撤销旧内存副本，避免下一次保存复活已删除的资料。
          this.dataEpoch = randomUUID()
          let failure: unknown
          try { writeJson(this.marker, { dataEpoch: this.dataEpoch }) } catch (error) { failure = error }
          for (const hooks of this.hooks) {
            try { hooks.reload?.() } catch (error) { failure ??= error }
          }
          if (failure !== undefined) throw failure
        }
      } finally { this.busy = false }
    }
    return this.view()
  }
}

/** 可选 qqbot 的内置模块和独立模拟夹具共用同一路由。 */
export function guardWrites(ctx: Context, handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return request => {
    const service = ctx.get('qqbot') as { maintenance: Maintenance } | undefined
    return service === undefined ? handler(request) : service.maintenance.route(handler)(request)
  }
}

export const inject = ['qqbot', 'connection']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: MAINTENANCE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        if (request.method === 'GET') return Response.json(ctx.qqbot.maintenance.view(), { headers: { 'cache-control': 'no-store' } })
        const body: unknown = await request.json()
        if (!isRecord(body) || !['cache', 'all'].includes(String(body['action']))) return Response.json({ message: '清理请求无效。' }, { status: 400 })
        if (body['action'] === 'all') {
          const agents = ctx.get('agents'), presets = ctx.get('agentPresets')
          if (agents && presets && agents.list().some(agent => presetForAgent(presets, agent) === 'qqbot' && agent.status !== 'idle')) {
            throw new Error('QQ Bot 还有正在进行的回复，请先停止回复再清理全部数据。')
          }
        }
        return Response.json(await ctx.qqbot.maintenance.clear(body['action'] as CleanupKind), { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        ctx.logger.warn('qqbot cleanup: %s', error)
        return Response.json({ message: error instanceof Error ? error.message : '清理未完成。' }, { status: 409 })
      }
    },
  }), 'qqbot: maintenance route')
}
