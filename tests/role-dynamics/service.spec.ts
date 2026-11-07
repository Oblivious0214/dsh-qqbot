import { describe, expect, it } from 'vitest'
import { digest } from '../../src/role-dynamics/history.ts'
import { RoleDynamicsService } from '../../src/role-dynamics/service.ts'
import { initialValues } from '../../src/role-dynamics/validate.ts'
import { candidate, end, example, fixture, openTurn, operation, result } from './fixtures.ts'

describe('atomic transactions, sources and lifecycle', () => {
  it('static roles create no files, projection, turn or host flush', async () => {
    const f = fixture(); f.configs.set('r', undefined)
    expect(await f.service.readSnapshot(f.target)).toBeUndefined()
    expect(await f.service.projectModel(f.target)).toBeUndefined()
    expect(await f.service.beginTurn(f.target, 0)).toBeUndefined()
    expect(f.store.saves).toBe(0)
  })
  it('one invalid batch item changes nothing; successful write notifies immutable snapshot', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!; const notices: unknown[] = []
    f.service.subscribe(f.target, value => { notices.push(value); expect(Object.isFrozen(value.values)).toBe(true) })
    await expect(f.service.commit(f.target, operation(snapshot, f.owner, 'bad', [{ name: '好感', value: 31 }, { name: '心情', value: '错误' }]))).rejects.toThrow()
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(20); expect(notices).toHaveLength(0)
    const next = await f.service.commit(f.target, operation(snapshot, f.owner))
    expect(next.snapshot.revision).toBe(1); expect(notices).toHaveLength(1)
    expect(() => { next.snapshot.values['好感'] = 70 }).toThrow()
  })
  it('idempotent receipts survive service restart and cache cleanup; mismatch conflicts', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!
    const op = operation(snapshot, f.owner); const first = await f.service.commit(f.target, op)
    f.service.clearCaches(); expect(await f.service.commit(f.target, op)).toEqual(first)
    await expect(f.service.commit(f.target, { ...op, changes: [{ name: '好感', value: 32 }] })).rejects.toThrow(/不同内容/)
    const restarted = new RoleDynamicsService(f.options); const owner = restarted.createOwnerSource()
    expect(await restarted.commit(f.target, { ...op, source: owner })).toEqual(first)
  })
  it('no-change has a durable receipt and does not notify or increase revision', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!; let notices = 0
    f.service.subscribe(f.target, () => notices++)
    const op = operation(snapshot, f.owner, 'same', [{ name: '好感', value: 20 }])
    expect((await f.service.commit(f.target, op)).status).toBe('no-change')
    await f.service.commit(f.target, operation(snapshot, f.owner, 'next'))
    expect((await f.service.commit(f.target, op)).snapshot.revision).toBe(0); expect(notices).toBe(1)
  })
  it('concurrent CAS commits exactly once; duplicate normalized names reject', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!
    const responses = await Promise.allSettled([f.service.commit(f.target, operation(snapshot, f.owner, 'a')), f.service.commit(f.target, operation(snapshot, f.owner, 'b'))])
    expect(responses.map(value => value.status).sort()).toEqual(['fulfilled', 'rejected'])
    const current = (await f.service.readSnapshot(f.target))!
    await expect(f.service.commit(f.target, operation(current, f.owner, 'duplicate', [{ name: '好感', value: 40 }, { name: ' 好感 ', value: 50 }]))).rejects.toThrow(/重复/)
  })
  it('plugin public permissions, hidden grant, forged/revoked handles and namespaces', async () => {
    const f = fixture(); const a = f.service.registerSource('plugin-a', 'A'); const b = f.service.registerSource('plugin-b', 'B')
    const snapshot = (await f.service.readSnapshot(f.target))!
    await expect(f.service.commit(f.target, operation(snapshot, a.handle, 'no', [{ name: '称呼', value: 'x' }]))).rejects.toThrow(/未开放/)
    await f.service.commit(f.target, operation(snapshot, a.handle, 'yes', [{ name: '隐藏开关', value: true }]))
    const current = (await f.service.readSnapshot(f.target))!
    await expect(f.service.commit(f.target, operation(current, { token: 'forged', name: '用户' }))).rejects.toThrow(/来源/)
    const definition = example(); definition.entries = []
    await f.service.commitExtension(a.handle, f.target, definition, { ...operation(current, a.handle), configRevision: digest(definition), baseRevision: 0 })
    expect((await f.service.readExtension(a.handle, f.target))!.values['好感']).toBe(31)
    expect(await f.service.readExtension(b.handle, f.target)).toBeUndefined()
    expect((await f.service.projectModel(f.target))!.fields[0]!.value).toBe(20)
    a.dispose(); await expect(f.service.readExtension(a.handle, f.target)).rejects.toThrow(/来源/)
  })
  it('old epoch, disposed queue and equal revision in another generation reject', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.resetRole('r')
    await expect(f.service.commit(f.target, operation(snapshot, f.owner))).rejects.toThrow(/代次/)
    const current = (await f.service.readSnapshot(f.target))!
    f.service.invalidate('e2'); await expect(f.service.commit(f.target, operation(current, f.owner))).rejects.toThrow(/代次/)
    const pending = f.service.readSnapshot(f.target); f.service.dispose(); await expect(pending).rejects.toThrow(/失效/)
  })
  it('roles and sessions have separate progress and plugin sources cannot impersonate owners', async () => {
    const f = fixture(); const first = (await f.service.readSnapshot(f.target))!
    f.history.make('other'); f.selected.set('other', 'r')
    const other = { sessionId: 'other', roleId: 'r' }; const snapshot = (await f.service.readSnapshot(other))!
    expect(snapshot.progressId).not.toBe(first.progressId)
    await expect(f.service.commit(other, operation(first, f.owner))).rejects.toThrow(/代次/)
    await f.service.commit(other, operation(snapshot, f.owner)); expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(20)
    f.configs.set('r2', example()); f.selected.set('s', 'r2')
    const second = (await f.service.readSnapshot({ sessionId: 's', roleId: 'r2' }))!
    expect(second.values['好感']).toBe(20)
    await expect(f.service.commit(f.target, operation(first, f.owner))).rejects.toThrow(/选择/)
  })
})

