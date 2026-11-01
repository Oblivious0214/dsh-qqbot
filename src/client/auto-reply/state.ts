import { writeHeaders } from '../cleanup-epoch.ts'
import { AUTO_REPLY_PATH, type AutoReplyOptions, type AutoReplyView } from '../../auto-reply/types.ts'

export interface ClientGate { active: boolean; blocked: boolean; activity: number }
export type RequestAutoReply = (body: Record<string, unknown>) => Promise<AutoReplyView>
export async function requestAutoReply(body: Record<string, unknown>): Promise<AutoReplyView> {
  const response = await fetch(AUTO_REPLY_PATH, { method: 'POST', headers: writeHeaders(),
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000) })
  const data = await response.json() as AutoReplyView
  if (!response.ok) throw new Error(data.message || '自动接话连接失败。')
  return data
}

/** Per-mounted-conversation lease. Lost requests never retry a wakeup automatically. */
export class AutoReplyClient {
  private view: AutoReplyView = { enabled: false, count: 0, remainingSeconds: null, status: 'off', message: '' }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private disposed = false
  private owner = ''
  starting = false
  private version = 0
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  get snapshot(): AutoReplyView { return this.view }
  constructor(private readonly session: string, private readonly gate: () => ClientGate,
    private readonly request: RequestAutoReply = requestAutoReply, private readonly mint = () => crypto.randomUUID()) {}

  private changed(): void { this.version++; for (const listener of this.listeners) listener() }
  async start(options: AutoReplyOptions): Promise<void> {
    if (this.disposed || this.starting || this.view.enabled) return
    if (!this.gate().active) return
    const generation = ++this.generation
    const owner = this.owner = this.mint()
    this.starting = true
    this.changed()
    try {
      const view = await this.request({ action: 'enable', session: this.session, owner, options })
      if (this.disposed || generation !== this.generation) { this.release(owner); return }
      this.view = view
      this.schedule(generation)
    } catch (error) {
      if (generation === this.generation) this.fail(error)
      this.release(owner) // acceptance could have succeeded before a transport failure
    } finally {
      if (generation === this.generation) { this.starting = false; this.changed() }
    }
  }
  private schedule(generation: number): void {
    this.timer = setTimeout(() => { this.timer = undefined; void this.pulse(generation) }, 1000)
  }
  private async pulse(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || !this.view.enabled) return
    const gate = this.gate()
    if (!gate.active) { this.stop('已离开当前对话，自动接话已关闭。'); return }
    try {
      const view = await this.request({ action: 'pulse', session: this.session, owner: this.owner,
        blocked: gate.blocked, activity: gate.activity })
      if (this.disposed || generation !== this.generation) return
      this.view = view
      this.changed()
      if (view.enabled) this.schedule(generation)
      else this.release(this.owner)
    } catch (error) {
      if (generation === this.generation) { this.fail(error); this.release(this.owner) }
    }
  }
  private fail(error: unknown): void {
    this.view = { ...this.view, enabled: false, remainingSeconds: null, status: 'stopped',
      message: error instanceof Error ? error.message : '连接中断，请重新开启。' }
    this.changed()
  }
  private release(owner: string): void {
    if (owner) void this.request({ action: 'disable', session: this.session, owner }).catch(() => {})
  }
  stop(message = ''): void {
    ++this.generation
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.starting = false
    this.view = { ...this.view, enabled: false, status: 'off', remainingSeconds: null, message }
    this.release(this.owner)
    this.changed()
  }
  dispose(): void { this.disposed = true; this.stop(); this.listeners.clear() }
}
