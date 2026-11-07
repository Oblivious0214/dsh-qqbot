import { createHash } from 'node:crypto'
import { fail } from './types.ts'

/** Complete immutable sessionQuery cut. seq is the next sequence, not the last event. */
export interface HistoryEvent {
  seq: number; type: string; data: Record<string, unknown>
  sourceEventSeqs?: number[]
  [metadata: string]: unknown
}
export interface HistoryCut {
  header: { id: string; isSeeded?: boolean; parentSession?: string }
  inheritedEventCount: number; seq: number; events: HistoryEvent[]
}
export interface HistoryView {
  capture(sessionId: string): HistoryCut
  /** Must flush the host and return a cut read from its durable log. */
  flush(sessionId: string): Promise<HistoryCut>
}
export interface Anchor { sessionId: string; seq: number; phase: 'before' | 'after'; prefix: string; nextPrefix?: string }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export function prefixes(cut: HistoryCut): string[] {
  if (cut.seq !== cut.events.length || !Number.isSafeInteger(cut.inheritedEventCount) || cut.inheritedEventCount < 0 || cut.inheritedEventCount > cut.seq) fail('$.history', '历史截点不完整', 'history')
  const chain = [digest([])]
  cut.events.forEach((event, i) => {
    if (event.seq !== i || !event.type || !event.data) fail('$.history', '事件序列不连续', 'history')
    chain.push(digest([chain[i], event]))
  })
  return chain
}
export function anchor(cut: HistoryCut, phase: Anchor['phase'], seq = cut.seq): Anchor {
  const count = seq + (phase === 'after' ? 1 : 0)
  const prefix = prefixes(cut)[count]
  if (!prefix) return fail('$.history', '锚点超过事件截点', 'history')
  return { sessionId: cut.header.id, seq, phase, prefix }
}
export function matches(position: Anchor, cut: HistoryCut, includeTail: boolean): boolean {
  const count = position.seq + (position.phase === 'after' ? 1 : 0)
  const chain = prefixes(cut)
  return (position.phase === 'after' || position.seq < cut.seq || includeTail)
    && chain[count] === position.prefix
    && (position.phase === 'after' || position.nextPrefix === undefined || chain[position.seq + 1] === position.nextPrefix)
}
export function turnEnd(cut: HistoryCut, startSeq: number): HistoryEvent | undefined {
  const start = cut.events[startSeq]
  if (start?.type !== 'turn/start') return undefined
  for (const event of cut.events.slice(startSeq + 1)) {
    if (event.type === 'turn/start') return undefined
    if (event.type === 'turn/end' && event.data.turn === start.data.turn) return event
  }
  return undefined
}
export function completed(cut: HistoryCut, startSeq: number): HistoryEvent | undefined {
  const end = turnEnd(cut, startSeq)
  if ((end?.data.reason as { kind?: string } | undefined)?.kind !== 'completed') return undefined
  return cut.events.slice(startSeq + 1, end!.seq).some(event => event.type === 'assistant/message' && event.data.turn === cut.events[startSeq]!.data.turn && event.data.interrupted !== true)
    ? end : undefined
}
export function successfulCall(cut: HistoryCut, startSeq: number, callSeq: number, callId: string): boolean {
  const end = completed(cut, startSeq)
  const call = cut.events[callSeq]
  if (!end || !call || call.seq <= startSeq || call.seq >= end.seq || !validStateCall(cut, startSeq, call, callId)) return false
  if (call.type === 'tool/ptc-dispatch-start') {
    const root = ptcRoot(cut, startSeq, call)
    if (!root || !successfulRoot(cut, startSeq, root.seq, String(call.data.rootCallId))) return false
    const boundary = cut.events.slice(callSeq + 1, end.seq).find(event =>
      (event.type === 'tool/ptc-dispatch-start' && event.data.subCallId === callId && event.data.rootCallId === call.data.rootCallId)
      || (event.type === 'tool/call' && event.data.callId === call.data.rootCallId))?.seq ?? end.seq
    const results = cut.events.slice(callSeq + 1, boundary).filter(event => event.type === 'tool/ptc-dispatch'
      && event.data.subCallId === callId && event.data.rootCallId === call.data.rootCallId && event.data.parentCallId === call.data.parentCallId)
    return results.length === 1 && results[0]!.data.name === 'qqbot_update_state' && results[0]!.data.isError === false
      && !Object.hasOwn(results[0]!.data, 'error')
  }
  return successfulRoot(cut, startSeq, callSeq, callId)
}
/** rc.5 Native root and PTC sub-dispatch identities are both real host events. */
export function validStateCall(cut: HistoryCut, startSeq: number, call: HistoryEvent, callId: string): boolean {
  if (call.data.name !== 'qqbot_update_state') return false
  if (call.type === 'tool/call') return call.data.callId === callId && call.data.turn === cut.events[startSeq]?.data.turn
  if (call.type !== 'tool/ptc-dispatch-start' || call.data.subCallId !== callId || typeof call.data.rootCallId !== 'string'
    || typeof call.data.parentCallId !== 'string') return false
  const root = ptcRoot(cut, startSeq, call)
  return root !== undefined && !cut.events.slice(root.seq + 1, call.seq).some(event => event.type === 'tool/result' && event.sourceEventSeqs?.includes(root.seq))
}
function ptcRoot(cut: HistoryCut, startSeq: number, call: HistoryEvent): HistoryEvent | undefined {
  return cut.events.slice(startSeq + 1, call.seq).findLast(event => event.type === 'tool/call'
    && event.data.callId === call.data.rootCallId && event.data.name === 'run_code' && event.data.turn === cut.events[startSeq]?.data.turn)
}
function successfulRoot(cut: HistoryCut, startSeq: number, callSeq: number, callId: string): boolean {
  const end = completed(cut, startSeq)
  if (!end) return false
  const call = cut.events[callSeq]!
  const results = cut.events.slice(callSeq + 1, end.seq).filter(event => event.type === 'tool/result' && event.sourceEventSeqs?.includes(callSeq))
  if (results.length !== 1) return false
  const data = results[0]!.data
  const message = data.message as { toolCallId?: string; isError?: boolean } | undefined
  return data.turn === call.data.turn && message?.toolCallId === callId && message.isError === false && !Object.hasOwn(data, 'error')
}
