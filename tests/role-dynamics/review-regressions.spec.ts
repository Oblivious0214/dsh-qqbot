import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { digest } from '../../src/role-dynamics/history.ts'
import { RoleDynamicsService, type Snapshot } from '../../src/role-dynamics/service.ts'
import { FileJournalStore } from '../../src/role-dynamics/store.ts'
import { initialValues, validateConfig } from '../../src/role-dynamics/validate.ts'
import type { Condition, RoleDynamicsConfig } from '../../src/role-dynamics/types.ts'
import { candidate, end, example, fixture, openTurn, operation, result } from './fixtures.ts'

describe('RD-03-01 complete candidate call evidence', () => {
  it.each(['arguments', 'time', 'metadata', 'name'])('replaced call %s is excluded after restart, rewind and fork', async property => {
    const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn, 31); result(f, seq)
    const call = f.history.cuts.get('s')!.events[seq]!
    if (property === 'arguments') call.data.arguments = '{"changes":[{"name":"好感","value":90}]}'
    else if (property === 'name') call.data.name = 'another_tool'
    else call[property] = property === 'time' ? 999 : { changed: true }
    end(f)
    const restarted = new RoleDynamicsService(f.options)
    const recovered = (await restarted.readSnapshot(f.target))!
    expect(recovered.values['好感']).toBe(20); expect(recovered.generation).not.toBe(turn.snapshot.generation)
    f.history.fork('s', 'child'); f.selected.set('child', 'r')
    expect((await restarted.readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(20)
  })
  it('same operation cannot be acknowledged again after its real event changed', async () => {
    const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn)
    f.history.cuts.get('s')!.events[seq]!.time = 999
    await expect(f.service.propose(turn, operation(turn.snapshot, turn.source, 'call'), { seq, callId: 'call' })).rejects.toThrow(/不同内容/)
  })
  it('a changed call is excluded in direct pending fork derivation', async () => {
    const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn); result(f, seq)
    f.history.cuts.get('s')!.events[seq]!.data.arguments = 'replacement'; end(f)
    f.history.fork('s', 'child'); f.selected.set('child', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(20)
  })
  it('completed unpersisted settlement still recovers into fork, grandchild and restart once', async () => {
    const f = fixture(); const turn = await openTurn(f); const seq = await candidate(f, turn); result(f, seq); end(f)
    f.history.fork('s', 'child'); f.selected.set('child', 'r')
    const restarted = new RoleDynamicsService(f.options)
    expect((await restarted.readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(31)
    f.history.fork('child', 'grandchild'); f.selected.set('grandchild', 'r')
    expect((await restarted.readSnapshot({ sessionId: 'grandchild', roleId: 'r' }))!.values['好感']).toBe(31)
    const parent = (await restarted.readSnapshot(f.target))!
    expect(parent.revision).toBe(1); expect((await restarted.readSnapshot(f.target))!.revision).toBe(1)
  })
  it('the same callId in distinct turns does not collide, but operation identity cannot be reused', async () => {
    const f = fixture(); const first = await openTurn(f); const seq = await candidate(f, first, 31, 'same', 'first'); result(f, seq, 'same'); end(f)
    expect((await f.service.settleTurn(first)).snapshot.values['好感']).toBe(31)
    const second = await openTurn(f, 2)
    await expect(candidate(f, second, 31, 'same', 'first')).rejects.toThrow(/不同调用/)
    const next = await candidate(f, second, 40, 'same', 'second'); result(f, next, 'same'); end(f, 'completed', true, 2)
    expect((await f.service.settleTurn(second)).snapshot.values['好感']).toBe(40)
  })
})

describe('RD-03-02 seal history before generation transition', () => {
  it.each([false, true])('reset without intervening read keeps old cut only when B is unchanged (%s)', async replace => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'A' })
    const before = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(before, f.owner, 'manual', [{ name: '好感', value: 80 }]))
    f.history.event('s', 'user/message', { text: 'B' }); await f.service.resetRole('r')
    if (replace) f.history.cuts.get('s')!.events[1]!.data.text = 'B-prime'
    f.history.fork('s', 'child', 2); f.selected.set('child', 'r')
    const child = (await f.service.readSnapshot({ sessionId: 'child', roleId: 'r' }))!
    expect(child.values['好感']).toBe(replace ? 20 : 80)
    f.history.fork('child', 'grandchild', 2); f.selected.set('grandchild', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'grandchild', roleId: 'r' }))!.values['好感']).toBe(replace ? 20 : 80)
    f.history.event('s', 'user/message', { text: 'after reset' })
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it('reset while tail is still pending never inserts it into the old cut', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'A' })
    const before = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(before, f.owner, 'manual', [{ name: '好感', value: 80 }]))
    await f.service.resetRole('r')
    f.history.fork('s', 'old', 1); f.selected.set('old', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'old', roleId: 'r' }))!.values['好感']).toBe(20)
    f.history.event('s', 'user/message', { text: 'B' }); await f.service.readSnapshot(f.target)
    f.history.cuts.get('s')!.events[1]!.data.text = 'B-prime'
    f.history.fork('s', 'new', 2); f.selected.set('new', 'r')
    expect((await f.service.readSnapshot({ sessionId: 'new', roleId: 'r' }))!.values['好感']).toBe(20)
  })
  it('an older generation is sealed when the next event first appears after reset', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'A' })
    const before = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(before, f.owner, 'manual', [{ name: '好感', value: 80 }]))
    await f.service.resetRole('r'); f.history.event('s', 'user/message', { text: 'B' })
    await f.service.readSnapshot(f.target)
    const journal = f.store.data.get('r') as any
    expect(journal.progress[0].records.at(-1).anchor.nextPrefix).toBeTruthy()
    const sealed = journal.progress[0].records.at(-1).anchor.nextPrefix
    f.history.cuts.get('s')!.events[1]!.data.text = 'B-prime'
    await f.service.readSnapshot(f.target)
    expect((f.store.data.get('r') as any).progress[0].records.at(-1).anchor.nextPrefix).toBe(sealed)
  })
})