describe('frozen turns and final success', () => {
  it('same turn steps/retry share frozen identity and projection; same target twice does not increment twice', async () => {
    const f = fixture(); const handle = await openTurn(f)
    const first = await candidate(f, handle, 31); result(f, first)
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(20)
    const again = (await f.service.beginTurn(f.target, 0))!
    expect(again).toEqual(handle)
    const second = await candidate(f, handle, 31, 'call2'); result(f, second, 'call2')
    expect(again.projection.texts).toEqual(['初识正文'])
    end(f); const settled = await f.service.settleTurn(handle)
    expect(settled.status).toBe('committed'); expect(settled.snapshot.values['好感']).toBe(31); expect(settled.snapshot.revision).toBe(1)
    expect(await f.service.settleTurn(handle)).toEqual(settled)
    expect((await f.service.projectModel(f.target))!.texts).toEqual(['熟悉正文'])
    expect(handle.projection.texts).toEqual(['初识正文'])
  })
  it('successful calls merge in event order; failed calls do not override', async () => {
    const f = fixture(); const handle = await openTurn(f)
    const first = await candidate(f, handle, 40, 'one'); result(f, first, 'one')
    const second = await candidate(f, handle, 60, 'two'); result(f, second, 'two')
    const third = await candidate(f, handle, 90, 'three'); result(f, third, 'three', true)
    end(f); expect((await f.service.settleTurn(handle)).snapshot.values['好感']).toBe(60)
  })
  it.each(['error', 'aborted', 'blocked', 'max-tokens', 'forked', 'interrupted'])('%s ending discards', async kind => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq); end(f, kind)
    const settled = await f.service.settleTurn(handle)
    expect(settled.status).toBe('discarded'); expect(settled.snapshot.values['好感']).toBe(20)
    expect((await f.service.readSnapshot(f.target))!.revision).toBe(0)
  })
  it.each(['no-end', 'no-message', 'interrupted-message', 'failed-tool', 'missing-result', 'wrong-source', 'duplicate-result', 'tool-error-metadata'])('%s cannot commit', async mode => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle)
    if (!['missing-result', 'wrong-source'].includes(mode)) result(f, seq, 'call', mode === 'failed-tool')
    if (mode === 'wrong-source') result(f, seq + 99)
    if (mode === 'duplicate-result') result(f, seq)
    if (mode === 'tool-error-metadata') f.history.cuts.get('s')!.events.at(-1)!.data.error = { message: 'post policy failed' }
    if (mode === 'interrupted-message') f.history.event('s', 'assistant/message', { turn: 1, interrupted: true })
    if (mode !== 'no-end') end(f, 'completed', !['no-message', 'interrupted-message'].includes(mode))
    const settled = await f.service.settleTurn(handle)
    expect(settled.status).toBe(mode === 'no-end' ? 'pending' : 'discarded')
    expect(settled.snapshot.values['好感']).toBe(20)
  })
  it('manual edit keeps frozen view but invalidates entire AI batch at final CAS', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    await f.service.commit(f.target, operation(handle.snapshot, f.owner, 'manual', [{ name: '好感', value: 80 }]))
    expect((await f.service.beginTurn(f.target, 0))!.projection).toEqual(handle.projection)
    end(f); const settled = await f.service.settleTurn(handle)
    expect(settled.status).toBe('conflict'); expect(settled.snapshot.values['好感']).toBe(80)
  })
  it('manual before-phase at the exact end cursor defeats AI after-phase at that event', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    f.history.event('s', 'assistant/message', { turn: 1, message: { content: [] } })
    await f.service.commit(f.target, operation(handle.snapshot, f.owner, 'last-moment', [{ name: '好感', value: 80 }]))
    end(f, 'completed', false)
    expect((await f.service.settleTurn(handle)).status).toBe('conflict')
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(80)
  })
  it('AI cannot inspect hidden/nonexistent fields through validation errors', async () => {
    const f = fixture(); const handle = await openTurn(f)
    const seq = f.history.event('s', 'tool/call', { turn: 1, callId: 'c', name: 'qqbot_update_state' })
    const messages: string[] = []
    for (const name of ['隐藏开关', '不存在', '称呼']) {
      try { await f.service.propose(handle, operation(handle.snapshot, handle.source, name, [{ name, value: true }]), { seq, callId: 'c' }) } catch (error) { messages.push((error as Error).message) }
    }
    expect(new Set(messages).size).toBe(1); expect(messages[0]).toContain('本轮没有这个可更新字段')
    await expect(f.service.propose(handle, operation(handle.snapshot, handle.source, 'range', [{ name: '好感', value: 200 }]), { seq, callId: 'c' })).rejects.toThrow(/范围/)
  })
  it('candidate idempotency and failed persistence never change committed state', async () => {
    const f = fixture(); const handle = await openTurn(f)
    const seq = await candidate(f, handle)
    const op = operation(handle.snapshot, handle.source, 'call')
    expect(await f.service.propose(handle, op, { seq, callId: 'call' })).toEqual({ accepted: true })
    await expect(f.service.propose(handle, { ...op, changes: [{ name: '好感', value: 40 }] }, { seq, callId: 'call' })).rejects.toThrow(/不同内容/)
    f.store.fault = () => { throw new Error('disk') }
    result(f, seq); end(f)
    expect((await f.service.settleTurn(handle)).status).toBe('pending')
    f.store.fault = undefined
    const restarted = new RoleDynamicsService(f.options)
    const recovered = (await restarted.readSnapshot(f.target))!
    expect(recovered.values['好感']).toBe(31); expect(recovered.revision).toBe(1)
    expect((await restarted.readSnapshot(f.target))!.revision).toBe(1)
  })
  it('flush failure blocks subsequent reads and preserves retryable candidates', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq); end(f)
    f.history.flushFault = async () => { throw new Error('host flush') }
    expect((await f.service.settleTurn(handle)).status).toBe('pending')
    await expect(f.service.readSnapshot(f.target)).rejects.toThrow(/host flush/)
    f.history.flushFault = undefined
    expect((await f.service.settleTurn(handle)).snapshot.values['好感']).toBe(31)
  })
  it('invalidate/dispose during slow flush prevents any late persistence', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq); end(f)
    let release!: () => void; let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    f.history.flushFault = () => { entered(); return new Promise<void>(resolve => { release = resolve }) }
    const pending = f.service.settleTurn(handle); await ready
    f.service.invalidate('e2'); const saves = f.store.saves; f.store.data.clear(); release()
    await expect(pending).rejects.toThrow(/失效/)
    expect(f.store.saves).toBe(saves); expect(f.store.data.size).toBe(0)
  })
  it('role switch invalidation cannot resurrect if switched back before end', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    f.service.invalidateTarget('r', 's'); end(f)
    const snapshot = (await f.service.readSnapshot(f.target))!
    expect(snapshot.values['好感']).toBe(20)
    await expect(f.service.settleTurn(handle)).rejects.toThrow(/失效/)
  })
  it('end arriving across the admission await settles before a manual CAS', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    f.store.fault = () => { f.store.fault = undefined; queueMicrotask(() => { end(f) }) }
    await expect(f.service.commit(f.target, operation(handle.snapshot, f.owner, 'racing', [{ name: '好感', value: 80 }]))).rejects.toThrow(/状态已变化/)
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(31)
  })
  it('dispose revokes persisted pending candidates, including success appended after disposal', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    f.service.dispose(); end(f)
    const restarted = new RoleDynamicsService(f.options)
    expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it('invalidation revokes source and turn handles even if the caller reused the epoch string', async () => {
    const f = fixture(); const plugin = f.service.registerSource('p', '插件'); const handle = await openTurn(f)
    const seq = await candidate(f, handle); result(f, seq)
    f.service.invalidate('e1'); end(f)
    const snapshot = (await f.service.readSnapshot(f.target))!
    expect(snapshot.values['好感']).toBe(20)
    await expect(f.service.commit(f.target, operation(snapshot, plugin.handle))).rejects.toThrow(/来源/)
    await expect(f.service.settleTurn(handle)).rejects.toThrow(/失效/)
    expect((await f.service.commit(f.target, operation(snapshot, f.service.createOwnerSource()))).status).toBe('committed')
  })
})

