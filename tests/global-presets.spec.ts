import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'
import { InterruptedImport, TavernImportStore } from '../src/tavern-import/store.ts'
import { payload } from './tavern-import/fixtures.ts'
import { serializeConfigurationPackage, parseConfigurationPackage } from '../src/config-package.ts'
const roots: string[] = []
const a = { id: 'a', name: 'A', head: ' A\r\n原文 ', mid: '中', tail: '末' }
const b = { id: 'b', name: 'B', head: 'B', mid: '', tail: '' }
const legacy = { version: 1, default: 'b', presets: [a, b], roles: { alice: 'a', orphan: 'a' } }
function setup() { const root = mkdtempSync(join(tmpdir(), 'qqbot-global-presets-')); roots.push(root); return root }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('global preset migration', () => {
  it('preserves all original bytes once, drops bindings and uses the old default on every reload', () => {
    const root = setup(), file = join(root, 'presets.json')
    const original = Buffer.from('\uFEFF' + JSON.stringify(legacy, undefined, 4) + '\r\n')
    writeFileSync(file, original)
    const store = JailbreakStore.at(root, () => {})
    expect(store.snapshot()).toEqual({ version: 2, current: 'b', presets: legacy.presets })
    expect(readFileSync(file + '.pre-v2')).toEqual(original)
    const migrated = readFileSync(file)
    store.reload(); JailbreakStore.at(root, () => {})
    expect(readFileSync(file)).toEqual(migrated)
    expect(readFileSync(file + '.pre-v2')).toEqual(original)
    store.setCurrent('a'); store.reload(); expect(store.currentId).toBe('a')
    expect(readFileSync(file + '.pre-v2')).toEqual(original)
  })
  it('does not replace an earlier migration backup on retry', () => {
    const root = setup(), file = join(root, 'presets.json')
    writeFileSync(file, JSON.stringify(legacy)); writeFileSync(file + '.pre-v2', 'earlier original')
    expect(JailbreakStore.at(root, () => {}).currentId).toBe('b')
    expect(readFileSync(file + '.pre-v2', 'utf8')).toBe('earlier original')
  })
  it.each(['broken', 'invalid-current', 'backup-failure'])('preserves disk evidence on %s', mode => {
    const root = setup(), file = join(root, 'presets.json'), warnings: string[] = []
    const original = mode === 'broken' ? '{bad' : JSON.stringify({ ...legacy, default: mode === 'invalid-current' ? 'missing' : 'b' })
    writeFileSync(file, original)
    if (mode === 'backup-failure') mkdirSync(file + '.pre-v2')
    const store = JailbreakStore.at(root, message => { warnings.push(message) })
    expect(readFileSync(file, 'utf8')).toBe(original); expect(warnings.length).toBeGreaterThan(0)
    expect(() => store.importBaseline()).toThrow()
    if (mode !== 'backup-failure') expect(existsSync(file + '.pre-v2')).toBe(false)
  })
  it('creation, copy and editing do not activate; active edits and deletion use the same current selection', () => {
    const store = JailbreakStore.at(setup(), () => {})
    store.save(a, true); store.save(b, true); expect(store.currentId).toBe('default')
    store.setCurrent('b'); store.save({ ...b, head: 'updated' }, false)
    expect(store.current().head).toBe('updated')
    store.save({ ...a, id: 'copy', name: '副本' }, true); expect(store.currentId).toBe('b')
    store.remove('b'); expect(store.currentId).toBe('default')
    store.remove('a'); store.remove('copy'); expect(() => store.remove('default')).toThrow('至少')
    expect(() => store.setCurrent('unsaved')).toThrow()
  })
  it('ignores legacy package bindings and exports no role preset or implicit dependency', () => {
    const incoming = parseConfigurationPackage({ format: 'dsh-qqbot-config', version: 1, roles: [{ name: '角色', persona: '正文', preset: '不存在' }] })
    expect(incoming.roles[0]).not.toHaveProperty('preset')
    const out = serializeConfigurationPackage({ presets: [a], roles: [{ id: 'r', name: '角色', description: '', persona: '正文', memory: '' }] }, 'roles')
    expect(out.presets).toEqual([]); expect(out.roles[0]).not.toHaveProperty('preset')
  })
})
describe('role-only tavern commit receipts with an existing preset file', () => {
  it.each(['before-append', 'after-append'])('recovers %s with identical before/after preset bytes', point => {
    const root = setup()
    const data = { roles: new RoleLibrary(join(root, 'roles'), () => {}), presets: JailbreakStore.at(root, () => {}) }
    data.presets.setCurrent('default')
    const before = readFileSync(join(root, 'presets.json'))
    const store = new TavernImportStore(data, { checkpoint: at => { if (at === point) throw new InterruptedImport() } })
    const p = payload(), preview = store.preview(p)
    expect(() => store.commit(p, preview)).toThrow(InterruptedImport)
    new TavernImportStore(data).recover()
    const folder = join(root, 'import-backups', readdirSync(join(root, 'import-backups'))[0]!)
    expect(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).stage).toBe(point === 'after-append' ? 'complete' : 'rolled-back')
    expect(data.roles.list().length).toBe(point === 'after-append' ? 1 : 0)
    expect(readFileSync(join(root, 'presets.json'))).toEqual(before)
  })
})
describe('legacy tavern recovery after migration', () => {
  for (const kind of ['role', 'preset'] as const) it.each([false, true])(`${kind} committed=%s ignores old assignments`, committed => {
    const root = setup(), file = join(root, 'presets.json')
    const data = { roles: new RoleLibrary(join(root, 'roles'), () => {}), presets: JailbreakStore.at(root, () => {}) }
    data.presets.save(a, true)
    const before = data.presets.snapshot(), store = new TavernImportStore(data), p = payload(kind)
    const saved = store.commit(p, store.preview(p)), after = data.presets.snapshot()
    const folder = join(root, 'import-backups', saved.archive), manifestFile = join(folder, 'manifest.json')
    const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const old = { version: 1, default: before.current, presets: before.presets, roles: { orphan: 'a' } }
    const next = { version: 1, default: after.current, presets: after.presets, roles: { ...old.roles, ...(kind === 'role' ? { [saved.id]: before.current } : {}) } }
    const oldBytes = JSON.stringify(old, undefined, 2) + '\n', nextBytes = JSON.stringify(next, undefined, 2) + '\n'
    m.stage = 'prepared'; delete m.presetCommitted; m.assignments = kind === 'role' ? { [saved.id]: before.current } : {}
    m.oldPresetHash = sha(oldBytes); m.newPresetHash = sha(nextBytes)
    writeFileSync(manifestFile, JSON.stringify(m)); writeFileSync(file, committed ? nextBytes : oldBytes)
    const reloaded = { roles: new RoleLibrary(join(root, 'roles'), () => {}), presets: JailbreakStore.at(root, () => {}) }
    new TavernImportStore(reloaded).recover()
    expect(JSON.parse(readFileSync(manifestFile, 'utf8')).stage).toBe(committed ? 'complete' : 'rolled-back')
    expect(reloaded.presets.snapshot()).not.toHaveProperty('roles')
    expect(reloaded.presets.currentId).toBe(before.current)
    if (kind === 'role') expect(reloaded.roles.get(saved.id) !== undefined).toBe(committed)
    else expect(reloaded.presets.get(saved.id) !== undefined).toBe(committed)
    expect(readdirSync(root)).toContain('presets.json.pre-v2')
  })
})
