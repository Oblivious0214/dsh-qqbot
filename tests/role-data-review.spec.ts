import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { importConfiguration, previewConfiguration, recoverConfigurationImports } from '../src/config-import.ts'
import { Maintenance } from '../src/maintenance.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleDynamicsService, type RolePersistencePort } from '../src/role-dynamics/service.ts'
import { FileJournalStore, type StoreStage } from '../src/role-dynamics/store.ts'
import { MemoryStore } from '../src/role-memory.ts'
import { RoleDataTransactions } from '../src/role-transactions.ts'
import { RoleLibrary } from '../src/roles.ts'
import { example, Histories, operation } from './role-dynamics/fixtures.ts'

const dirs: string[] = []
const draft = { name: '原角色', description: '', persona: '正文' }
const settings = { roles: true, presets: true, conflict: 'skip' }
const pkg = (names = ['新角色']) => ({ format: 'dsh-qqbot-config', version: 2, roles: names.map(name => ({ ...draft, name, dynamics: example() })) })
function setup(dynamic = true) {
  const home = mkdtempSync(join(tmpdir(), 'qqbot-data-review-')); dirs.push(home)
  const root = join(home, 'qqbot'); const roles = new RoleLibrary(join(root, 'roles'), () => {})
  const role = roles.save({ ...draft, ...dynamic ? { dynamics: example() } : {} }, true)
  const data = new QqbotData(roles, SessionBindings.at(root, () => {}), JailbreakStore.at(root, () => {}), () => {}, MemoryStore.at(root, () => {}))
  const history = new Histories(); history.make('s')
  let journalFault: StoreStage | undefined; let txFault: string | undefined
  const maintenance = new Maintenance(home, () => {})
  const store = new FileJournalStore(join(root, 'role-dynamics'), stage => { if (stage === journalFault) throw new Error(`journal ${stage}`) })
  const options = { store, history, config: (id: string) => roles.configuration(id), isSelected: () => true, epoch: maintenance.view().dataEpoch }
  const core = new RoleDynamicsService(options)
  new RoleDataTransactions(roles, { dynamics: core, maintenance, fault: stage => { if (stage === txFault) throw new Error(`transaction ${stage}`) } })
  const target = { roleId: role.id, sessionId: 's' }
  const save = (dynamics = example(), extra = {}) => roles.saveAsync({ ...draft, id: role.id, dynamics, dynamicsBaseRevision: roles.get(role.id)!.dynamicsRevision, ...extra }, false)
  return { home, root, roles, role, data, core, options, history, target, store, maintenance, save,
    journalFault: (stage?: StoreStage) => { journalFault = stage }, txFault: (stage?: string) => { txFault = stage } }
}
type Fixture = ReturnType<typeof setup>
async function pending(f: Fixture, sessionId = 's', value = 31, close = true) {
  if (!f.history.cuts.has(sessionId)) f.history.make(sessionId)
  const target = { ...f.target, sessionId }
  const start = f.history.event(sessionId, 'turn/start', { turn: 1 })
  const handle = (await f.core.beginTurn(target, start))!
  const seq = f.history.event(sessionId, 'tool/call', { turn: 1, callId: sessionId, name: 'qqbot_update_state', arguments: '{}' })
  await f.core.propose(handle, operation(handle.snapshot, handle.source, sessionId, [{ name: '好感', value }]), { seq, callId: sessionId })
  f.history.event(sessionId, 'tool/result', { turn: 1, message: { toolCallId: sessionId, isError: false } }, { sourceEventSeqs: [seq] })
  if (close) finish(f, sessionId)
  return handle
}
function finish(f: Fixture, id = 's') {
  f.history.event(id, 'assistant/message', { turn: 1, message: { content: [] } })
  f.history.event(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
}
function gate(f: Fixture) {
  let entered!: () => void; let release!: () => void
  const waiting = new Promise<void>(r => { entered = r })
  f.history.flushFault = () => { entered(); return new Promise<void>(r => { release = r }) }
  return { waiting, release: () => { f.history.flushFault = undefined; release() } }
}
async function oldValue(f: Fixture, parent = 's', field = '好感') {
  const id = `old-${parent}`; f.history.fork(parent, id, 5)
  return (await new RoleDynamicsService(f.options).readSnapshot({ ...f.target, sessionId: id }))!.values[field]
}
function manifest(f: Fixture) {
  const folder = join(f.root, 'import-backups', readdirSync(join(f.root, 'import-backups'))[0]!)
  return { file: join(folder, 'manifest.json'), value: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
}
afterEach(() => {
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('qqbot-data-review-')) throw new Error('临时目录范围无效')
    rmSync(path, { recursive: true, force: true })
  }
})