function privateDefinition() { const config = example(); config.entries = []; return config }
function privateOperation(snapshot: Snapshot, id = 'private', changes = [{ name: '好感', value: 31 }]) {
  const { source: _source, ...op } = operation(snapshot, { token: '', name: '' }, id, changes)
  return { ...op, configRevision: digest(validateConfig(privateDefinition())) }
}

describe('RD-03-03 private target, CAS, identity and normalized receipts', () => {
  it.each(['session', 'role', 'reset', 'rewind'])('rejects equal-revision wrong progress after %s', async kind => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'A' })
    const source = f.service.registerSource('a', 'A').handle; const snapshot = (await f.service.readSnapshot(f.target))!
    let target = f.target
    if (kind === 'session') { f.history.make('other'); f.selected.set('other', 'r'); target = { roleId: 'r', sessionId: 'other' } }
    if (kind === 'role') { f.configs.set('other', example()); f.selected.set('s', 'other'); target = { roleId: 'other', sessionId: 's' } }
    if (kind === 'reset') await f.service.resetRole('r')
    if (kind === 'rewind') {
      f.history.event('s', 'user/message', { text: 'B' }); await f.service.readSnapshot(f.target)
      f.history.cuts.get('s')!.events[1]!.data.text = 'B-prime'
    }
    const current = (await f.service.readSnapshot(target))!; expect(current.revision).toBe(0)
    await expect(f.service.commitExtension(source, target, privateDefinition(), privateOperation(snapshot))).rejects.toThrow(/代次/)
    expect(await f.service.readExtension(source, target)).toBeUndefined()
  })
  it('normalizes payload, persists no-change receipt, re-registers and restarts without replay', async () => {
    const f = fixture(); const source = f.service.registerSource('a', 'A'); const snapshot = (await f.service.readSnapshot(f.target))!
    const op = privateOperation(snapshot, 'same', [{ name: ' 好感 ', value: 20 }])
    expect((await f.service.commitExtension(source.handle, f.target, privateDefinition(), op)).revision).toBe(0)
    const normalized = { ...op, changes: [{ name: '好感', value: 20 }] }
    expect((await f.service.commitExtension(source.handle, f.target, privateDefinition(), normalized)).revision).toBe(0)
    await f.service.commitExtension(source.handle, f.target, privateDefinition(), privateOperation(snapshot, 'next'))
    source.dispose(); const registered = f.service.registerSource('a', 'A-again')
    expect((await f.service.commitExtension(registered.handle, f.target, privateDefinition(), normalized)).revision).toBe(0)
    await expect(f.service.commitExtension(source.handle, f.target, privateDefinition(), normalized)).rejects.toThrow(/来源/)
    const restarted = new RoleDynamicsService(f.options); const handle = restarted.registerSource('a', 'Restored').handle
    expect((await restarted.commitExtension(handle, f.target, privateDefinition(), normalized)).revision).toBe(0)
    await expect(restarted.commitExtension(handle, f.target, privateDefinition(), { ...normalized, changes: [{ name: '好感', value: 21 }] })).rejects.toThrow(/标识冲突/)
    await expect(restarted.commitExtension(handle, f.target, privateDefinition(), privateOperation(snapshot, 'stale-cas'))).rejects.toThrow(/扩展状态已变化/)
    expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(20)
    expect((await restarted.readExtension(handle, f.target))!.values['好感']).toBe(31)
    expect(await restarted.readExtension(restarted.registerSource('b', 'B').handle, f.target)).toBeUndefined()
  })
  it.each(['', 'x'.repeat(257), 123])('invalid operation id %s does not write a partition', async id => {
    const f = fixture(); const source = f.service.registerSource('a', 'A').handle; const snapshot = (await f.service.readSnapshot(f.target))!
    await expect(f.service.commitExtension(source, f.target, privateDefinition(), { ...privateOperation(snapshot), operationId: id as string })).rejects.toThrow(/操作标识/)
    expect(await f.service.readExtension(source, f.target)).toBeUndefined()
  })
  it('revocation across admission await rejects private reads and writes', async () => {
    const f = fixture(); const source = f.service.registerSource('a', 'A'); const snapshot = (await f.service.readSnapshot(f.target))!
    f.store.fault = () => { f.store.fault = undefined; queueMicrotask(source.dispose) }
    await expect(f.service.commitExtension(source.handle, f.target, privateDefinition(), privateOperation(snapshot))).rejects.toThrow(/来源/)
    const second = f.service.registerSource('a', 'A2')
    f.store.fault = () => { f.store.fault = undefined; queueMicrotask(second.dispose) }
    await expect(f.service.readExtension(second.handle, f.target)).rejects.toThrow(/来源/)
  })
  it('private permissions and values stay in their source partition', async () => {
    const f = fixture(); const source = f.service.registerSource('a', 'A').handle; const snapshot = (await f.service.readSnapshot(f.target))!
    const definition: RoleDynamicsConfig = { version: 1, enabled: true, entries: [], fields: [
      { name: '私有秘密', type: 'text', initial: 'original', visible: false, aiWritable: false },
    ] }
    const op = { ...privateOperation(snapshot), configRevision: digest(validateConfig(definition)), changes: [{ name: '私有秘密', value: 'new-value' }] }
    expect((await f.service.commitExtension(source, f.target, definition, op)).values).toEqual({ 私有秘密: 'new-value' })
    expect(JSON.stringify(await f.service.projectModel(f.target))).not.toContain('私有秘密')
    expect((await f.service.readSnapshot(f.target))!.values).not.toHaveProperty('私有秘密')
    expect(await f.service.readExtension(f.service.registerSource('b', 'B').handle, f.target)).toBeUndefined()
  })
  it('rejects stale epochs and invalid CAS numbers before adding an extension receipt', async () => {
    const f = fixture(); const source = f.service.registerSource('a', 'A').handle; const snapshot = (await f.service.readSnapshot(f.target))!
    const op = privateOperation(snapshot)
    await expect(f.service.commitExtension(source, f.target, privateDefinition(), { ...op, dataEpoch: 'old' })).rejects.toThrow(/资料代次/)
    for (const baseRevision of [-1, 0.5, NaN]) {
      await expect(f.service.commitExtension(source, f.target, privateDefinition(), { ...op, baseRevision })).rejects.toThrow(/状态版本/)
    }
    expect(await f.service.readExtension(source, f.target)).toBeUndefined()
  })
})