describe('branch replay and event evidence', () => {
  it('manual tail survives reopen, old-cut fork excludes it, next-event fork includes it in order', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'first' })
    let snapshot = (await f.service.readSnapshot(f.target))!
    snapshot = (await f.service.commit(f.target, operation(snapshot, f.owner, 'a', [{ name: '好感', value: 40 }]))).snapshot
    await f.service.commit(f.target, operation(snapshot, f.owner, 'b', [{ name: '好感', value: 80 }]))
    const restarted = new RoleDynamicsService(f.options)
    expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(80)
    f.history.fork('s', 'old', 1); f.selected.set('old', 'r')
    expect((await restarted.readSnapshot({ sessionId: 'old', roleId: 'r' }))!.values['好感']).toBe(20)
    f.history.event('s', 'user/message', { text: 'next' })
    f.history.fork('s', 'new', 2); f.selected.set('new', 'r')
    const child = (await restarted.readSnapshot({ sessionId: 'new', roleId: 'r' }))!
    expect(child.values['好感']).toBe(80)
    await restarted.commit({ sessionId: 'new', roleId: 'r' }, operation(child, restarted.createOwnerSource(), 'child', [{ name: '好感', value: 90 }]))
    expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(80)
  })
  it('completed cutoff reconstructs pending candidates; open cutoff never inherits them', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    f.history.fork('s', 'open'); f.selected.set('open', 'r')
    f.history.event('open', 'turn/end', { turn: 1, reason: { kind: 'forked' } })
    expect((await f.service.readSnapshot({ sessionId: 'open', roleId: 'r' }))!.values['好感']).toBe(20)
    end(f); f.history.fork('s', 'done'); f.selected.set('done', 'r')
    const child = (await f.service.readSnapshot({ sessionId: 'done', roleId: 'r' }))!
    expect(child.values['好感']).toBe(31)
    f.history.fork('done', 'grandchild'); f.selected.set('grandchild', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'grandchild', roleId: 'r' }))!.values['好感']).toBe(31)
    expect((await f.service.settleTurn(handle)).snapshot.revision).toBe(1)
  })
  it('fork old stage does not use parent future; same turn number has distinct identity', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq); const endSeq = end(f)
    await f.service.settleTurn(handle)
    const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(snapshot, f.owner, 'future', [{ name: '好感', value: 90 }]))
    f.history.event('s', 'user/message', { text: 'future marker' })
    f.history.fork('s', 'past', endSeq + 1); f.selected.set('past', 'r')
    const past = (await f.service.readSnapshot({ sessionId: 'past', roleId: 'r' }))!
    expect(past.values['好感']).toBe(31); expect(past.progressId).not.toBe(snapshot.progressId)
    f.history.make('same-turn'); f.selected.set('same-turn', 'r'); f.history.event('same-turn', 'turn/start', { turn: 1 })
    const other = (await f.service.beginTurn({ sessionId: 'same-turn', roleId: 'r' }, 0))!
    expect(other.snapshot.values['好感']).toBe(20); expect(other.token).not.toBe(handle.token)
  })
  it('compaction is a new event, not rollback; real shortened history creates new generation', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'a' })
    let snapshot = (await f.service.readSnapshot(f.target))!
    snapshot = (await f.service.commit(f.target, operation(snapshot, f.owner))).snapshot
    f.history.event('s', 'compaction', { surface: [] })
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(31)
    const cut = f.history.cuts.get('s')!; cut.events = cut.events.slice(0, 1); cut.seq = 1
    const rewind = (await f.service.readSnapshot(f.target))!
    expect(rewind.values['好感']).toBe(20); expect(rewind.generation).not.toBe(snapshot.generation)
    await expect(f.service.commit(f.target, operation(snapshot, f.owner))).rejects.toThrow(/代次/)
  })
  it('changed event at equal seq rejects completely unrelated history', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'a' }); await f.service.readSnapshot(f.target)
    f.history.cuts.get('s')!.events[0]!.data.text = 'different'
    await expect(f.service.readSnapshot(f.target)).rejects.toThrow(/共同前缀/)
  })
  it('before anchors bind the next real event hash and reject its later replacement', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'unchanged first' })
    const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(snapshot, f.owner))
    f.history.event('s', 'user/message', { text: 'bound second' }); await f.service.readSnapshot(f.target)
    f.history.cuts.get('s')!.events[1]!.data.text = 'replaced'
    const restored = (await f.service.readSnapshot(f.target))!
    expect(restored.values['好感']).toBe(20); expect(restored.generation).not.toBe(snapshot.generation)
  })
  it('parent identity alone does not inherit; seeded mismatch/cycle/missing parent rejects', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(snapshot, f.owner, 'parent', [{ name: '好感', value: 80 }]))
    const agent = f.history.make('subagent'); agent.header.parentSession = 's'; f.selected.set('subagent', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'subagent', roleId: 'r' }))!.values['好感']).toBe(20)
    f.history.event('s', 'user/message', { text: 'marker' }); f.history.fork('s', 'bad'); f.history.cuts.get('bad')!.events[0]!.data.text = 'changed'
    await expect(f.service.readSnapshot({ sessionId: 'bad', roleId: 'r' })).rejects.toThrow(/前缀/)
    const cycle = f.history.make('cycle'); cycle.header.isSeeded = true; cycle.header.parentSession = 'cycle'
    await expect(f.service.readSnapshot({ sessionId: 'cycle', roleId: 'r' })).rejects.toThrow(/循环/)
    const missing = f.history.make('missing'); missing.header.isSeeded = true; missing.header.parentSession = 'none'
    await expect(f.service.readSnapshot({ sessionId: 'missing', roleId: 'r' })).rejects.toThrow(/missing history/)
  })
  it('truncated durable host tail cannot restore a successful live-only result', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    const beforeEnd = f.history.capture('s').seq; end(f); f.history.durableLimit = beforeEnd
    const restarted = new RoleDynamicsService(f.options)
    expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it('corrupt journal never resets to initial state', async () => {
    const f = fixture(); await f.service.readSnapshot(f.target)
    const corrupt: any = f.store.data.get('r'); corrupt.progress[0].records[0].snapshot.values['好感'] = 'broken'
    const before = structuredClone(corrupt)
    await expect(f.service.readSnapshot(f.target)).rejects.toThrow(/日志损坏/)
    expect(f.store.data.get('r')).toEqual(before)
  })
})