describe('RD-05-01 durable success survives outer data boundaries', () => {
  it.each(['compatible', 'reset-failure', 'delete-failure', 'delete-restore'])('%s preserves two completed sessions and exact once historical settlement', async mode => {
    const f = setup(); const handle = await pending(f); await pending(f, 'b', 42)
    const card = f.roles.fileFor(f.role.id)!; const original = readFileSync(card)
    if (mode.endsWith('failure')) f.txFault('changed')
    if (mode === 'compatible') { const next = example(); next.entries[0]!.text = '新正文'; await f.save(next) }
    if (mode === 'reset-failure') await expect(f.save({ ...example(), enabled: false }, { resetDynamics: true })).rejects.toThrow('transaction changed')
    if (mode === 'delete-failure') await expect(f.roles.removeAsync(f.role.id)).rejects.toThrow('transaction changed')
    if (mode === 'delete-restore') { const stamp = await f.roles.removeAsync(f.role.id); await f.roles.restore(stamp) }
    expect(await oldValue(f)).toBe(31); expect(await oldValue(f, 'b')).toBe(42)
    const restarted = new RoleDynamicsService(f.options)
    expect((await restarted.readSnapshot(f.target))!.values['好感']).toBe(31)
    if (mode.endsWith('failure')) expect(readFileSync(card)).toEqual(original)
    const journal = f.store.load(f.role.id) as any
    for (const id of ['s', 'b']) expect(journal.progress.filter((p: any) => p.sessionId === id).flatMap((p: any) => p.records).filter((r: any) => r.turnId)).toHaveLength(1)
    await expect(f.core.settleTurn(handle)).rejects.toThrow('失效')
  })
  it.each(['flush', 'temporary', 'rename', 'directory-sync'])('preparation %s failure keeps old success recoverable and retryable', async stage => {
    const f = setup(); await pending(f); await pending(f, 'b', 42)
    if (stage === 'flush') f.history.flushFault = async () => { throw new Error('flush failed') }
    else f.journalFault(stage as StoreStage)
    const card = f.roles.fileFor(f.role.id)!; const before = readFileSync(card)
    await expect(f.save({ ...example(), enabled: false }, { resetDynamics: true })).rejects.toThrow(/flush|journal/)
    expect(readFileSync(card)).toEqual(before)
    f.history.flushFault = undefined; f.journalFault()
    await f.save({ ...example(), enabled: false }, { resetDynamics: true })
    expect(await oldValue(f)).toBe(31); expect(await oldValue(f, 'b')).toBe(42)
    expect((await new RoleDynamicsService(f.options).readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it.each(['save', 'remove', 'history-change'])('open second session completed during %s preparation stays revoked', async mode => {
    const f = setup(); await pending(f); const open = await pending(f, 'b', 42, false)
    const g = gate(f)
    const action = mode === 'remove' ? f.roles.removeAsync(f.role.id) : f.save({ ...example(), enabled: false }, { resetDynamics: true })
    const checked = mode === 'history-change' ? expect(action).rejects.toThrow('历史') : undefined
    await g.waiting; finish(f, 'b')
    if (mode === 'history-change') {
      f.history.flushFault = undefined
      // Replace the captured prefix without admitting the other session's late completion.
      f.history.cuts.get('s')!.events[1]!.data.arguments = 'changed'
    }
    g.release()
    if (checked) await checked
    else { const value = await action; if (mode === 'remove') await f.roles.restore(value as string) }
    expect(await oldValue(f, 'b')).toBe(20)
    await expect(f.core.settleTurn(open)).rejects.toThrow('失效')
  })
  it('persistence port expires before queued operations resume', async () => {
    const f = setup(); let retained!: RolePersistencePort
    await f.core.withRolePersistence(f.role.id, async port => { retained = port; await port.prepare() })
    expect(() => retained.guard()).toThrow('失效')
    expect(() => retained.prepare()).toThrow('失效')
  })
  it('an unawaited scoped preparation cannot write after its owner returns', async () => {
    const f = setup(); await pending(f); const g = gate(f)
    let preparation!: Promise<void>; let failure!: Promise<unknown>
    await f.core.withRolePersistence(f.role.id, async port => {
      preparation = port.prepare(); failure = expect(preparation).rejects.toThrow('失效')
      await g.waiting
    })
    const before = f.store.load(f.role.id)
    g.release(); await failure
    expect(f.store.load(f.role.id)).toEqual(before)
    expect(await oldValue(f)).toBe(31)
  })
  it('second flush failure leaves completed evidence untouched while open candidates stay revoked', async () => {
    const f = setup(); await pending(f); await pending(f, 'b', 42); await pending(f, 'c', 53, false)
    const flush = f.history.flush.bind(f.history)
    f.history.flush = async id => { if (id === 'b') throw new Error('second flush'); return flush(id) }
    await expect(f.save({ ...example(), enabled: false })).rejects.toThrow('second flush')
    f.history.flush = flush; finish(f, 'c')
    const journal = f.store.load(f.role.id) as any
    expect(journal.progress.filter((p: any) => ['s', 'b'].includes(p.sessionId)).every((p: any) => !p.turns[0].revoked && !p.turns[0].result)).toBe(true)
    await f.save({ ...example(), enabled: false })
    expect(await oldValue(f)).toBe(31); expect(await oldValue(f, 'b')).toBe(42); expect(await oldValue(f, 'c')).toBe(20)
  })
  it('an incomplete durable cut rejects a data operation and permits a fresh retry', async () => {
    const f = setup(); await pending(f); f.history.durableLimit = 4
    await expect(f.roles.removeAsync(f.role.id)).rejects.toThrow('尚未持久化')
    expect(f.roles.get(f.role.id)).toBeDefined()
    f.history.durableLimit = undefined
    const stamp = await f.roles.removeAsync(f.role.id); await f.roles.restore(stamp)
    expect(await oldValue(f)).toBe(31)
  })
})

describe('RD-05-02 compatible reset retains history migration', () => {
  for (const mode of ['enabled', 'text', 'rename']) it.each([false, true])(`${mode}, previously settled=%s`, async settled => {
    const f = setup(); const h = await pending(f); if (settled) await f.core.settleTurn(h)
    const next = example(); const extra: Record<string, unknown> = { resetDynamics: true }
    if (mode === 'enabled') next.enabled = false
    if (mode === 'text') next.entries[0]!.text = '修订正文'
    if (mode === 'rename') { next.fields[0]!.name = '亲密'; next.entries = []; extra.dynamicsRenames = { 好感: '亲密' } }
    await f.save(next, extra)
    const field = mode === 'rename' ? '亲密' : '好感'
    expect(await oldValue(f, 's', field)).toBe(31)
    expect((await new RoleDynamicsService(f.options).readSnapshot(f.target))!.values[field]).toBe(20)
  })
  it('successful candidate constrains compatible evolution across all recoverable old snapshots', async () => {
    const f = setup(); await pending(f)
    await f.save({ ...example(), enabled: false }, { resetDynamics: true })
    const next = { ...example(), enabled: false }; Object.assign(next.fields[0]!, { max: 25 })
    await expect(f.save(next)).rejects.toThrow('重置')
    expect(await oldValue(f)).toBe(31)
  })
})

describe('RD-05-03 restore releases only a completed whole unit', () => {
  for (const dynamic of [false, true]) for (const initialized of [false, true]) it.each([false, true])(`dynamic=${dynamic}, initialized=${initialized}, restart=%s`, async restart => {
    const f = setup(dynamic)
    if (initialized) await f.core.readSnapshot(f.target)
    const stamp = await f.roles.removeAsync(f.role.id)
    let roles = f.roles; let core = f.core
    if (restart) {
      roles = new RoleLibrary(f.roles.dir, () => {})
      core = new RoleDynamicsService({ ...f.options, config: id => roles.configuration(id) })
      new RoleDataTransactions(roles, { dynamics: core })
    }
    await roles.restore(stamp)
    if (!dynamic) await roles.saveAsync({ ...draft, id: f.role.id, dynamics: example(), dynamicsBaseRevision: roles.get(f.role.id)!.dynamicsRevision }, false)
    expect((await core.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it.each(['changed', 'commit'])('no-journal restore failure at %s stays blocked until retry', async stage => {
    const f = setup(); const stamp = await f.roles.removeAsync(f.role.id); f.txFault(stage)
    await expect(f.roles.restore(stamp)).rejects.toThrow('transaction')
    expect(f.roles.get(f.role.id)).toBeUndefined()
    await expect(f.core.readSnapshot(f.target)).rejects.toThrow('回收')
    f.txFault(); await f.roles.restore(stamp)
    expect((await f.core.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
  it('restore acknowledgement failure after commit releases a no-journal role', async () => {
    const f = setup(); const stamp = await f.roles.removeAsync(f.role.id); f.txFault('committed')
    await expect(f.roles.restore(stamp)).rejects.toThrow('transaction committed')
    expect((await f.core.readSnapshot(f.target))!.values['好感']).toBe(20)
  })
})

describe('RD-05-04 name ownership at publish', () => {
  it.each(['create', 'rename', 'import'])('slow transaction preserves a name taken by static %s', async mode => {
    const f = setup(); await pending(f)
    const other = mode === 'rename' ? f.roles.save({ ...draft, name: '另一角色' }, true) : undefined
    const g = gate(f); const saving = f.save({ ...example(), enabled: false }, { resetDynamics: true, name: '占名' })
    const rejected = expect(saving).rejects.toThrow('占名')
    await g.waiting
    if (mode === 'create') f.roles.save({ ...draft, name: '占名' }, true)
    if (mode === 'rename') f.roles.save({ ...draft, id: other!.id, name: '占名' }, false)
    if (mode === 'import') importConfiguration(f.data, pkg(['占名']), settings, previewConfiguration(f.data, pkg(['占名']), settings).revision)
    g.release(); await rejected
    expect(f.roles.get(f.role.id)!.name).toBe(draft.name)
    expect(f.roles.list().filter(role => role.name === '占名')).toHaveLength(1)
    expect(await oldValue(f)).toBe(31)
    expect((await f.core.readSnapshot(f.target))!.values['好感']).toBe(31)
  })
})

describe('RD-05-05 preview binds actual complete preset bytes', () => {
  it.each(['head', 'current', 'preset-add', 'preset-delete', 'bytes'])('rejects external %s and accepts a fresh preview preserving it', mode => {
    const f = setup(); const p = f.data.presets.save({ name: '另一预设', head: 'H', mid: '', tail: '' }, true)
    
    const preview = previewConfiguration(f.data, pkg(), settings); const file = join(f.root, 'presets.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (mode === 'head') state.presets[0].head = '外部正文'
    if (mode === 'current') state.current = p.id
    if (mode === 'preset-add') state.presets.push({ id: 'external', name: '外部预设', head: '', mid: '', tail: '' })
    if (mode === 'preset-delete') state.presets = state.presets.filter((v: any) => v.id !== p.id)
    writeFileSync(file, JSON.stringify(state))
    const bytes = readFileSync(file)
    expect(() => importConfiguration(f.data, pkg(), settings, preview.revision)).toThrow('重新预览')
    expect(readFileSync(file)).toEqual(bytes)
    const fresh = previewConfiguration(f.data, pkg(), settings)
    expect(fresh.revision).not.toBe(preview.revision)
    importConfiguration(f.data, pkg(), settings, fresh.revision)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.presets).toEqual(state.presets); expect(saved.current).toBe(state.current)
  })
  it.each(['missing', 'malformed', 'invalid-current', 'unexpected-binding'])('%s never silently becomes writable defaults', mode => {
    const f = setup(); f.data.presets.setCurrent('default')
    const p = previewConfiguration(f.data, pkg(), settings); const file = join(f.root, 'presets.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (mode === 'missing') rmSync(file)
    if (mode === 'malformed') writeFileSync(file, '{broken')
    if (mode === 'invalid-current') { state.current = 'absent'; writeFileSync(file, JSON.stringify(state)) }
    if (mode === 'unexpected-binding') { state.roles = { orphan: 'absent' }; writeFileSync(file, JSON.stringify(state)) }
    expect(() => importConfiguration(f.data, pkg(), settings, p.revision)).toThrow()
    expect(() => previewConfiguration(f.data, pkg(), settings)).toThrow()
    expect(f.roles.list()).toHaveLength(1)
    if (mode === 'missing') expect(existsSync(file)).toBe(false)
    if (mode === 'malformed') expect(readFileSync(file, 'utf8')).toBe('{broken')
  })
})

describe('RD-05-06 immediate rollback and startup use whole-unit checks', () => {
  for (const stage of ['roles', 'presets', 'committed'] as const) it.each(['first-role', 'second-role', 'extra-file', 'third-presets', 'missing-role'])(`${stage}: protects %s with prepared manifest`, mutation => {
    const f = setup(); f.data.presets.setCurrent('default')
    const preview = previewConfiguration(f.data, pkg(['新甲', '新乙']), settings)
    let files: string[] = []
    expect(() => importConfiguration(f.data, pkg(['新甲', '新乙']), settings, preview.revision, point => {
      if (point !== stage) return
      const m = manifest(f).value
      files = m.roleFiles.map((r: any) => join(f.root, r.path, 'ROLE.md'))
      if (mutation.endsWith('role') && mutation !== 'missing-role') {
        const target = files[mutation === 'first-role' ? 0 : 1]!
        writeFileSync(target, readFileSync(target, 'utf8') + '外部资料\n')
      }
      if (mutation === 'extra-file') writeFileSync(join(dirname(files[1]!), 'external.txt'), '外部资料')
      if (mutation === 'third-presets') {
        const file = join(f.root, 'presets.json'); const state = JSON.parse(readFileSync(file, 'utf8')); state.presets[0].head = '第三态'; writeFileSync(file, JSON.stringify(state))
      }
      if (mutation === 'missing-role') rmSync(files[1]!)
      throw new Error('injected failure')
    })).toThrow()
    // Missing members before the preset commit are ordinary partial creation and can roll back.
    const protects = mutation !== 'missing-role' || stage !== 'roles'
    expect(manifest(f).value.state).toBe(protects ? 'prepared' : 'rolled-back')
    if (protects) {
      expect(existsSync(files[0]!)).toBe(true)
      expect(() => recoverConfigurationImports(f.data)).toThrow()
      expect(existsSync(files[0]!)).toBe(true)
      expect(manifest(f).value.state).toBe('prepared')
    }
  })
  it.each(['roles', 'presets', 'committed'] as const)('unchanged unit failure at %s rolls back before or confirms after', stage => {
    const f = setup(); const preview = previewConfiguration(f.data, pkg(), settings)
    const action = () => importConfiguration(f.data, pkg(), settings, preview.revision, point => { if (point === stage) throw new Error('ack') })
    if (stage === 'roles') expect(action).toThrow('ack')
    else expect(action().roles).toBe(1)
    expect(manifest(f).value.state).toBe(stage === 'roles' ? 'rolled-back' : 'committed')
  })
})
