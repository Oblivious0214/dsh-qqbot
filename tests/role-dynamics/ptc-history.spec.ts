import { describe, expect, it } from 'vitest'
import { fixture, openTurn, operation, result, end } from './fixtures.ts'
import { RoleDynamicsService } from '../../src/role-dynamics/service.ts'
async function setup() {
  const f = fixture(), handle = await openTurn(f)
  const root = f.history.event('s', 'tool/call', { turn: 1, step: 1, callId: 'program', name: 'run_code', arguments: '{"code":"synthetic"}' })
  const call = f.history.event('s', 'tool/ptc-dispatch-start', { rootCallId: 'program', parentCallId: 'program', subCallId: 'program:ptc:1', name: 'qqbot_update_state', arguments: { changes: [{ name: '好感', value: 31 }] } })
  await f.service.propose(handle, operation(handle.snapshot, handle.source), { seq: call, callId: 'program:ptc:1' })
  const dispatch = (overrides = {}) => f.history.event('s', 'tool/ptc-dispatch', { rootCallId: 'program', parentCallId: 'program', subCallId: 'program:ptc:1', name: 'qqbot_update_state', arguments: {}, isError: false, ...overrides })
  return { ...f, handle, root, call, dispatch }
}
describe('rc.5 PTC event evidence retains the core native success rules', () => {
  it('pending completed program candidates recover once, including old-cut fork after a single-write reset', async () => {
    const f = await setup(); f.dispatch(); result(f, f.root, 'program'); end(f)
    const count = f.history.capture('s').seq, saves = f.store.saves
    await f.service.resetRole('r'); expect(f.store.saves - saves).toBe(1)
    f.history.fork('s', 'child', count); f.selected.set('child', 'r')
    const next = new RoleDynamicsService(f.options)
    expect((await next.readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(31)
    expect((await next.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it.each(['missing-root-result', 'root-error', 'duplicate-root-result', 'missing-child-result', 'child-error', 'duplicate-child-result', 'wrong-child-root', 'wrong-child-parent'])(
    '%s cannot qualify a program candidate', async kind => {
      const f = await setup()
      if (kind !== 'missing-child-result') f.dispatch(kind === 'child-error' ? { isError: true } : kind === 'wrong-child-root' ? { rootCallId: 'other' } : kind === 'wrong-child-parent' ? { parentCallId: 'other' } : {})
      if (kind === 'duplicate-child-result') f.dispatch()
      if (kind !== 'missing-root-result') result(f, f.root, 'program', kind === 'root-error')
      if (kind === 'duplicate-root-result') result(f, f.root, 'program')
      end(f)
      expect((await f.service.settleTurn(f.handle)).snapshot.values['好感']).toBe(20)
    },
  )
  it.each(['arguments', 'time'])('replacing subcall %s after proposal excludes the candidate across fork/restart', async field => {
    const f = await setup()
    const event = f.history.cuts.get('s')!.events[f.call]!
    if (field === 'time') event.time = 999
    else event.data.arguments = { changes: [{ name: '好感', value: 90 }] }
    f.dispatch(); result(f, f.root, 'program'); end(f)
    f.history.fork('s', 'child'); f.selected.set('child', 'r')
    expect((await new RoleDynamicsService(f.options).readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(20)
  })
})
