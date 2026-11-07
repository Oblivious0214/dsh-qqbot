import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JailbreakStore } from '../../src/presets.ts'
import { RoleLibrary } from '../../src/roles.ts'
import { InterruptedImport, TavernImportStore, type StoreOptions } from '../../src/tavern-import/store.ts'
import { payload, png } from './fixtures.ts'
const dirs: string[] = []
function setup(options: StoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-tavern-')); dirs.push(root)
  const data = { roles: new RoleLibrary(join(root, 'roles'), () => {}), presets: JailbreakStore.at(root, () => {}) }
  const store = new TavernImportStore(data, options)
  return { root, data, store }
}
function manifest(root: string): { folder: string; value: any } {
  const folder = join(root, 'import-backups', readdirSync(join(root, 'import-backups'))[0]!)
  return { folder, value: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('qqbot-tavern-')) throw new Error('临时路径不符合预期')
    rmSync(dir, { recursive: true, force: true })
  }
})
describe('new imports and previews', () => {
  it('rejects a role directory junction before reloading or writing external files', () => {
    const { root, data, store } = setup(), outside = setup()
    writeFileSync(join(outside.root, 'marker'), 'fixture')
    symlinkSync(outside.root, join(root, 'roles'), process.platform === 'win32' ? 'junction' : 'dir')
    const reload = vi.spyOn(data.roles, 'reload')
    expect(() => store.preview(payload())).toThrow('联接'); expect(reload).not.toHaveBeenCalled()
    expect(readdirSync(outside.root)).toEqual(['marker']); expect(existsSync(join(root, 'presets.json'))).toBe(false)
  })
  it('previews without storing anything, creates role with bound default and full provenance', () => {
    const { root, data, store } = setup(), p = payload(); p.sources[0]!.name = '../../do-not-write.json'
    const before = JSON.stringify(data.presets.list()), preview = store.preview(p)
    expect(readdirSync(root)).toEqual([])
    const saved = store.commit(p, preview), archive = join(root, 'import-backups', saved.archive)
    expect(saved.id).toMatch(/^r-[a-f0-9]{8}$/); expect(data.roles.get(saved.id)!.persona).toBe(p.body)
    expect(data.presets.snapshot()).not.toHaveProperty('roles'); expect(data.presets.currentId).toBe('default')
    expect(JSON.stringify(data.presets.list())).toBe(before); expect(existsSync(join(root, 'sessions.json'))).toBe(false)
    expect(readFileSync(join(archive, 'sources', '0.bin'))).toEqual(Buffer.from(p.sources[0]!.originalBase64, 'base64'))
    const materials = JSON.parse(readFileSync(join(archive, 'materials.json'), 'utf8'))
    expect(materials.materials[0].originalText).not.toBe('')
    expect(JSON.parse(readFileSync(join(archive, 'selection.json'), 'utf8'))).toEqual(p.selections)
    expect(manifest(root).value).toMatchObject({ stage: 'complete', presetsExisted: false, oldPresetHash: null })
    expect(readdirSync(root).sort()).toEqual(['import-backups', 'presets.json', 'roles'])
  })
  it('adds preset to head only and preserves existing roles, defaults, bindings and raw before bytes', () => {
    const { root, data, store } = setup(), oldRole = data.roles.save({ name: '旧角色', persona: '手写人设', description: '' }, true)
    const preset = data.presets.save({ name: '旧预设', head: '原文', mid: '中', tail: '后' }, true)
    data.presets.setCurrent(preset.id); 
    const file = join(root, 'presets.json'), old = readFileSync(file), roleBytes = readFileSync(join(root, 'roles', oldRole.id, 'ROLE.md'))
    const p = payload('preset', '导入预设'), saved = store.commit(p, store.preview(p))
    expect(data.presets.get(saved.id)).toMatchObject({ head: p.body, mid: '', tail: '' })
    expect(data.presets.currentId).toBe(preset.id); expect(data.presets.snapshot()).not.toHaveProperty('roles')
    expect(readFileSync(join(root, 'roles', oldRole.id, 'ROLE.md'))).toEqual(roleBytes)
    expect(readFileSync(join(root, 'import-backups', saved.archive, 'presets.before.json'))).toEqual(old)
  })
  it('offers a unique name without overwriting and copy names are computed again at commit', () => {
    const { data, store } = setup(), p = payload(), first = store.commit(p, store.preview(p))
    expect(() => store.preview(p)).toThrow('同名')
    try { store.preview(p) } catch (e) { expect((e as any).details.suggestedName).toBe('导入角色（导入）') }
    p.conflict = 'copy'; expect(store.preview(p).name).toBe('导入角色（导入）')
    const next = store.commit(p, store.preview(p)); expect(next.name).toBe('导入角色（导入）')
    expect(store.preview(p).name).toBe('导入角色（导入 2）'); expect(data.roles.get(first.id)!.name).toBe('导入角色')
  })
  it.each(['body', 'selection', 'source', 'group', 'name'])('invalidates preview when %s changes', part => {
    const { store } = setup(), p = payload(), preview = store.preview(p)
    if (part === 'body') p.body += '\n编辑'
    else if (part === 'selection') p.selections[0]!.selected = false
    else if (part === 'source') p.sources[0]!.name = '另一文件'
    else if (part === 'name') p.name = '新名字'
    else p.groups = {}
    expect(() => store.commit(p, preview)).toThrow('变化')
  })
  it('detects library changes, stale in-memory presets and external edits without overwriting', () => {
    const { root, data, store } = setup(), p = payload(), preview = store.preview(p)
    data.presets.save({ name: '新增', head: 'x', mid: '', tail: '' }, true)
    expect(() => store.commit(p, preview)).toThrow('变化')
    const preview2 = store.preview(p), file = join(root, 'presets.json'), external = JSON.parse(readFileSync(file, 'utf8')); external.presets[0].head = '外部修改'
    writeFileSync(file, JSON.stringify(external)); const bytes = readFileSync(file)
    expect(() => store.commit(p, preview2)).toThrow('磁盘预设'); expect(readFileSync(file)).toEqual(bytes)
    expect(store.commit(p, store.preview(p)).id).toMatch(/^r-/)
  })
  it('makes the same token/payload idempotent before and after process restart, rejects token reuse with changed payload', () => {
    const { data, store } = setup(), p = payload(), preview = store.preview(p), saved = store.commit(p, preview)
    expect(store.commit(p, preview)).toEqual(saved)
    expect(new TavernImportStore(data).commit(p, preview)).toEqual(saved); expect(data.roles.list()).toHaveLength(1)
    expect(() => store.commit({ ...p, body: '不同' }, preview)).toThrow('不同内容')
  })
  it('rejects tampered, disposed or previous-generation unsubmitted previews', () => {
    const { data, store } = setup(), p = payload(), preview = store.preview(p)
    expect(() => store.commit(p, { ...preview, name: '伪造' })).toThrow('失效')
    expect(() => new TavernImportStore(data).commit(p, preview)).toThrow('失效')
    store.dispose(); expect(() => store.commit(p, preview)).toThrow('失效')
  })
  it('saves a decoded cropped avatar in the same transaction, rejects invalid avatars before any write', () => {
    const { root, store } = setup(), p = payload(); p.avatarBase64 = png().toString('base64')
    const saved = store.commit(p, store.preview(p)); expect(readFileSync(join(root, 'images', 'avatars', `${saved.id}.png`))).toEqual(png())
    const { root: empty, store: next } = setup(), bad = payload(); bad.avatarBase64 = 'AAAA'
    expect(() => next.preview(bad)).toThrow(); expect(readdirSync(empty)).toEqual([])
  })
  it('checks ROLE.md round-trip before library writes', () => {
    const { root, store } = setup(), p = payload(); p.name = '引号"名字'
    const saved = store.commit(p, store.preview(p)); expect(saved.name).toBe(p.name)
    const { root: empty, store: another } = setup(), broken = payload(); broken.body = '第一行\r\n第二行'
    expect(() => another.commit(broken, another.preview(broken))).toThrow('完整保存')
    expect(readdirSync(empty)).toEqual([]); expect(existsSync(join(root, 'presets.json'))).toBe(true)
  })
})
describe('transaction failure and restart recovery', () => {
  it('rolls back both files on an avatar move failure and never touches an old avatar', () => {
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'moved-1') throw new Error('avatar write failure') } }), p = payload(); p.avatarBase64 = png().toString('base64')
    mkdirSync(join(root, 'images', 'avatars'), { recursive: true }); writeFileSync(join(root, 'images', 'avatars', 'old.webp'), 'old bytes')
    expect(() => store.commit(p, store.preview(p))).toThrow('已撤销')
    expect(readdirSync(join(root, 'images', 'avatars'))).toEqual(['old.webp']); expect(readFileSync(join(root, 'images', 'avatars', 'old.webp'), 'utf8')).toBe('old bytes')
    expect(data.roles.list()).toHaveLength(0); expect(existsSync(join(root, 'presets.json'))).toBe(false)
  })
  it('rolls back role and avatar when final append fails, preserves old bytes', () => {
    const { root, data, store } = setup(), p = payload(); p.avatarBase64 = png().toString('base64')
    data.presets.save({ name: '原预设', head: '', mid: '', tail: '' }, true)
    const old = readFileSync(join(root, 'presets.json')), preview = store.preview(p)
    vi.spyOn(data.presets, 'appendImported').mockImplementation(() => { throw new Error('disk full') })
    expect(() => store.commit(p, preview)).toThrow('已撤销')
    expect(readdirSync(join(root, 'roles'))).toEqual([]); expect(readdirSync(join(root, 'images', 'avatars'))).toEqual([])
    expect(readFileSync(join(root, 'presets.json'))).toEqual(old); expect(manifest(root).value.stage).toBe('rolled-back')
  })
  it('reports rollback failure honestly and recovers it on next import', () => {
    let failRollback = true
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'rollback-file' && failRollback) throw new Error('locked') } }), p = payload(), preview = store.preview(p)
    const spy = vi.spyOn(data.presets, 'appendImported').mockImplementation(() => { throw new Error('disk full') })
    expect(() => store.commit(p, preview)).toThrow('撤销未完成'); expect(manifest(root).value.stage).toBe('prepared')
    failRollback = false; spy.mockRestore(); new TavernImportStore(data).recover()
    expect(data.roles.list()).toHaveLength(0); expect(manifest(root).value.stage).toBe('rolled-back')
  })
  it.each(['prepared', 'role-directory', 'moved-0', 'moved-1', 'before-append'])('undoes pre-commit interruption at %s without restoring unrelated data', point => {
    const { root, data, store } = setup({ checkpoint: at => { if (at === point) throw new InterruptedImport(point) } }), p = payload(); p.avatarBase64 = png().toString('base64')
    const preview = store.preview(p); expect(() => store.commit(p, preview)).toThrow(InterruptedImport)
    expect(manifest(root).value.stage).toBe('prepared'); new TavernImportStore(data).recover()
    expect(data.roles.list()).toHaveLength(0); expect(existsSync(join(root, 'presets.json'))).toBe(false)
    expect(manifest(root).value.stage).toBe('rolled-back')
  })
  it('finishes an after-append interrupted transaction and returns the same result on retry', () => {
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'after-append') throw new InterruptedImport() } }), p = payload(), preview = store.preview(p)
    expect(() => store.commit(p, preview)).toThrow(InterruptedImport)
    const expected = manifest(root).value.result, fresh = new TavernImportStore(data)
    expect(fresh.commit(p, preview)).toEqual(expected); expect(manifest(root).value.stage).toBe('complete'); expect(data.roles.list()).toHaveLength(1)
  })
  it('treats a failed completion marker as committed, never rolls back or duplicates', () => {
    const warn = vi.fn(), { root, data, store } = setup({ warn, checkpoint: point => { if (point === 'after-append') throw new Error('manifest unwritable') } }), p = payload(), preview = store.preview(p)
    const saved = store.commit(p, preview); expect(warn).toHaveBeenCalled(); expect(manifest(root).value.stage).toBe('prepared')
    expect(new TavernImportStore(data).commit(p, preview)).toEqual(saved); expect(data.roles.list()).toHaveLength(1)
  })
  it('uses matching appended records after a later unrelated library change', () => {
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'after-append') throw new InterruptedImport() } }), p = payload('preset'), preview = store.preview(p)
    expect(() => store.commit(p, preview)).toThrow()
    data.presets.save({ name: '后来新增', head: '后续', mid: '', tail: '' }, true)
    const bytes = readFileSync(join(root, 'presets.json')); new TavernImportStore(data).recover()
    expect(manifest(root).value.stage).toBe('complete'); expect(readFileSync(join(root, 'presets.json'))).toEqual(bytes)
  })
  it('refuses ambiguous external preset changes rather than restoring an old file', () => {
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'moved-0') throw new InterruptedImport() } }), p = payload()
    expect(() => store.commit(p, store.preview(p))).toThrow()
    data.presets.save({ name: '外部', head: '其他', mid: '', tail: '' }, true)
    const bytes = readFileSync(join(root, 'presets.json')); expect(() => new TavernImportStore(data).recover()).toThrow('外部修改')
    expect(readFileSync(join(root, 'presets.json'))).toEqual(bytes); expect(manifest(root).value.stage).toBe('prepared')
  })
  it('never deletes a transaction file or directory modified by somebody else', () => {
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'moved-0') throw new InterruptedImport() } }), p = payload()
    expect(() => store.commit(p, store.preview(p))).toThrow()
    const m = manifest(root), file = join(root, 'roles', m.value.roleId, 'ROLE.md'); writeFileSync(file, '外部修改')
    expect(() => new TavernImportStore(data).recover()).toThrow('外部修改'); expect(readFileSync(file, 'utf8')).toBe('外部修改')
  })
  it('rejects recovery manifest path tampering and preserves outside files', () => {
    const { root, data, store } = setup({ checkpoint: point => { if (point === 'prepared') throw new InterruptedImport() } }), p = payload()
    expect(() => store.commit(p, store.preview(p))).toThrow()
    const m = manifest(root); m.value.files[0].path = '../outside'; writeFileSync(join(m.folder, 'manifest.json'), JSON.stringify(m.value))
    expect(() => new TavernImportStore(data).recover()).toThrow('路径规则')
  })
  it('preserves legacy configuration archives untouched', () => {
    const { root, store } = setup(); mkdirSync(join(root, 'import-backups', 'old'), { recursive: true }); writeFileSync(join(root, 'import-backups', 'old', 'manifest.json'), '{"version":1,"addedRoles":[]}')
    store.recover(); expect(readdirSync(join(root, 'import-backups', 'old'))).toEqual(['manifest.json'])
  })
})
