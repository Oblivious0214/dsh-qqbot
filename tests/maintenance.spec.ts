import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QqbotService } from '../src/index.ts'
import { Maintenance } from '../src/maintenance.ts'
import * as maintenanceModule from '../src/maintenance.ts'
import { MAINTENANCE_PATH } from '../src/maintenance-types.ts'
import { dshHome } from '../src/storage.ts'
import * as library from '../src/library.ts'
import * as voice from '../src/voice.ts'
import * as toy from '../src/toy/index.ts'
import { defaultSettings } from '../src/toy/settings.ts'
import { STATE_PATH } from '../src/toy/api-types.ts'
import { VOICE_PATH } from '../src/voice-types.ts'
import { MaintenanceClient } from '../src/client/maintenance.ts'

type Route = { path: string; fetch(request: Request): Promise<Response> }
const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })
async function fixture() {
  const root = new Context(); roots.push(root)
  const routes = new Map<string, Route>()
  const records = new Map<string, unknown>([['other/key', { kind: 'api-key', key: 'preserve' }], ['dsh-qqbot/tts-e-orphan', { kind: 'api-key', key: 'secret' }]])
  root.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  root.provide('credentials', {
    listRecords: async () => [...records.keys()].map(key => ({ key, kind: 'api-key' })),
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, update: (value: unknown) => Promise<unknown>) => { records.set(key, await update(records.get(key))) },
    deleteRecord: async (key: string) => { records.delete(key) },
  })
  await root.plugin(QqbotService)
  await root.plugin(library)
  await root.plugin(voice)
  await root.plugin(toy)
  await root.plugin(maintenanceModule)
  const service = root.qqbot
  const call = (path: string, action?: unknown) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, action === undefined ? {} : { method: 'POST', body: JSON.stringify(action) }))
  return { root, records, routes, service, call }
}