describe('RD-03-04 explicit reset isolates incompatible history only', () => {
  it('allows repeated new-generation edits but keeps old history intact and unavailable', async () => {
    const f = fixture(); f.history.event('s', 'user/message', { text: 'A' })
    const original = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(original, f.owner, 'old-high', [{ name: '好感', value: 80 }]))
    f.history.event('s', 'user/message', { text: 'B' })
    const next = example(); (next.fields[0] as any).max = 10; next.fields[0]!.initial = 5
    await f.service.resetRole('r', next); f.configs.set('r', next)
    const restarted = new RoleDynamicsService(f.options)
    for (const text of ['edit-one', 'edit-two']) {
      const edit = structuredClone(f.configs.get('r')!); edit.entries[0]!.text = text
      expect(restarted.planConfiguration('r', edit).compatible).toBe(true)
      await restarted.approveEvolution('r', edit); f.configs.set('r', edit)
      expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(5)
    }
    f.history.event('s', 'user/message', { text: 'after reset' })
    f.history.fork('s', 'child'); f.selected.set('child', 'r')
    expect((await restarted.readSnapshot({ sessionId: 'child', roleId: 'r' }))!.values['好感']).toBe(5)
    expect(restarted.planConfiguration('r', f.configs.get('r')!).compatible).toBe(true)
    f.history.fork('child', 'old', 2); f.selected.set('old', 'r')
    await expect(restarted.readSnapshot({ sessionId: 'old', roleId: 'r' })).rejects.toThrow(/历史配置/)
    expect((f.store.data.get('r') as any).progress[0].records.some((record: any) => record.snapshot.values['好感'] === 80)).toBe(true)
    const state = (await restarted.readSnapshot(f.target))!
    await restarted.commit(f.target, operation(state, restarted.createOwnerSource(), 'new-high', [{ name: '好感', value: 9 }]))
    f.history.event('s', 'user/message', { text: 'mark high' })
    await restarted.commit(f.target, operation((await restarted.readSnapshot(f.target))!, restarted.createOwnerSource(), 'new-low', [{ name: '好感', value: 5 }]))
    const narrow = structuredClone(f.configs.get('r')!); (narrow.fields[0] as any).max = 6
    expect(restarted.planConfiguration('r', narrow).compatible).toBe(false)
  })
  it('same-config reset retains recoverable old highs as evolution constraints', async () => {
    const f = fixture(); const snapshot = (await f.service.readSnapshot(f.target))!
    await f.service.commit(f.target, operation(snapshot, f.owner, 'high', [{ name: '好感', value: 80 }]))
    f.history.event('s', 'user/message', { text: 'marker' }); await f.service.resetRole('r')
    const narrow = example(); (narrow.fields[0] as any).max = 50
    expect(f.service.planConfiguration('r', narrow).compatible).toBe(false)
  })
  it('planning cannot pass a pending reset whose role definition has not aligned', async () => {
    const f = fixture(); await f.service.readSnapshot(f.target)
    const next = example(); (next.fields[0] as any).max = 10; next.fields[0]!.initial = 5
    await f.service.resetRole('r', next)
    expect(() => f.service.planConfiguration('r', next)).toThrow(/尚未对齐/)
    await expect(f.service.approveEvolution('r', next)).rejects.toThrow(/尚未对齐/)
    f.configs.set('r', next)
    await f.service.approveEvolution('r', next)
    expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(5)
  })
})

