import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { importConfiguration, previewConfiguration, recoverConfigurationImports } from '../src/config-import.ts'
import { parseConfigurationPackage, serializeConfigurationPackage, serializeRoleConfiguration } from '../src/config-package.ts'
import { FileDataTransaction } from '../src/data-transactions.ts'
import { applyLibraryAction, libraryView } from '../src/library.ts'
import { Maintenance } from '../src/maintenance.ts'
import { JailbreakStore } from '../src/presets.ts'
import { digest } from '../src/role-dynamics/history.ts'
import { RoleDynamicsService } from '../src/role-dynamics/service.ts'
import { FileJournalStore } from '../src/role-dynamics/store.ts'
import { MemoryStore } from '../src/role-memory.ts'
import { progressDirectory, RoleDataTransactions } from '../src/role-transactions.ts'
import { parseRole, renderRole, RoleLibrary, validateRoleDraft } from '../src/roles.ts'
import { example, Histories, operation } from './role-dynamics/fixtures.ts'

const dirs: string[] = []
const settings = { presets: true, roles: true, conflict: 'skip' }
const draft = { name: '测试角色', description: '简介', persona: '静态正文' }
function setup(dynamic = true) {
  const home = mkdtempSync(join(tmpdir(), 'qqbot-role-data-')); dirs.push(home)
  const root = join(home, 'qqbot'); const warn = () => {}
  const roles = new RoleLibrary(join(root, 'roles'), warn)
  const role = roles.save({ ...draft, ...dynamic ? { dynamics: example() } : {} }, true)
  const data = new QqbotData(roles, SessionBindings.at(root, warn), JailbreakStore.at(root, warn), warn, MemoryStore.at(root, warn))
  const history = new Histories(); history.make('s')
  const maintenance = new Maintenance(home, warn)
  const options = { store: new FileJournalStore(join(root, 'role-dynamics')), history, config: (id: string) => roles.configuration(id), isSelected: () => true, epoch: maintenance.view().dataEpoch }
  const core = new RoleDynamicsService(options)
  const owner = core.createOwnerSource()
  let fault: ((stage: string) => void) | undefined
  const transactions = new RoleDataTransactions(roles, { dynamics: core, maintenance, fault: stage => fault?.(stage) })
  const target = { roleId: role.id, sessionId: 's' }
  const save = (dynamics: unknown, extra = {}) => roles.saveAsync({ ...draft, id: role.id, dynamics, dynamicsBaseRevision: roles.get(role.id)!.dynamicsRevision, ...extra }, false)
  return { home, root, roles, data, role, core, owner, options, target, history, maintenance, transactions, save, fault: (next?: (stage: string) => void) => { fault = next } }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('qqbot-role-data-')) throw new Error('不符合专用临时目录')
    rmSync(path, { recursive: true, force: true })
  }
})