describe('QQ Bot 数据维护', () => {
  it('缓存清理保留全部配置、语音凭据和设备授权，清空临时提示词副本', async () => {
    const { service, records, call } = await fixture()
    const role = service.content.roles.save({ name: '保留角色', description: '', persona: '保留正文' }, true)
    service.content.bindings.setDefaultRole(role.id)
    const agent = {}; service.lastPrompt.set(agent, '旧前缀')
    await call(STATE_PATH, { action: 'settings.save', settings: { ...defaultSettings(), authorized: true } })
    const before = readFileSync(join(dshHome(), 'toy-buttplug/settings.json'))
    const revision = service.maintenance.view()
    const response = await call(MAINTENANCE_PATH, { action: 'cache' })
    expect(response.status, await response.text()).toBe(200)
    expect(service.content.roles.get(role.id)?.persona).toBe('保留正文')
    expect(service.lastPrompt.get(agent)).toBeUndefined()
    expect(service.maintenance.view().cacheEpoch).not.toBe(revision.cacheEpoch)
    expect(service.maintenance.view().dataEpoch).toBe(revision.dataEpoch)
    expect(readFileSync(join(dshHome(), 'toy-buttplug/settings.json'))).toEqual(before)
    expect(records.has('dsh-qqbot/tts-e-orphan')).toBe(true)
  })

  it('全部清理删除自有资料和孤立凭据，当前服务立即恢复初始状态，保留宿主文件', async () => {
    const { service, records, call } = await fixture()
    const role = service.content.roles.save({ name: '删除角色', description: '', persona: '删除正文' }, true)
    service.content.bindings.set('old-session', role.id)
    service.content.memories.save(role.id, '## 关系\n旧关系')
    service.ui.saveSettings({ ...service.ui.settings, fontSize: 20 })
    const uiFile = join(dshHome(), 'qqbot/ui.json')
    const host = join(dshHome(), 'sessions/native-chat.json')
    mkdirSync(join(dshHome(), 'sessions'), { recursive: true }); writeFileSync(host, '原生聊天')
    await call(VOICE_PATH, { action: 'engine.save', create: true, engine: { name: '旧连接', kind: 'openai', config: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'tts' } } })
    await call(STATE_PATH, { action: 'settings.save', settings: { ...defaultSettings(), authorized: true } })
    const epoch = (await (await call(STATE_PATH)).json()).controlEpoch
    const response = await call(MAINTENANCE_PATH, { action: 'all' })
    expect(response.status, await response.text()).toBe(200)
    expect(service.content.roles.get(role.id)).toBeUndefined()
    expect(service.content.roles.list().map(role => role.name)).toEqual(['大肥鱼'])
    expect(service.content.bindings.get('old-session')).toBeUndefined()
    expect(service.content.memories.text(role.id)).toBe('')
    expect(service.voice.engines).toEqual([])
    expect(existsSync(uiFile)).toBe(false)
    expect(records.has('dsh-qqbot/tts-e-orphan')).toBe(false)
    expect(records.get('other/key')).toEqual({ kind: 'api-key', key: 'preserve' })
    expect(readFileSync(host, 'utf8')).toBe('原生聊天')
    const state = await (await call(STATE_PATH)).json()
    expect(state.settings.authorized).toBe(false)
    expect(state.controlEpoch).not.toBe(epoch)
    expect(new Maintenance(dshHome(), () => {}).view().dataEpoch).toBe(service.maintenance.view().dataEpoch)
  })

  it('正在生成原生回复时拒绝全部清理，缓存仍可清理', async () => {
    const { root, call } = await fixture()
    root.provide('agents', { list: () => [{ status: 'running', session: {} }] })
    root.provide('agentPresets', { presetForSession: () => 'qqbot' })
    const response = await call(MAINTENANCE_PATH, { action: 'all' })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('请先停止回复')
    expect((await call(MAINTENANCE_PATH, { action: 'cache' })).status).toBe(200)
  })

  it('保存和清理互斥，清理过程中拒绝新的保存与重复清理', async () => {
    const maintenance = new Maintenance(dshHome(), () => {})
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const write = maintenance.route(async () => { await pending; return new Response() })(new Request('http://localhost', { method: 'POST' }))
    await expect(maintenance.clear('all')).rejects.toThrow('正在处理')
    release(); await write
    let finish!: () => void
    maintenance.register({ credentials: () => new Promise<void>(resolve => { finish = resolve }) })
    const clear = maintenance.clear('all')
    const blocked = await maintenance.route(async () => new Response())(new Request('http://localhost', { method: 'POST' }))
    expect(blocked.status).toBe(409)
    await expect(maintenance.clear('cache')).rejects.toThrow('正在处理')
    finish(); await clear
  })

  it('清理完成后仍拒绝旧页面提交的草稿', async () => {
    const maintenance = new Maintenance(dshHome(), () => {})
    const epoch = maintenance.view().dataEpoch
    await maintenance.clear('all')
    const save = vi.fn(async () => new Response())
    const response = await maintenance.route(save)(new Request('http://localhost', { method: 'POST', headers: { 'x-qqbot-data-epoch': epoch } }))
    expect(response.status).toBe(409)
    expect(save).not.toHaveBeenCalled()
  })

  it('凭据清理失败时保留磁盘资料并返回失败', async () => {
    const { service, call } = await fixture()
    const role = service.content.roles.save({ name: '失败时保留', description: '', persona: '正文' }, true)
    const before = (await (await call(STATE_PATH)).json()).actionLibrary
    const imported = { id: 'motion-30', name: '清理失败保留轨迹', description: '保留', playback: 'once',
      points: [{ at: 0, pos: 0 }, { at: 100, pos: 50 }] }
    await call(STATE_PATH, { action: 'library.save', library: { ...before, library: { ...before.library, clips: [...before.library.clips, imported] } } })
    const libraryFile = join(dshHome(), 'toy-buttplug/motion-library.json')
    const libraryBefore = readFileSync(libraryFile, 'utf8')
    service.maintenance.register({ credentials: async () => { throw new Error('测试凭据不可写') } })
    const response = await call(MAINTENANCE_PATH, { action: 'all' })
    expect(response.status).toBe(409)
    expect(service.content.roles.get(role.id)?.name).toBe('失败时保留')
    expect(readFileSync(libraryFile, 'utf8')).toBe(libraryBefore)
    expect((await (await call(STATE_PATH)).json()).actionLibrary.library.clips.at(-1)).toEqual(imported)
    expect(service.maintenance.active).toBe(false)
  })

  it('插件在凭据操作期间停用时不再继续删除磁盘数据', async () => {
    const home = join(dshHome(), 'disposing')
    mkdirSync(join(home, 'qqbot'), { recursive: true })
    const file = join(home, 'qqbot/keep.txt'); writeFileSync(file, '保留')
    const maintenance = new Maintenance(home, () => {})
    let finish!: () => void
    maintenance.register({ credentials: () => new Promise<void>(resolve => { finish = resolve }) })
    const clear = maintenance.clear('all')
    maintenance.dispose(); finish()
    await expect(clear).rejects.toThrow('已停用')
    expect(readFileSync(file, 'utf8')).toBe('保留')
  })

  it('拒绝清理被替换为目录联接的数据根目录', async () => {
    const home = join(dshHome(), 'link-case'), external = join(dshHome(), 'outside')
    mkdirSync(home, { recursive: true }); mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'keep.txt'), '保留')
    symlinkSync(external, join(home, 'qqbot'), 'junction')
    await expect(new Maintenance(home, () => {}).clear('all')).rejects.toThrow('联接')
    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('保留')
  })

  it('清理使旧记忆请求失效，迟到的整理结果不能复活已删除资料', async () => {
    const { service } = await fixture()
    const role = service.content.roles.save({ name: '旧记忆角色', description: '', persona: '正文' }, true)
    service.content.bindings.set('memory-session', role.id)
    let finish!: (value: { text: string }) => void
    let signal: AbortSignal | undefined
    service.memory.register({ id: 'memory-session', latestTurn: () => 20, lastActive: () => 0,
      capture: () => ({} as never), run: (_input, _name, _previous, cleanup) => { signal = cleanup; return new Promise(resolve => { finish = resolve }) } })
    const result = service.memory.consolidate('memory-session', true)
    await Promise.resolve()
    await service.maintenance.clear('all')
    expect(signal?.aborted).toBe(true)
    finish({ text: '## 关系\n不应写回' })
    expect(await result).toEqual({ kind: 'stale' })
    expect(service.content.memories.text(role.id)).toBe('')
    expect(existsSync(join(dshHome(), 'qqbot/memories', `${role.id}.json`))).toBe(false)
  })
})

