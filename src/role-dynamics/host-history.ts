/** rc.5 public sessionQuery observations; no writes to the host log. */
import { digest, prefixes, type HistoryCut, type HistoryEvent, type HistoryView } from './history.ts'

export interface HostSession { readonly id: string; readonly seq: number; readonly header: HistoryCut['header'] }
interface Observation {
  readonly header: HistoryCut['header']; readonly inheritedEventCount: number
  readonly events: readonly HistoryEvent[]; readonly cursor: number
  [Symbol.dispose](): void
}
export interface HistoryHost {
  sessionQuery: { observeSession(id: string, options: { projections: 'none' }): Promise<Observation> }
  sessions: { get(id: string): HostSession | undefined; flush(session: HostSession): Promise<boolean> }
}
export class HostHistoryView implements HistoryView {
  private readonly cuts = new Map<string, HistoryCut>()
  private readonly publications = new Map<string, Set<HistoryEvent[]>>()
  private disposed = false
  constructor(private readonly host: () => HistoryHost) {}
  /** The caller subscribes before the first asynchronous observation. */
  observe(session: HostSession, event: HistoryEvent): void {
    if (this.disposed) return
    const cut = this.cuts.get(session.id)
    if (!cut && !this.publications.has(session.id)) return
    if (cut && event.seq === cut.seq) { cut.events.push(structuredClone(event)); cut.seq++ }
    for (const pending of this.publications.get(session.id) ?? []) pending.push(structuredClone(event))
  }
  async prepare(id: string, ancestors = new Set<string>(), inherit = false): Promise<void> {
    if (this.disposed) throw new Error('动态历史读取已停止')
    if (ancestors.has(id)) throw new Error('会话分叉血缘循环')
    const pending: HistoryEvent[] = [], readers = this.publications.get(id) ?? new Set<HistoryEvent[]>()
    readers.add(pending); this.publications.set(id, readers)
    let lease: Observation
    try { lease = await this.host().sessionQuery.observeSession(id, { projections: 'none' }) }
    catch (error) { readers.delete(pending); if (!readers.size) this.publications.delete(id); throw error }
    let cut: HistoryCut
    try {
      cut = { header: structuredClone(lease.header), inheritedEventCount: lease.inheritedEventCount,
        seq: lease.cursor + 1, events: structuredClone([...lease.events]) }
    } finally { lease[Symbol.dispose](); readers.delete(pending); if (!readers.size) this.publications.delete(id) }
    if (this.disposed) throw new Error('动态历史读取已停止')
    prefixes(cut)
    if (cut.header.id !== id) throw new Error('动态历史会话身份不匹配')
    // A lease fixes its cut before an await resumes. Join every publication
    // after that cut, including events received while the read was pending.
    const live = this.host().sessions.get(id)
    for (const event of pending.sort((a, b) => a.seq - b.seq)) {
      if (event.seq < cut.seq || !live || event.seq >= live.seq) continue
      if (event.seq !== cut.seq) throw new Error('动态历史观察缺少事件')
      cut.events.push(structuredClone(event)); cut.seq++
    }
    if (live && live.seq !== cut.seq) throw new Error('动态历史观察尚未追齐')
    prefixes(cut); this.cuts.set(id, cut)
    if (inherit && cut.header.isSeeded && cut.header.parentSession) {
      await this.prepare(cut.header.parentSession, new Set([...ancestors, id]), true)
    }
  }
  capture(id: string): HistoryCut {
    if (this.disposed) throw new Error('动态历史读取已停止')
    const cut = this.cuts.get(id)
    if (!cut) throw new Error('动态历史尚未准备')
    const live = this.host().sessions.get(id)
    if (live && live.seq !== cut.seq) throw new Error('动态历史观察尚未追齐')
    return structuredClone(cut)
  }
  async flush(id: string): Promise<HistoryCut> {
    await this.prepare(id)
    const cut = this.capture(id)
    const live = this.host().sessions.get(id)
    if (live && !await this.host().sessions.flush(live)) throw new Error('会话历史没有持久化屏障')
    if (this.disposed) throw new Error('动态历史读取已停止')
    // Only the prefix captured before the barrier is proven durable. A live
    // read after await can contain newer, still buffered events.
    await this.prepare(id)
    if (prefixes(this.capture(id))[cut.seq] !== digestPrefix(cut)) throw new Error('持久化期间会话历史已变化')
    return cut
  }
  clear(): void { this.cuts.clear(); this.publications.clear() }
  dispose(): void { this.disposed = true; this.clear() }
}
function digestPrefix(cut: HistoryCut): string { return prefixes(cut).at(-1) ?? digest([]) }