describe('configuration lifecycle', () => {
  it('config changing across the admission await rejects an old form rather than saving old values', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!
    const next = example(); next.fields[0]!.updateRule = '新的规则'
    await f.service.approveEvolution('r', next)
    f.store.fault = () => { f.store.fault = undefined; queueMicrotask(() => { f.configs.set('r', next) }) }
    await expect(f.service.commit(f.target, operation(snapshot, f.owner))).rejects.toThrow(/配置已变化/)
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it('approved compatible edit migrates once, preserves initial values, invalidates frozen candidates', async () => {
    const f = fixture(); const handle = await openTurn(f); const seq = await candidate(f, handle); result(f, seq)
    const next = example(); next.fields[0]!.initial = 99
    next.fields.push({ name: '新增', type: 'boolean', initial: true, visible: false, aiWritable: false })
    await f.service.approveEvolution('r', next); f.configs.set('r', next); end(f)
    const snapshot = (await f.service.readSnapshot(f.target))!
    expect(snapshot.values).toMatchObject({ 好感: 20, 新增: true })
    expect((await f.service.settleTurn(handle)).status).toBe('conflict')
    const turnStart = f.history.event('s', 'turn/start', { turn: 2 }); const nextTurn = (await f.service.beginTurn(f.target, turnStart))!
    const nextCall = await candidate(f, nextTurn, 50, 'next'); result(f, nextCall, 'next'); end(f, 'completed', true, 2)
    expect((await f.service.settleTurn(nextTurn)).snapshot.values['好感']).toBe(50)
  })
  it('all historical snapshots constrain narrowing, explicit rename keeps values, disabled retains progress', async () => {
    const f = fixture(); let snapshot = (await f.service.readSnapshot(f.target))!
    snapshot = (await f.service.commit(f.target, operation(snapshot, f.owner, 'high', [{ name: '好感', value: 80 }]))).snapshot
    f.history.event('s', 'user/message', { text: 'marker' })
    await f.service.commit(f.target, operation(snapshot, f.owner, 'low', [{ name: '好感', value: 20 }]))
    const narrow = example(); (narrow.fields[0] as any).max = 50
    expect(f.service.planConfiguration('r', narrow).compatible).toBe(false)
    await expect(f.service.approveEvolution('r', narrow)).rejects.toThrow(/重置/)
    const rename = example(); rename.fields[2]!.name = '昵称'; await f.service.approveEvolution('r', rename, { 称呼: '昵称' }); f.configs.set('r', rename)
    expect((await f.service.readSnapshot(f.target))!.values['昵称']).toBe('朋友')
    const disabled = structuredClone(rename); disabled.enabled = false
    await f.service.approveEvolution('r', disabled); f.configs.set('r', disabled)
    expect(await f.service.projectModel(f.target)).toEqual({ fields: [], texts: [] })
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(20)
    await f.service.approveEvolution('r', rename); f.configs.set('r', rename)
    expect((await f.service.readSnapshot(f.target))!.values['昵称']).toBe('朋友')
  })
  it('reset establishes new generation and retained old fork snapshot remains recoverable', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'first' })
    const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(snapshot, f.owner, 'high', [{ name: '好感', value: 80 }]))
    f.history.event('s', 'user/message', { text: 'second' }); await f.service.readSnapshot(f.target)
    f.history.event('s', 'user/message', { text: 'third' }); await f.service.resetRole('r')
    expect((await f.service.readSnapshot(f.target))!.values).toEqual(initialValues(example()))
    f.history.fork('s', 'old-before-reset', 2); f.selected.set('old-before-reset', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'old-before-reset', roleId: 'r' }))!.values['好感']).toBe(80)
  })
  it('reset to incompatible config blocks the half transaction until ROLE definition matches', async () => {
    const f = fixture(); await f.service.readSnapshot(f.target)
    const next = example(); next.fields[2] = { name: '称呼', type: 'boolean', initial: true, visible: true, aiWritable: false }
    await f.service.resetRole('r', next)
    await expect(f.service.readSnapshot(f.target)).rejects.toThrow(/尚未对齐/)
    f.configs.set('r', next)
    expect((await f.service.readSnapshot(f.target))!.values['称呼']).toBe(true)
  })
  it('fork-of-fork can cut before an inherited reset and survives missing parent history after copying', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'first' })
    const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(snapshot, f.owner, 'high', [{ name: '好感', value: 80 }]))
    f.history.event('s', 'user/message', { text: 'second' }); await f.service.readSnapshot(f.target)
    await f.service.resetRole('r'); f.history.event('s', 'user/message', { text: 'after reset' })
    f.history.fork('s', 'child'); f.selected.set('child', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(20)
    f.history.cuts.delete('s')
    f.history.fork('child', 'grandchild', 2); f.selected.set('grandchild', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'grandchild', roleId: 'r' }))!.values['好感']).toBe(80)
  })
})
