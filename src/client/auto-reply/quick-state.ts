import { writeHeaders } from '../cleanup-epoch.ts'
import { AUTO_REPLY_PATH, DEFAULT_QUICK_REPLY_CLICK_MODE, type QuickReplyView, type QuickReplyClickMode } from '../../auto-reply/types.ts'

export type QuickSettingsRequest = (body: Record<string, unknown>, signal: AbortSignal) => Promise<QuickReplyView>
const requestSettings: QuickSettingsRequest = async (body, signal) => {
  const response = await fetch(AUTO_REPLY_PATH, { method: 'POST', headers: writeHeaders(),
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
  const data = await response.json() as QuickReplyView & { message?: string }
  if (!response.ok || typeof data.enabled !== 'boolean') throw new Error(data.message || '回复建议设置暂不可用。')
  return data
}

/** Shared between the checkbox and reply renderers; it never calls a model. */
export class QuickReplyState {
  private readonly values = new Map<string, boolean>()
  private readonly clickModes = new Map<string, QuickReplyClickMode>()
  private readonly writes = new Set<string>()
  private readonly epochs = new Map<string, number>()
  private readonly reads = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly listeners = new Set<() => void>()
  private version = 0
  constructor(private readonly request: QuickSettingsRequest = requestSettings) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  get(session: string): boolean { return this.values.get(session) === true }
  clickMode(session: string): QuickReplyClickMode { return this.clickModes.get(session) ?? DEFAULT_QUICK_REPLY_CLICK_MODE }
  private adopt(session: string, view: QuickReplyView): void {
    this.values.set(session, view.enabled)
    this.clickModes.set(session, view.clickMode === 'draft' ? 'draft' : DEFAULT_QUICK_REPLY_CLICK_MODE)
  }
  busy(session: string): boolean { return this.writes.has(session) }
  private changed(): void { this.version++; for (const listener of this.listeners) listener() }
  async refresh(session: string): Promise<void> {
    if (this.lifetime.signal.aborted || this.writes.has(session)) return
    if (this.reads.has(session)) return this.reads.get(session)!
    const epoch = this.epochs.get(session)
    const current = () => !this.lifetime.signal.aborted && this.epochs.get(session) === epoch
    const pending = this.request({ action: 'quick.get', session }, this.lifetime.signal).then(view => {
      if (current()) { this.adopt(session, view); this.changed() }
    }, (error: unknown) => {
      if (current()) { this.values.delete(session); this.changed() }
      throw error
    }).finally(() => { this.reads.delete(session) })
    this.reads.set(session, pending)
    return pending
  }
  async set(session: string, enabled: boolean): Promise<void> {
    return this.write(session, { action: 'quick.set', enabled })
  }
  async setClickMode(session: string, clickMode: QuickReplyClickMode): Promise<void> {
    return this.write(session, { action: 'quick.mode.set', clickMode })
  }
  private async write(session: string, body: Record<string, unknown>): Promise<void> {
    if (this.lifetime.signal.aborted || this.writes.has(session)) return
    this.epochs.set(session, (this.epochs.get(session) ?? 0) + 1)
    const epoch = this.epochs.get(session)
    this.writes.add(session); this.changed()
    try {
      const view = await this.request({ ...body, session }, this.lifetime.signal)
      if (!this.lifetime.signal.aborted && this.epochs.get(session) === epoch) this.adopt(session, view)
    } finally { this.writes.delete(session); this.changed() }
  }
  clearCache(): void {
    for (const id of new Set([...this.values.keys(), ...this.reads.keys(), ...this.writes.keys()])) this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    this.values.clear(); this.clickModes.clear(); this.changed()
  }
  dispose(): void { this.lifetime.abort(); this.values.clear(); this.clickModes.clear(); this.listeners.clear() }
}