describe('dynamic definitions in role files and portable packages', () => {
  it.each([undefined, null])('draft preserves omitted fields and explicitly removes null: %s', value => {
    const existing = renderRole({ ...draft, id: 'r', dynamics: example() }, undefined)
    const validated = validateRoleDraft({ ...draft, dynamics: value })
    expect(Object.hasOwn(validated, 'dynamics')).toBe(value === null)
    const saved = renderRole({ ...validated, id: 'r' }, existing)
    expect(parseRole(saved, 'r')?.dynamics).toEqual(value === null ? undefined : parseRole(existing, 'r')!.dynamics)
  })
  it('static and tavern LibraryRoleDraft.persona saves preserve the latest raw definition', async () => {
    const f = setup(); const file = f.roles.fileFor(f.role.id)!
    const raw = JSON.stringify(example(), null, 0).replaceAll(':', ': ')
    writeFileSync(file, renderRole({ ...draft, id: f.role.id }, undefined).replace('\n---\n', `\ndynamics:   ${raw}  \n---\n`))
    f.roles.save({ ...draft, id: f.role.id, persona: '酒馆静态资料' }, false)
    expect(readFileSync(file, 'utf8')).toContain(`dynamics:   ${raw}  `)
    await applyLibraryAction(f.data, { action: 'role.meme-prompt.save', id: f.role.id, prompt: '偏好' })
    await applyLibraryAction(f.data, { action: 'role.proactivity-text.save', id: f.role.id, level: 'follow', text: '说明' })
    expect(readFileSync(file, 'utf8')).toContain(`dynamics:   ${raw}  `)
  })
  it.each(['{bad', '{"version":2}', 'null'])('bad definition remains available as static data and blocks overwrite/export: %s', raw => {
    const f = setup(false); const file = f.roles.fileFor(f.role.id)!
    const text = renderRole({ ...draft, id: f.role.id }, undefined).replace('\n---\n', `\ndynamics: ${raw}\n---\n`)
    writeFileSync(file, text); f.roles.reload()
    expect(f.roles.get(f.role.id)).toMatchObject({ persona: draft.persona, dynamicsError: expect.stringContaining('动态设定无效') })
    expect(() => f.roles.configuration(f.role.id)).toThrow('动态设定无效')
    expect(() => f.roles.save({ ...draft, id: f.role.id }, false)).toThrow('动态设定无效')
    expect(() => serializeConfigurationPackage(libraryView(f.data))).toThrow('动态设定无效')
    expect(readFileSync(file, 'utf8')).toBe(text)
  })
  it('requires a current baseline for explicit replacement even when a static client saved meanwhile', async () => {
    const f = setup(); const baseline = f.role.dynamicsRevision
    const next = example(); next.enabled = false
    await f.save(next)
    await expect(f.roles.saveAsync({ ...draft, id: f.role.id, dynamics: example(), dynamicsBaseRevision: baseline }, false)).rejects.toThrow('基线')
    expect(f.roles.get(f.role.id)?.dynamics?.enabled).toBe(false)
    expect(() => f.roles.save({ ...draft, id: f.role.id, dynamics: example() }, false)).toThrow('基线')
  })
  it.each([true, false])('export/import/export retains complete semantics, enabled=%s, and shares no progress', async enabled => {
    const a = setup(); const next = example(); next.enabled = enabled; await a.save(next)
    const snap = (await a.core.readSnapshot(a.target))!
    await a.core.commit(a.target, operation(snap, a.owner, 'private-current', [{ name: '好感', value: 88 }]))
    const portable = serializeConfigurationPackage(libraryView(a.data))
    expect(portable.version).toBe(2)
    expect(JSON.stringify(portable)).not.toMatch(/private-current|progressId|generation|sessionId|dataEpoch|configRevision|baseRevision|receipts|role-dynamics|88/)
    const b = setup(false); b.roles.remove = vi.fn(b.roles.remove) // no ordinary removal is used by import
    const preview = previewConfiguration(b.data, portable, settings)
    // Remove the static fixture before importing into an empty role library.
    rmSync(b.roles.dir, { recursive: true }); b.roles.reload()
    importConfiguration(b.data, portable, settings, previewConfiguration(b.data, portable, settings).revision)
    expect(preview.entries.length).toBeGreaterThan(0)
    expect(serializeConfigurationPackage(libraryView(b.data))).toEqual(portable)
    expect(existsSync(join(b.root, 'role-dynamics'))).toBe(false)
    const imported = b.roles.list()[0]!
    expect((await b.core.readSnapshot({ sessionId: 's', roleId: imported.id }))?.values['好感']).toBe(20)
  })
  it('v1 is strict, v2 static can re-export v1, and prompt-only export remains v1', () => {
    const f = setup(false)
    const v1 = serializeConfigurationPackage(libraryView(f.data))
    expect(v1.version).toBe(1)
    expect(parseConfigurationPackage({ ...v1, version: 2 }).roles).toEqual(v1.roles)
    expect(serializeConfigurationPackage(libraryView(setup().data), 'presets').version).toBe(1)
    expect(() => parseConfigurationPackage({ ...v1, roles: [{ ...draft, dynamics: example() }] })).toThrow('不支持')
    expect(() => parseConfigurationPackage({ ...v1, version: 3 })).toThrow('不是支持')
    const bad = example(); bad.entries[0]!.when = { field: '不存在', op: 'eq', value: 1 }
    expect(() => parseConfigurationPackage({ ...v1, version: 2, roles: [{ ...draft, dynamics: bad }] })).toThrow()
  })
  it('object copy creates a fresh role with initial state and no receipts', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner, 'old-operation'))
    const copied = f.roles.save({ ...f.role, id: undefined, name: '另存角色' }, true)
    expect(copied.id).not.toBe(f.role.id); expect(copied.dynamics).toEqual(f.role.dynamics)
    expect(existsSync(progressDirectory(f.root, copied.id))).toBe(false)
    expect((await f.core.readSnapshot({ roleId: copied.id, sessionId: 's' }))?.values['好感']).toBe(20)
  })
  it('preview detects raw file changes outside the dynamic schema', () => {
    const f = setup(false); const pkg = { format: 'dsh-qqbot-config', version: 2, roles: [{ ...draft, name: '新增', dynamics: example() }] }
    const preview = previewConfiguration(f.data, pkg, settings)
    const file = f.roles.fileFor(f.role.id)!
    writeFileSync(file, readFileSync(file, 'utf8').replace('\n---\n', '\ncustom: 手写修改\n---\n'))
    expect(() => importConfiguration(f.data, pkg, settings, preview.revision)).toThrow('重新预览')
  })
})

