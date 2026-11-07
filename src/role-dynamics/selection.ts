/** Role choices share the same real-event before boundary as owner state edits. */
import { existsSync, readFileSync } from 'node:fs'
import { anchor, digest, matches, prefixes, type Anchor, type HistoryCut } from './history.ts'
import { writeJson } from '../storage.ts'
interface Choice { anchor: Anchor; role: string | null; order: number }
interface Choices { version: 1; sessions: Record<string, Choice[]>; nextOrder: number }
export class DynamicsSelections {
  constructor(private readonly file: string) {}
  private load(): Choices {
    if (!existsSync(this.file)) return { version: 1, sessions: {}, nextOrder: 0 }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw.version !== 1 || raw.checksum !== digest(raw.choices) || raw.choices.version !== 1
        || !raw.choices.sessions || !Number.isSafeInteger(raw.choices.nextOrder)) throw Error('shape')
      return raw.choices as Choices
    } catch { throw new Error('角色选择历史损坏，原件已保留') }
  }
  private save(choices: Choices): void { writeJson(this.file, { version: 1, checksum: digest(choices), choices }) }
  has(sessionId: string): boolean { return Object.hasOwn(this.load().sessions, sessionId) }
  /** Copy all necessary prefixes to the child so later forks need no parent. */
  inherit(cut: HistoryCut, parent: HistoryCut): string | null | undefined {
    const choices = this.load()
    if (Object.hasOwn(choices.sessions, cut.header.id)) return this.current(cut)
    const records = choices.sessions[parent.header.id]
    if (!records) return undefined
    if (!cut.header.isSeeded || cut.header.parentSession !== parent.header.id || cut.inheritedEventCount > parent.seq
      || prefixes(cut)[cut.inheritedEventCount] !== prefixes(parent)[cut.inheritedEventCount]) throw new Error('角色选择分叉前缀不匹配')
    const inherited: HistoryCut = { ...cut, seq: cut.inheritedEventCount, events: cut.events.slice(0, cut.inheritedEventCount) }
    const kept = records.filter(record => matches(record.anchor, inherited, false))
    if (!kept.length) throw new Error('这个历史截点缺少角色选择基线')
    choices.sessions[cut.header.id] = structuredClone(kept)
    this.save(choices)
    return kept.at(-1)!.role
  }
  current(cut: HistoryCut): string | null | undefined {
    const records = this.load().sessions[cut.header.id]
    return records?.filter(record => matches(record.anchor, cut, true)).at(-1)?.role
  }
  /** All historically selected roles still verifiable in this branch's cut. */
  roles(cut: HistoryCut): string[] {
    return [...new Set((this.load().sessions[cut.header.id] ?? [])
      .filter(record => record.role !== null && matches(record.anchor, cut, true)).map(record => record.role!))]
  }
  record(cut: HistoryCut, role: string | null, start = false): void {
    const choices = this.load(); const records = choices.sessions[cut.header.id] ?? []
    const before = digest(choices)
    const chain = prefixes(cut)
    // Seal before anchors exactly once. A replaced next event never rebinds.
    for (const record of records) if (!record.anchor.nextPrefix && record.anchor.seq < cut.seq
      && chain[record.anchor.seq] === record.anchor.prefix) record.anchor.nextPrefix = chain[record.anchor.seq + 1]!
    const last = records.filter(record => matches(record.anchor, cut, true)).at(-1)
    if (last?.role !== role || !last) {
      const position = start && cut.events.at(-1)?.type === 'turn/start' ? cut.seq - 1 : cut.seq
      records.push({ anchor: anchor(cut, 'before', position), role, order: choices.nextOrder++ })
    }
    choices.sessions[cut.header.id] = records
    if (digest(choices) !== before) this.save(choices)
  }
  seal(cut: HistoryCut): void {
    if (!this.has(cut.header.id)) return
    const role = this.current(cut)
    if (role !== undefined) this.record(cut, role)
  }
}