describe('浏览器清理同步', () => {
  it('缓存清理不删本地偏好，全部清理跨页面删除自有键，保留其他存储', async () => {
    vi.useFakeTimers()
    const data = new Map([['dsh-toy-buttplug:connection', '旧地址'], ['other', '保留']])
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
    let view = { cacheEpoch: 'initial', dataEpoch: '' }
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      if (init.method === 'POST') { const { action } = JSON.parse(init.body as string); view = { cacheEpoch: action, dataEpoch: action === 'all' ? 'reset-one' : '' } }
      return Response.json(view)
    }))
    const first = new MaintenanceClient(), second = new MaintenanceClient()
    const a = vi.fn(), b = vi.fn(); first.register(a); second.register(b)
    const stopA = first.start(), stopB = second.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      await first.clear('cache')
      expect(a).toHaveBeenCalledWith(false)
      expect(data.get('dsh-toy-buttplug:connection')).toBe('旧地址')
      await first.clear('all')
      await vi.advanceTimersByTimeAsync(2100)
      expect(a).toHaveBeenCalledWith(true); expect(b).toHaveBeenCalledWith(true)
      expect(data.has('dsh-toy-buttplug:connection')).toBe(false)
      expect(data.get('other')).toBe('保留')
      expect(first.getDataVersion()).toBe(1); expect(second.getDataVersion()).toBe(1)
    } finally { stopA(); stopB() }
  })
})