describe('recoverable ROLE.md and journal transactions', () => {
  it('compatible edits retain current values, disabled state, and initial changes only affect new progress', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const next = example(); next.fields[0]!.initial = 10; next.enabled = false
    await f.save(next)
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(31)
    next.enabled = true; await f.save(next)
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(31)
  })
  it('incompatible reset is awaited, keeps backup originals, clears pending gate and applies the new initial', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const next = example(); Object.assign(next.fields[0]!, { max: 10, initial: 5 })
    await expect(f.save(next)).rejects.toThrow('重置')
    await f.save(next, { resetDynamics: true })
    const state = (await new RoleDynamicsService(f.options).readSnapshot(f.target))!
    expect(state.values['好感']).toBe(5); expect(state.generation).not.toBe(snap.generation)
    const journal = f.options.store.load(f.role.id) as any
    expect(journal.pendingConfigRevision).toBeUndefined()
    expect(journal.progress.some((p: any) => p.records.some((r: any) => r.snapshot.values['好感'] === 31))).toBe(true)
    const manifests = readdirSync(join(f.root, 'role-transactions')).map(s => join(f.root, 'role-transactions', s))
    expect(manifests.some(dir => readFileSync(join(dir, 'original-0'), 'utf8').includes('dynamics:'))).toBe(true)
  })
  it.each(['changed', 'commit'])('save failure at %s restores exact ROLE.md, prior values and a usable service', async stage => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const file = f.roles.fileFor(f.role.id)!; const before = readFileSync(file)
    const next = example(); Object.assign(next.fields[0]!, { max: 10, initial: 5 })
    f.fault(s => { if (s === stage) throw new Error('注入写入失败') })
    await expect(f.save(next, { resetDynamics: true })).rejects.toThrow('注入')
    expect(readFileSync(file)).toEqual(before)
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(31)
    f.fault(); await f.save(next, { resetDynamics: true })
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(5)
  })
  it('reset flush failure preserves old definition and does not publish a partial config', async () => {
    const f = setup(); const start = f.history.event('s', 'turn/start', { turn: 1 }); const handle = (await f.core.beginTurn(f.target, start))!
    const call = f.history.event('s', 'tool/call', { turn: 1, callId: 'c', name: 'qqbot_update_state', arguments: '{}' })
    await f.core.propose(handle, operation(handle.snapshot, handle.source, 'ai'), { seq: call, callId: 'c' })
    f.history.event('s', 'tool/result', { turn: 1, message: { toolCallId: 'c' } }, { sourceEventSeqs: [call] })
    f.history.event('s', 'assistant/message', { turn: 1, message: { content: [] } }); f.history.event('s', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.history.flushFault = async () => { throw new Error('flush failed') }
    const before = readFileSync(f.roles.fileFor(f.role.id)!)
    const next = example(); Object.assign(next.fields[0]!, { max: 10, initial: 5 })
    await expect(f.save(next, { resetDynamics: true })).rejects.toThrow('flush failed')
    expect(readFileSync(f.roles.fileFor(f.role.id)!)).toEqual(before)
  })
  it('null removes active progress and re-adding the definition starts at initial values', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    await expect(f.save(null)).rejects.toThrow('重置')
    await f.save(null, { resetDynamics: true })
    expect(f.roles.configuration(f.role.id)).toBeUndefined()
    expect(existsSync(progressDirectory(f.root, f.role.id))).toBe(false)
    await f.save(example()); expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(20)
  })
  it('startup restores an interrupted reset transaction before exposing role data', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const file = f.roles.fileFor(f.role.id)!
    const tx = FileDataTransaction.prepare(f.root, 'role-transactions', [file, progressDirectory(f.root, f.role.id)], { kind: 'configuration' })
    await f.core.resetRole(f.role.id, { ...example(), enabled: false })
    writeFileSync(file, renderRole({ ...draft, id: f.role.id, dynamics: { ...example(), enabled: false } }, undefined))
    const fresh = new RoleLibrary(f.roles.dir, () => {})
    expect(fresh.get(f.role.id)?.dynamics?.enabled).toBe(true)
    expect(JSON.parse(readFileSync(join(tx.dir, 'manifest.json'), 'utf8')).state).toBe('rolled-back')
    expect((await new RoleDynamicsService({ ...f.options, config: id => fresh.configuration(id) }).readSnapshot(f.target))?.values['好感']).toBe(31)
  })
  it.each(['changed', 'commit'])('role deletion failure at %s restores card/avatar/memory/progress with the same identity', async stage => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const avatar = join(f.root, 'avatars', `${f.role.id}.png`); mkdirSync(dirname(avatar), { recursive: true }); writeFileSync(avatar, 'image')
    f.data.memories.save(f.role.id, '## 关系\n记忆内容')
    const memory = f.data.memories.filePath(f.role.id)!
    const originals = [f.roles.fileFor(f.role.id)!, avatar, memory].map(p => [p, readFileSync(p)] as const)
    f.fault(s => { if (s === stage) throw new Error('注入回收失败') })
    await expect(f.roles.removeAsync(f.role.id, [avatar, memory])).rejects.toThrow('注入回收失败')
    for (const [path, bytes] of originals) expect(readFileSync(path)).toEqual(bytes)
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(31)
  })
  it('successful recycle/restore uses one stamp and restores progress and persistent receipt identity', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    const op = operation(snap, f.owner, 'receipt'); await f.core.commit(f.target, op)
    const asset = join(dirname(f.roles.fileFor(f.role.id)!), 'asset.png'); writeFileSync(asset, 'asset')
    const stamp = await f.roles.removeAsync(f.role.id)
    expect(f.roles.get(f.role.id)).toBeUndefined(); expect(existsSync(progressDirectory(f.root, f.role.id))).toBe(false)
    await f.roles.restore(stamp)
    expect(readFileSync(asset, 'utf8')).toBe('asset')
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(31)
    expect((await f.core.commit(f.target, op)).snapshot.revision).toBe(1)
  })
  it('failed restore remains a recycled unit and can be retried with the original roleId', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const stamp = await f.roles.removeAsync(f.role.id)
    f.fault(stage => { if (stage === 'changed') throw new Error('restore failed') })
    await expect(f.roles.restore(stamp)).rejects.toThrow('restore failed')
    expect(f.roles.get(f.role.id)).toBeUndefined()
    expect(existsSync(progressDirectory(f.root, f.role.id))).toBe(false)
    await expect(f.core.readSnapshot(f.target)).rejects.toThrow('回收')
    f.fault(); await f.roles.restore(stamp)
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(31)
  })
  it('a new library recovers an interrupted recycle of role, avatar, memory and journal', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const roleDir = dirname(f.roles.fileFor(f.role.id)!)
    const avatar = join(f.root, 'avatars', 'image.png'); mkdirSync(dirname(avatar), { recursive: true }); writeFileSync(avatar, 'avatar')
    f.data.memories.save(f.role.id, '## 关系\n恢复记忆')
    const memory = f.data.memories.filePath(f.role.id)!
    const tx = FileDataTransaction.prepare(f.root, 'role-transactions', [roleDir, avatar, memory, progressDirectory(f.root, f.role.id)], { kind: 'remove' })
    await f.core.detachRole(f.role.id, tx.manifest.stamp)
    rmSync(roleDir, { recursive: true }); rmSync(avatar); rmSync(memory)
    const roles = new RoleLibrary(f.roles.dir, () => {})
    expect(roles.get(f.role.id)?.dynamics).toEqual(f.role.dynamics)
    expect(readFileSync(avatar, 'utf8')).toBe('avatar'); expect(readFileSync(memory, 'utf8')).toContain('恢复记忆')
    expect((await new RoleDynamicsService({ ...f.options, config: id => roles.configuration(id) }).readSnapshot(f.target))?.values['好感']).toBe(31)
  })
  it('configuration reset holds maintenance writes and the core queue until the whole unit commits', async () => {
    const f = setup(); const start = f.history.event('s', 'turn/start', { turn: 1 })
    await f.core.beginTurn(f.target, start)
    f.history.event('s', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(r => { entered = r })
    f.history.flushFault = () => { entered(); return new Promise<void>(r => { release = r }) }
    const next = example(); next.enabled = false
    const saving = f.save(next, { resetDynamics: true })
    await waiting
    await expect(f.maintenance.clear('all')).rejects.toThrow('正在处理')
    expect(() => f.roles.save({ ...draft, id: f.role.id, persona: '旧静态页面' }, false)).toThrow('事务')
    const queued = f.core.readSnapshot(f.target)
    f.history.flushFault = undefined; release(); await saving
    expect((await queued)?.configRevision).toBe(digest(f.roles.get(f.role.id)!.dynamics))
    expect((f.options.store.load(f.role.id) as any).pendingConfigRevision).toBeUndefined()
  })
  it('scoped persistence ports expire and cannot later mutate a journal', async () => {
    const f = setup(); let port: any
    await f.core.withRolePersistence(f.role.id, async scoped => { port = scoped })
    expect(() => port.approve(example())).toThrow('失效')
  })
  it('rollback preserves an external ROLE.md edit made while reset waits for the host', async () => {
    const f = setup(); const start = f.history.event('s', 'turn/start', { turn: 1 }); await f.core.beginTurn(f.target, start)
    f.history.event('s', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(r => { entered = r })
    f.history.flushFault = () => { entered(); return new Promise<void>(r => { release = r }) }
    const next = example(); next.enabled = false
    const saving = f.save(next, { resetDynamics: true }); const rejected = expect(saving).rejects.toThrow('事务需要恢复')
    await waiting
    const file = f.roles.fileFor(f.role.id)!; const external = readFileSync(file, 'utf8').replace(draft.persona, '用户在等待中改的正文')
    writeFileSync(file, external); release(); await rejected
    expect(readFileSync(file, 'utf8')).toBe(external)
    expect(() => f.roles.configuration(f.role.id)).toThrow('需要恢复')
  })
  it('a journal write acknowledged as failed is rolled back together with the role authority', async () => {
    const f = setup(); await f.core.readSnapshot(f.target)
    const original = f.options.store.save.bind(f.options.store)
    vi.spyOn(f.options.store, 'save').mockImplementationOnce((...args) => { original(...args); throw new Error('journal ack failed') })
    const next = example(); next.enabled = false
    await expect(f.save(next, { resetDynamics: true })).rejects.toThrow('journal ack failed')
    expect(f.roles.get(f.role.id)?.dynamics?.enabled).toBe(true)
    expect((await f.core.readSnapshot(f.target))?.values['好感']).toBe(20)
    expect((f.options.store.load(f.role.id) as any).pendingConfigRevision).toBeUndefined()
  })
  it('static callback failure restores all files moved earlier in the same delete action', () => {
    const f = setup(false)
    // Use the legacy synchronous caller without a dynamics service.
    const roles = new RoleLibrary(f.roles.dir, () => {})
    const avatar = join(f.root, 'avatars', 'image.png'); mkdirSync(dirname(avatar), { recursive: true }); writeFileSync(avatar, 'avatar')
    const card = roles.fileFor(f.role.id)!; const before = readFileSync(card)
    expect(() => roles.remove(f.role.id, () => { rmSync(avatar); throw new Error('memory failed') }, [avatar])).toThrow('memory failed')
    expect(readFileSync(card)).toEqual(before); expect(readFileSync(avatar, 'utf8')).toBe('avatar')
  })
  it('cache cleanup preserves config, state and receipts; all cleanup invalidates a slow old commit', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    const op = operation(snap, f.owner, 'receipt'); await f.core.commit(f.target, op)
    await f.maintenance.clear('cache')
    expect((await f.core.commit(f.target, op)).snapshot.revision).toBe(1)
    let release!: () => void; let entered!: () => void
    const waiting = new Promise<void>(r => { entered = r })
    f.history.flushFault = () => { entered(); return new Promise<void>(r => { release = r }) }
    f.history.fork('s', 'late')
    const pending = f.core.readSnapshot({ ...f.target, sessionId: 'late' })
    const rejected = expect(pending).rejects.toThrow('失效')
    await waiting; await f.maintenance.clear('all'); release(); await rejected
    expect(existsSync(progressDirectory(f.root, f.role.id))).toBe(false)
    expect(f.roles.configuration(f.role.id)).toBeUndefined()
  })
  it('failed cleanup preparation leaves a usable service at the unchanged maintenance epoch', async () => {
    const f = setup(); const snap = (await f.core.readSnapshot(f.target))!
    await f.core.commit(f.target, operation(snap, f.owner))
    const unregister = f.maintenance.register({ credentials: async () => { throw new Error('cleanup preparation failed') } })
    await expect(f.maintenance.clear('all')).rejects.toThrow('cleanup preparation failed')
    const state = (await f.core.readSnapshot(f.target))!
    expect(state.dataEpoch).toBe(f.maintenance.view().dataEpoch); expect(state.values['好感']).toBe(31)
    await expect(f.core.commit(f.target, operation(state, f.core.createOwnerSource(), 'after-failure'))).resolves.toMatchObject({ status: 'no-change' })
    unregister()
  })
})

