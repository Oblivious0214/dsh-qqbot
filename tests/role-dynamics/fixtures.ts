import type { RoleDynamicsConfig } from '../../src/role-dynamics/types.ts'
import { digest, type HistoryCut, type HistoryEvent, type HistoryView } from '../../src/role-dynamics/history.ts'
import { RoleDynamicsService, type Operation, type Snapshot, type SourceHandle, type Target, type TurnHandle } from '../../src/role-dynamics/service.ts'
import type { JournalStore } from '../../src/role-dynamics/store.ts'

export const example = (): RoleDynamicsConfig => ({ version: 1, enabled: true,
  fields: [
    { name: '好感', type: 'number', initial: 20, min: 0, max: 100, visible: true, aiWritable: true, pluginWritable: true, updateRule: '依据互动设定目标值' },
    { name: '隐藏开关', type: 'boolean', initial: false, visible: false, aiWritable: false, pluginWritable: true },
    { name: '称呼', type: 'text', initial: '朋友', visible: true, aiWritable: false, updateRule: '本地只读规则' },
    { name: '心情', type: 'choice', initial: '平静', options: ['平静', '开心'], visible: true, aiWritable: true, updateRule: '按本轮互动选择' },
  ], entries: [
    { name: '阶段一名称', when: { field: '好感', op: 'lt', value: 30 }, text: '初识正文' },
    { name: '阶段二名称', when: { all: [{ field: '好感', op: 'gte', value: 30 }, { field: '好感', op: 'lt', value: 70 }] }, text: '熟悉正文' },
    { name: '阶段三名称', when: { field: '好感', op: 'gte', value: 70 }, text: '亲近正文' },
    { name: '隐藏阶段名称', when: { field: '隐藏开关', op: 'eq', value: true }, text: '解锁正文' },
  ],
})
export class MemoryStore implements JournalStore {
  data = new Map<string, unknown>(); trash = new Map<string, unknown>(); saves = 0
  fault: (() => void) | undefined
  load(role: string) { return structuredClone(this.data.get(role)) }
  save(role: string, data: unknown, guard: () => void) { guard(); this.fault?.(); guard(); this.data.set(role, structuredClone(data)); this.saves++ }
  detach(role: string, stamp: string, guard: () => void) { guard(); this.trash.set(`${role}:${stamp}`, this.data.get(role)); this.data.delete(role) }
  restore(role: string, stamp: string, guard: () => void) { guard(); this.data.set(role, this.trash.get(`${role}:${stamp}`)); this.trash.delete(`${role}:${stamp}`) }
}
export class Histories implements HistoryView {
  cuts = new Map<string, HistoryCut>(); durableLimit: number | undefined; flushFault: (() => Promise<void>) | undefined
  make(id = 's'): HistoryCut {
    const cut: HistoryCut = { header: { id }, inheritedEventCount: 0, seq: 0, events: [] }
    this.cuts.set(id, cut); return cut
  }
  capture(id: string): HistoryCut {
    const cut = this.cuts.get(id)
    if (!cut) throw new Error('missing history')
    return structuredClone(cut)
  }
  async flush(id: string) {
    await this.flushFault?.()
    const cut = this.capture(id)
    if (this.durableLimit !== undefined) { cut.events = cut.events.slice(0, this.durableLimit); cut.seq = cut.events.length }
    return cut
  }
  event(id: string, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): number {
    const cut = this.cuts.get(id)!; const seq = cut.seq++
    cut.events.push({ seq, type, time: seq * 100, data, ...extra } as HistoryEvent); return seq
  }
  fork(parent: string, id: string, count = this.cuts.get(parent)!.seq) {
    const source = this.capture(parent)
    const cut = { header: { id, isSeeded: true, parentSession: parent }, inheritedEventCount: count, seq: count, events: source.events.slice(0, count) }
    this.cuts.set(id, cut)
    return cut
  }
}
export function fixture(store = new MemoryStore()) {
  const history = new Histories(); history.make()
  const configs = new Map<string, RoleDynamicsConfig | undefined>([['r', example()]])
  const selected = new Map<string, string>([['s', 'r']])
  let ids = 0
  const options = { store, history, config: (role: string) => configs.get(role), isSelected: (target: Target) => selected.get(target.sessionId) === target.roleId,
    epoch: 'e1', id: () => `generated-${++ids}`, clock: () => 1234 }
  const service = new RoleDynamicsService(options); const owner = service.createOwnerSource()
  return { service, store, history, configs, selected, options, owner, target: { sessionId: 's', roleId: 'r' } }
}
export const operation = (snapshot: Snapshot, source: SourceHandle, operationId = 'op', changes: Operation['changes'] = [{ name: '好感', value: 31 }]): Operation => ({
  operationId, source, progressId: snapshot.progressId, generation: snapshot.generation, baseRevision: snapshot.revision, configRevision: snapshot.configRevision, dataEpoch: snapshot.dataEpoch, changes,
})
export async function openTurn(f: ReturnType<typeof fixture>, turn = 1): Promise<TurnHandle> {
  const seq = f.history.event('s', 'turn/start', { turn }); return (await f.service.beginTurn(f.target, seq))!
}
export async function candidate(f: ReturnType<typeof fixture>, handle: TurnHandle, value = 31, callId = 'call', opId = callId) {
  const turn = f.history.cuts.get('s')!.events.findLast(event => event.type === 'turn/start')!.data.turn
  const seq = f.history.event('s', 'tool/call', { turn, callId, name: 'qqbot_update_state', arguments: '{}' })
  await f.service.propose(handle, operation(handle.snapshot, handle.source, opId, [{ name: '好感', value }]), { seq, callId })
  return seq
}
export function result(f: ReturnType<typeof fixture>, seq: number, callId = 'call', isError = false) {
  const turn = f.history.cuts.get('s')!.events[seq]?.data.turn ?? 1
  f.history.event('s', 'tool/result', { turn, message: { id: `result-${seq}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [], isError } }, { sourceEventSeqs: [seq] })
}
export function end(f: ReturnType<typeof fixture>, kind = 'completed', message = true, turn = 1) {
  if (message) f.history.event('s', 'assistant/message', { turn, message: { content: [] } })
  return f.history.event('s', 'turn/end', { turn, reason: { kind } })
}
export const configRevision = (config: RoleDynamicsConfig) => digest(config)
