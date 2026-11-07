import { describe, expect, it } from 'vitest'
import { RoleDynamicsService } from '../../src/role-dynamics/service.ts'
import { candidate, end, example, fixture, openTurn, operation, result } from './fixtures.ts'

async function success(value = 31) {
  const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn, value)
  result(f, seq); end(f)
  return { ...f, turn, count: f.history.capture('s').seq }
}
function journal(f: ReturnType<typeof fixture>) { return f.store.load('r') as any }
async function forkValue(f: ReturnType<typeof fixture>, count: number, id = 'child', parent = 's') {
  f.history.fork(parent, id, count); f.selected.set(id, 'r')
  return (await new RoleDynamicsService(f.options).readSnapshot({ sessionId: id, roleId: 'r' }))!
}
function flushGate(f: ReturnType<typeof fixture>) {
  let release!: () => void; let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  f.history.flushFault = () => { entered(); return new Promise<void>(resolve => { release = resolve }) }
  return { waiting, release: () => { f.history.flushFault = undefined; release() } }
}

describe('RD-03-R1 reset preserves completed durable history without a preliminary read', () => {
  it.each([false, true])('restart=%s, strict old cut and multilayer fork retain exactly one settlement', async restart => {
    const f = await success(); await f.history.flush('s')
    const saves = f.store.saves
    const service = restart ? new RoleDynamicsService(f.options) : f.service
    await service.resetRole('r')
    expect(f.store.saves - saves).toBe(1)
    const old = await forkValue(f, f.count)
    expect(old.values['好感']).toBe(31); expect(old.revision).toBe(1)
    expect((await forkValue(f, f.count, 'grandchild', 'child')).values['好感']).toBe(31)
    const current = (await new RoleDynamicsService(f.options).readSnapshot(f.target))!
    expect(current.values['好感']).toBe(20); expect(current.revision).toBe(0)
    f.history.event('s', 'user/message', { text: 'after reset' })
    expect((await forkValue(f, f.count + 1, 'after')).values['好感']).toBe(20)
    expect((await forkValue(f, f.count, 'old-again', 'after')).values['好感']).toBe(31)
    expect(journal(f).progress[0].records.filter((record: any) => record.turnId).length).toBe(1)
    await expect(f.service.settleTurn(f.turn)).rejects.toThrow(/失效|代次/)
    const stale = operation(f.turn.snapshot, f.owner, 'old-cas')
    await expect(f.service.commit(f.target, stale)).rejects.toThrow(/代次/)
  })
  it('unchanged successful candidate retains its historical receipt without increasing revision', async () => {
    const f = await success(20); await f.service.resetRole('r')
    const old = await forkValue(f, f.count)
    expect(old.revision).toBe(0); expect(old.values['好感']).toBe(20)
    expect(journal(f).progress[0].turns[0].result.status).toBe('no-change')
  })
  it('successful calls remain ordered as target values rather than increments', async () => {
    const f = fixture(); const turn = await openTurn(f)
    const first = await candidate(f, turn, 31, 'a'); result(f, first, 'a')
    const second = await candidate(f, turn, 40, 'b'); result(f, second, 'b'); end(f)
    const count = f.history.capture('s').seq; await f.service.resetRole('r')
    const old = await forkValue(f, count)
    expect(old.values['好感']).toBe(40); expect(old.revision).toBe(1)
  })
  it.each(['error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked', 'open', 'no-message', 'tool-error'])('excludes %s candidates in old and current generations', async kind => {
    const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn)
    result(f, seq, 'call', kind === 'tool-error')
    if (kind !== 'open') end(f, ['no-message', 'tool-error'].includes(kind) ? 'completed' : kind, kind !== 'no-message')
    const count = f.history.capture('s').seq; await f.service.resetRole('r')
    expect((await forkValue(f, count)).values['好感']).toBe(20)
    expect((await new RoleDynamicsService(f.options).readSnapshot(f.target))!.values['好感']).toBe(20)
    if (kind === 'open') {
      end(f)
      expect((await forkValue(f, f.history.capture('s').seq, 'late')).values['好感']).toBe(20)
    }
  })
  it('preserves owner CAS over a completed stale AI batch at the same historical position', async () => {
    const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn); result(f, seq)
    await f.service.commit(f.target, operation(turn.snapshot, f.owner, 'owner', [{ name: '好感', value: 80 }]))
    end(f); const count = f.history.capture('s').seq
    await f.service.resetRole('r')
    expect((await forkValue(f, count)).values['好感']).toBe(80)
    expect(journal(f).progress[0].turns[0].result.status).toBe('conflict')
  })
  it('does not revive a candidate already revoked before reset', async () => {
    const f = await success(); f.service.invalidateTarget('r')
    await f.service.resetRole('r')
    expect((await forkValue(f, f.count)).values['好感']).toBe(20)
  })
  it('retains successful evidence under an incompatible configuration reset without casting old values', async () => {
    const f = await success(); const next = example()
    if (next.fields[0]!.type === 'number') { next.fields[0].max = 10; next.fields[0].initial = 5 }
    await f.service.resetRole('r', next); f.configs.set('r', next)
    const saved = journal(f).progress[0]
    expect(saved.turns[0].result.status).toBe('committed')
    expect(saved.records.find((record: any) => record.turnId).snapshot.values['好感']).toBe(31)
    expect(saved.records.find((record: any) => record.turnId).isolatedByReset).toBe(true)
    expect((await new RoleDynamicsService(f.options).readSnapshot(f.target))!.values['好感']).toBe(5)
    await expect(forkValue(f, f.count)).rejects.toThrow(/历史配置/)
    const edit = structuredClone(next); edit.entries[0]!.text = 'new text'
    await f.service.approveEvolution('r', edit); f.configs.set('r', edit)
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(5)
  })
  it.each(['flush', 'save'])('failed %s leaves reset and settlement together retryable after restart', async stage => {
    const f = await success(); const before = journal(f)
    if (stage === 'flush') f.history.flushFault = async () => { throw Error('flush fault') }
    else f.store.fault = () => { throw Error('save fault') }
    await expect(f.service.resetRole('r')).rejects.toThrow(/fault/)
    expect(journal(f)).toEqual(before)
    f.history.flushFault = undefined; f.store.fault = undefined
    await new RoleDynamicsService(f.options).resetRole('r')
    expect((await forkValue(f, f.count)).values['好感']).toBe(31)
    expect(journal(f).progress[0].records.filter((record: any) => record.turnId).length).toBe(1)
  })
  it('a commit acknowledged as failed after atomic save never repeats old settlement on retry', async () => {
    const f = await success(); const save = f.store.save.bind(f.store)
    f.store.save = (...args) => { save(...args); throw Error('ack fault') }
    await expect(f.service.resetRole('r')).rejects.toThrow(/ack fault/)
    f.store.save = save
    await new RoleDynamicsService(f.options).resetRole('r')
    expect((await forkValue(f, f.count)).values['好感']).toBe(31)
    expect(journal(f).progress[0].records.filter((record: any) => record.turnId).length).toBe(1)
  })
  it('refuses a durable cut that does not yet contain the completed boundary, preserving pending evidence', async () => {
    const f = await success(); const before = journal(f); f.history.durableLimit = f.count - 1
    await expect(f.service.resetRole('r')).rejects.toThrow(/尚未持久化/)
    expect(journal(f)).toEqual(before)
    f.history.durableLimit = undefined; await f.service.resetRole('r')
    expect((await forkValue(f, f.count)).values['好感']).toBe(31)
  })
  it.each(['epoch', 'dispose', 'detach', 'target', 'selection', 'config', 'history'])('slow flush rechecks %s invalidation', async kind => {
    const f = await success(); const gate = flushGate(f)
    const reset = f.service.resetRole('r')
    const failure = ['epoch', 'dispose', 'detach', 'config', 'history'].includes(kind)
    const check = failure ? expect(reset).rejects.toThrow(/失效|回收|变化/) : expect(reset).resolves.toBeUndefined()
    await gate.waiting
    let detached: Promise<void> | undefined
    if (kind === 'epoch') f.service.invalidate('e2')
    if (kind === 'dispose') f.service.dispose()
    if (kind === 'detach') detached = f.service.detachRole('r', 'reset-flush')
    if (kind === 'target') f.service.invalidateTarget('r')
    if (kind === 'selection') f.selected.set('s', 'another')
    if (kind === 'config') { const next = example(); next.entries[0]!.text = 'changed'; f.configs.set('r', next) }
    if (kind === 'history') f.history.cuts.get('s')!.events[1]!.time = 999
    gate.release(); await check; await detached
    if (kind === 'detach') expect(f.store.load('r')).toBeUndefined()
    else {
      expect(journal(f).progress[0].records.filter((record: any) => record.turnId).length).toBe(0)
      if (failure) expect(journal(f).progress.length).toBe(1)
    }
  })
  it('captures all sessions before waiting so an open turn completing during another flush stays invalid', async () => {
    const f = await success()
    f.history.make('other'); f.selected.set('other', 'r')
    const target = { sessionId: 'other', roleId: 'r' }
    const start = f.history.event('other', 'turn/start', { turn: 1 })
    const turn = (await f.service.beginTurn(target, start))!
    const seq = f.history.event('other', 'tool/call', { turn: 1, callId: 'other', name: 'qqbot_update_state', arguments: '{}' })
    await f.service.propose(turn, operation(turn.snapshot, turn.source, 'other'), { seq, callId: 'other' })
    f.history.event('other', 'tool/result', { turn: 1, message: { toolCallId: 'other', isError: false } }, { sourceEventSeqs: [seq] })
    const gate = flushGate(f); const reset = f.service.resetRole('r'); await gate.waiting
    f.history.event('other', 'assistant/message', { turn: 1 })
    f.history.event('other', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    gate.release(); await reset
    expect((await forkValue(f, f.count)).values['好感']).toBe(31)
    expect((await forkValue(f, f.history.capture('other').seq, 'other-child', 'other')).values['好感']).toBe(20)
  })
})