describe('configuration import failure and interruption recovery', () => {
  it('rollback only removes new roles, leaving bindings, defaults and existing memories byte-identical', () => {
    const f = setup(); f.data.bindings.set('existing', f.role.id); f.data.memories.save(f.role.id, '## 关系\n原记忆')
    const files = [join(f.root, 'sessions.json'), f.data.memories.filePath(f.role.id)!, f.roles.fileFor(f.role.id)!]
    const before = files.map(file => readFileSync(file))
    const config = { format: 'dsh-qqbot-config', version: 2, roles: [{ ...draft, name: '新动态', dynamics: example() }] }
    vi.spyOn(f.data.presets, 'appendImported').mockImplementation(() => { throw new Error('preset failed') })
    expect(() => importConfiguration(f.data, config, settings, previewConfiguration(f.data, config, settings).revision)).toThrow('preset failed')
    files.forEach((file, i) => expect(readFileSync(file)).toEqual(before[i]))
    expect(f.roles.list().map(r => r.id)).toEqual([f.role.id])
  })
  it.each([false, true])('recovers interrupted import with final preset write=%s without rolling back an acknowledged unit', committed => {
    const f = setup(false)
    const pkg = { format: 'dsh-qqbot-config', version: 2, roles: [{ ...draft, name: '导入', dynamics: example() }] }
    importConfiguration(f.data, pkg, settings, previewConfiguration(f.data, pkg, settings).revision)
    const dir = join(f.root, 'import-backups', readdirSync(join(f.root, 'import-backups'))[0]!)
    const file = join(dir, 'manifest.json'); const manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.state = 'prepared'; writeFileSync(file, JSON.stringify(manifest))
    if (!committed) {
      if (manifest.presetsExisted) writeFileSync(join(f.root, 'presets.json'), readFileSync(join(dir, 'presets.json')))
      else rmSync(join(f.root, 'presets.json'))
    }
    recoverConfigurationImports(f.data)
    expect(f.roles.list().some(r => r.name === '导入')).toBe(committed)
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe(committed ? 'committed' : 'rolled-back')
    expect(existsSync(join(f.root, 'role-dynamics'))).toBe(false)
  })
  it('post-rename preset acknowledgement failure keeps the complete import unit', () => {
    const f = setup(false)
    const pkg = { format: 'dsh-qqbot-config', version: 2, roles: [{ ...draft, name: '完整单元', dynamics: example() }] }
    const append = f.data.presets.appendImported.bind(f.data.presets)
    vi.spyOn(f.data.presets, 'appendImported').mockImplementation((...args) => { append(...args); throw new Error('ack failed') })
    expect(importConfiguration(f.data, pkg, settings, previewConfiguration(f.data, pkg, settings).revision).roles).toBe(1)
    expect(f.roles.list().some(r => r.name === '完整单元')).toBe(true)
    expect(serializeRoleConfiguration(f.roles.list().find(r => r.name === '完整单元')!).dynamics).toEqual(f.role.dynamics ?? parseRole(renderRole({ ...draft, id: 'r', dynamics: example() }, undefined), 'r')!.dynamics)
  })
  it('role-library construction recovers an uncommitted import before any command can list it', () => {
    const f = setup(false)
    const pkg = { format: 'dsh-qqbot-config', version: 2, roles: [{ ...draft, name: '未提交角色', dynamics: example() }] }
    importConfiguration(f.data, pkg, settings, previewConfiguration(f.data, pkg, settings).revision)
    const dir = join(f.root, 'import-backups', readdirSync(join(f.root, 'import-backups'))[0]!)
    const file = join(dir, 'manifest.json'); const manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.state = 'prepared'; writeFileSync(file, JSON.stringify(manifest)); rmSync(join(f.root, 'presets.json'))
    const fresh = new RoleLibrary(f.roles.dir, () => {})
    expect(fresh.list().map(r => r.name)).toEqual([draft.name])
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('rolled-back')
  })
})