function renamed(config: RoleDynamicsConfig, from: string, to: string) {
  const next = structuredClone(config); next.fields.find(field => field.name === from)!.name = to
  function visit(when: Condition) {
    if ('all' in when) when.all.forEach(visit)
    else if ('any' in when) when.any.forEach(visit)
    else if (when.field === from) when.field = to
  }
  next.entries.forEach(entry => visit(entry.when)); return next
}
describe('RD-03-05 renamed source identity is consumed', () => {
  it.each(['number', 'boolean', 'text'])('new %s field reusing old name gets its own initial', async type => {
    const f = fixture(); await f.service.readSnapshot(f.target)
    const next = renamed(example(), '好感', '亲密')
    next.fields.push(type === 'number' ? { name: '好感', type, initial: 7, min: 0, max: 10, visible: false, aiWritable: false }
      : type === 'boolean' ? { name: '好感', type, initial: true, visible: false, aiWritable: false }
        : { name: '好感', type: 'text', initial: '新初值', visible: false, aiWritable: false })
    await f.service.approveEvolution('r', next, { 好感: '亲密' }); f.configs.set('r', next)
    const state = (await f.service.readSnapshot(f.target))!
    expect(state.values['亲密']).toBe(20); expect(state.values['好感']).toBe(next.fields.at(-1)!.initial)
    const again = renamed(next, '亲密', '信任')
    await f.service.approveEvolution('r', again, { 亲密: '信任' }); f.configs.set('r', again)
    const expected = initialValues(next); delete expected['亲密']; expected['信任'] = 20
    expect((await f.service.readSnapshot(f.target))!.values).toEqual(expected)
  })
})

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory)
    expect(dirname(absolute)).toBe(resolve(tmpdir())); expect(basename(absolute).startsWith('qqbot-dynamics-fix-')).toBe(true)
    rmSync(absolute, { recursive: true, force: true })
  }
})
describe('RD-03-06 recoverable detach gate with real storage', () => {
  it.each(['before', 'after'])('move %s acknowledgement failure preserves authority and retry', async stage => {
    const directory = mkdtempSync(join(tmpdir(), 'qqbot-dynamics-fix-')); directories.push(directory)
    const f = fixture(); const store = new FileJournalStore(directory); const service = new RoleDynamicsService({ ...f.options, store })
    const owner = service.createOwnerSource(); const initial = (await service.readSnapshot(f.target))!
    const state = (await service.commit(f.target, operation(initial, owner))).snapshot
    const detach = store.detach.bind(store)
    store.detach = (...args) => { if (stage === 'after') detach(...args); throw Error(`${stage} move fault`) }
    await expect(service.detachRole('r', 'same-stamp')).rejects.toThrow(/fault/)
    if (stage === 'before') expect((await service.readSnapshot(f.target))!.values['好感']).toBe(31)
    else { await expect(service.readSnapshot(f.target)).rejects.toThrow(/回收/); expect(store.load('r')).toBeUndefined() }
    store.detach = detach
    // Retry with the same stamp works whether the move happened or not.
    await service.detachRole('r', 'same-stamp')
    await expect(service.readSnapshot(f.target)).rejects.toThrow(/回收/)
    expect(store.load('r')).toBeUndefined(); expect(existsSync(directory)).toBe(true)
    await service.restoreRole('r', 'same-stamp')
    expect(await service.readSnapshot(f.target)).toEqual(state)
  })
  it('detach during host flush blocks in-flight settlement and moves last durable state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qqbot-dynamics-fix-')); directories.push(directory)
    const f = fixture(); const store = new FileJournalStore(directory); const service = new RoleDynamicsService({ ...f.options, store })
    const turnStart = f.history.event('s', 'turn/start', { turn: 1 }); const turn = (await service.beginTurn(f.target, turnStart))!
    const seq = f.history.event('s', 'tool/call', { turn: 1, callId: 'call', name: 'qqbot_update_state', arguments: '{}' })
    await service.propose(turn, operation(turn.snapshot, turn.source), { seq, callId: 'call' }); result(f, seq); end(f)
    let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    f.history.flushFault = () => { entered(); return new Promise<void>(resolve => { release = resolve }) }
    const pending = service.readSnapshot(f.target); const rejection = expect(pending).rejects.toThrow(/回收/)
    await waiting
    const detached = service.detachRole('r', 'flush'); release(); await rejection; await detached
    expect(store.load('r')).toBeUndefined()
    await service.restoreRole('r', 'flush'); f.history.flushFault = undefined
    expect((await service.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
})

describe('RD-03-07 ordinary JSON descriptor consistency', () => {
  it.each(['root', 'field', 'condition', 'array-extra', 'array-index'])('rejects non-enumerable own data at %s', where => {
    const config = example()
    const target = where === 'root' ? config : where === 'field' ? config.fields[0]! : where === 'condition' ? config.entries[0]!.when : config.fields
    Object.defineProperty(target, where === 'array-index' ? '0' : 'unknown', { value: where === 'array-index' ? config.fields[0] : true, enumerable: false })
    expect(() => validateConfig(config)).toThrow(/非枚举/)
  })
  it('accepts frozen ordinary JSON including built-in array length', () => {
    const config = example(); Object.freeze(config.fields); Object.freeze(config)
    expect(validateConfig(config)).toEqual(validateConfig(JSON.parse(JSON.stringify(config))))
  })
})
