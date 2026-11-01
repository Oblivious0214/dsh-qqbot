import { DEFAULT_OPTIONS, type AutoReplyOptions } from '../../auto-reply/types.ts'
import { AutoReplyClient, type ClientGate, type RequestAutoReply } from './state.ts'

export interface AutoReplySession {
  client: AutoReplyClient
  options: AutoReplyOptions
}

/** The composer owns the lease; opening or closing settings never starts or stops it. */
export class AutoReplySessions {
  private readonly entries = new Map<string, AutoReplySession>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  constructor(private readonly request?: RequestAutoReply) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  private changed = () => { this.version++; for (const listener of this.listeners) listener() }
  get(session: string): AutoReplySession | undefined { return this.entries.get(session) }
  mount(session: string, gate: () => ClientGate): () => void {
    const entry = { client: new AutoReplyClient(session, gate, this.request), options: { ...DEFAULT_OPTIONS } }
    const old = this.entries.get(session)
    old?.client.dispose()
    this.entries.set(session, entry)
    const unsubscribe = entry.client.subscribe(this.changed)
    this.changed()
    return () => {
      unsubscribe()
      entry.client.dispose()
      if (this.entries.get(session) === entry) { this.entries.delete(session); this.changed() }
    }
  }
  setOptions(session: string, options: AutoReplyOptions): void {
    const entry = this.entries.get(session)
    if (entry) { entry.options = options; this.changed() }
  }
  stopAll(message = ''): void { for (const entry of this.entries.values()) entry.client.stop(message) }
  dispose(): void { this.stopAll(); this.entries.clear(); this.listeners.clear() }
}
