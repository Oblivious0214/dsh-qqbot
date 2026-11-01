import { prepareTailscale, type TailscaleEntry } from './tailscale.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import type { PhoneAction, PhoneNetwork, PhoneView } from '../phone-types.ts'
import { isRecord, readJson, writeJson } from '../storage.ts'
import { createGateway, isPrivateAddress, validCode, type GatewayOptions, type PhoneGateway } from './gateway.ts'

export const networks = (): PhoneNetwork[] => Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
  (addresses ?? []).filter(a => a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address)).map(a => ({ name, address: a.address })))
interface Settings { mode: 'local' | 'tailscale'; enabled: boolean; address: string; port: number; accessCode: string }
const defaults = (): Settings => ({ mode: 'local', enabled: false, address: '', port: 3088, accessCode: randomBytes(18).toString('base64url') })
const validPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
export interface ControllerOptions {
  file: string; upstream(): string; authenticate(): Promise<string>; warn(message: string): void
  tailscale?: (port: number) => Promise<TailscaleEntry>
  networks?: () => PhoneNetwork[]
  create?: (options: GatewayOptions) => Promise<PhoneGateway>
}
export class PhoneController {
  private settings: Settings = defaults()
  private gateway: PhoneGateway | undefined
  private remote: TailscaleEntry | undefined
  private revision = randomUUID()
  private error = ''
  private closed = false
  private resetting = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: ControllerOptions) {
    const exists = existsSync(options.file)
    const saved = readJson(options.file, options.warn)
    if (isRecord(saved) && typeof saved['enabled'] === 'boolean' && typeof saved['address'] === 'string'
      && (saved['mode'] === undefined || saved['mode'] === 'local' || saved['mode'] === 'tailscale')
      && (saved['address'] === '' || isPrivateAddress(saved['address'])) && validPort(saved['port']) && validCode(saved['accessCode'])) {
      this.settings = { mode: saved['mode'] === 'tailscale' ? 'tailscale' : 'local', enabled: saved['enabled'], address: saved['address'], port: saved['port'], accessCode: saved['accessCode'] }
    } else if (exists) {
      // 坏配置不覆盖、不启动；用户保存新设置后才替换。
      this.error = '手机连接设置无法读取，请重新保存。'
    }
  }
  private available(): PhoneNetwork[] { return (this.options.networks ?? networks)() }
  private address(): string {
    const all = this.available()
    if (this.settings.address) return all.some(n => n.address === this.settings.address) ? this.settings.address : ''
    return all.length === 1 ? all[0]!.address : ''
  }
  snapshot(): PhoneView {
    const address = this.address()
    return { ...this.settings, address: this.settings.address || address, networks: this.available(), running: this.gateway !== undefined,
      url: this.gateway?.url ?? (this.settings.mode === 'tailscale' ? '' : address ? `http://${address}:${this.settings.port}/` : ''), revision: this.revision, error: this.error }
  }
  async initialize(): Promise<void> {
    if (this.settings.enabled) await this.serial(async () => { try { await this.start() } catch { /* 页面展示错误，可修复或关闭。 */ } })
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(() => { if (this.closed || this.resetting) throw new Error('手机连接暂时不可用。'); return work() })
    this.queue = task.catch(() => {})
    return task
  }
  private save(settings: Settings): void { writeJson(this.options.file, settings); this.settings = settings; this.revision = randomUUID() }
  private async start(): Promise<void> {
    if (this.gateway) return
    let candidate: PhoneGateway | undefined
    let remote: TailscaleEntry | undefined
    try {
      if (this.settings.mode === 'tailscale') remote = await (this.options.tailscale ?? prepareTailscale)(this.settings.port)
      const host = remote ? '127.0.0.1' : this.address()
      if (!host) throw new Error(this.available().length ? '请选择当前使用的局域网。' : '未找到局域网，请先连接 Wi-Fi 或有线网络。')
      candidate = await (this.options.create ?? createGateway)({ host, port: this.settings.port, accessCode: this.settings.accessCode,
        ...remote ? { externalOrigin: remote.origin } : {}, upstream: this.options.upstream(), authenticate: this.options.authenticate })
      await remote?.start()
      this.save({ ...this.settings, enabled: true, address: remote ? this.settings.address : host }); this.gateway = candidate; this.remote = remote; this.error = ''
    } catch (error) {
      await candidate?.close()
      try { await remote?.close() } catch { this.options.warn('Tailscale 入口未能撤销；手机网关已关闭。') }
      const code = (error as NodeJS.ErrnoException).code
      this.error = code === 'EADDRINUSE' ? '端口已被占用，请换一个端口。' : code === 'EACCES' ? '系统未允许监听这个地址或端口。' : error instanceof Error ? error.message : '手机连接启动失败。'
      this.revision = randomUUID(); throw new Error(this.error)
    }
  }
  action(body: PhoneAction): Promise<PhoneView> {
    return this.serial(async () => {
      if (body.revision !== this.revision) throw new Error('设置已在另一页面更新，请重试。')
      if (body.action === 'start') await this.start()
      else if (body.action === 'stop') {
        // 先落盘关闭偏好；即使写入失败，也立即关闭现有手机连接。
        try { this.save({ ...this.settings, enabled: false }) }
        finally { await this.close() }
        this.error = ''
      } else {
        if (this.gateway) throw new Error('请先关闭手机连接再修改设置。')
        if (body.mode !== undefined && body.mode !== 'local' && body.mode !== 'tailscale') throw new Error('连接方式无效。')
        if (!validPort(body.port)) throw new Error('端口需在 1024–65535 之间。')
        if (!validCode(body.accessCode)) throw new Error('访问码需为 8–128 位字母、数字或符号，不含空格。')
        if (body.mode !== 'tailscale' && body.address !== '' && !this.available().some(n => n.address === body.address)) throw new Error('所选网络已不可用，请重新选择。')
        this.save({ mode: body.mode ?? 'local', enabled: false, port: body.port, accessCode: body.accessCode, address: body.mode === 'tailscale' ? '' : body.address }); this.error = ''
      }
      return this.snapshot()
    })
  }
  private async close(): Promise<void> {
    const gateway = this.gateway, remote = this.remote; this.gateway = undefined; this.remote = undefined
    try { await gateway?.close() } finally {
      try { await remote?.close() } catch { this.options.warn('Tailscale 入口未能撤销；手机网关已关闭。') }
    }
  }
  /** 全部清理撤销登录并回到默认关闭，不导入旧插件资料。 */
  prepareReset(): void { this.resetting = true }
  async reset(): Promise<void> { await this.queue; await this.close() }
  reload(): void { this.settings = defaults(); this.error = ''; this.revision = randomUUID(); this.resetting = false }
  async dispose(): Promise<void> { this.closed = true; await this.queue; await this.close() }
}
