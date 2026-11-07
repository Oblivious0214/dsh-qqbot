import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { importConfiguration, previewConfiguration } from '../src/config-import.ts'
import { Maintenance } from '../src/maintenance.ts'
import { JailbreakStore } from '../src/presets.ts'
import { MemoryStore } from '../src/role-memory.ts'
import { RoleLibrary } from '../src/roles.ts'
import { example } from './role-dynamics/fixtures.ts'

const dirs: string[] = []
const malformed = '{"version":1,"presets":['
const priorCorrupt = 'earlier damaged original'
const pkg = { format: 'dsh-qqbot-config', version: 2, roles: [{ name: '新动态角色', description: '', persona: '正文', dynamics: example() }] }
const options = { roles: true, presets: true, conflict: 'skip' }
function dataAt(root: string): QqbotData {
  return new QqbotData(new RoleLibrary(join(root, 'roles'), () => {}), SessionBindings.at(root, () => {}),
    JailbreakStore.at(root, () => {}), () => {}, MemoryStore.at(root, () => {}))
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'qqbot-preset-baseline-')); dirs.push(home)
  const root = join(home, 'qqbot'); mkdirSync(root)
  const data = dataAt(root); const file = join(root, 'presets.json')
  const custom = data.presets.save({ name: '保留的自定义', head: '自定义正文', mid: '', tail: '' }, true)
  data.presets.setCurrent(custom.id); 
  return { home, root, data, file, original: readFileSync(file) }
}
function enter(data: QqbotData, root: string, mode: string): QqbotData {
  if (mode === 'reload') { data.presets.reload(); return data }
  const cold = dataAt(root)
  return mode === 'second-cold' ? dataAt(root) : cold
}
function blocked(data: QqbotData, root: string, revision: string) {
  expect(() => previewConfiguration(data, pkg, options)).toThrow()
  expect(() => importConfiguration(data, pkg, options, revision)).toThrow()
  expect(data.roles.list()).toHaveLength(0)
  expect(existsSync(join(root, 'roles'))).toBe(false)
  expect(existsSync(join(root, 'import-backups'))).toBe(false)
}
function imported(data: QqbotData) {
  const preview = previewConfiguration(data, pkg, options)
  expect(importConfiguration(data, pkg, options, preview.revision).roles).toBe(1)
  expect(data.roles.list()[0]!.dynamics).toEqual(example())
}
afterEach(() => {
  for (const path of dirs.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('qqbot-preset-baseline-')) throw new Error('临时目录范围无效')
    rmSync(path, { recursive: true, force: true })
  }
})

describe('RD-05-R1 strict import after permissive preset loading', () => {
  for (const backup of [false, true]) it.each(['cold', 'reload', 'second-cold'])(`%s keeps malformed original and existing corrupt backup=${backup}`, mode => {
    const f = setup(); const preview = previewConfiguration(f.data, pkg, options)
    writeFileSync(f.file, malformed)
    if (backup) writeFileSync(f.file + '.corrupt', priorCorrupt)
    const data = enter(f.data, f.root, mode)
    blocked(data, f.root, preview.revision)
    expect(readFileSync(f.file, 'utf8')).toBe(malformed)
    if (backup) expect(readFileSync(f.file + '.corrupt', 'utf8')).toBe(priorCorrupt)
    else expect(existsSync(f.file + '.corrupt')).toBe(false)
  })
  it.each(['cold', 'reload', 'second-cold'])('%s rejects legacy corrupt-only evidence without recreating presets', mode => {
    const f = setup(); const preview = previewConfiguration(f.data, pkg, options)
    rmSync(f.file); writeFileSync(f.file + '.corrupt', malformed)
    const data = enter(f.data, f.root, mode)
    blocked(data, f.root, preview.revision)
    expect(existsSync(f.file)).toBe(false)
    expect(readFileSync(f.file + '.corrupt', 'utf8')).toBe(malformed)
  })
  for (const evidence of ['original', 'legacy']) it.each(['same', 'reload', 'reconstruct'])(`restored valid ${evidence} library can retry via %s`, mode => {
    const f = setup(); const preview = previewConfiguration(f.data, pkg, options)
    if (evidence === 'original') writeFileSync(f.file, malformed)
    else { rmSync(f.file); writeFileSync(f.file + '.corrupt', malformed) }
    let data = dataAt(f.root); blocked(data, f.root, preview.revision)
    writeFileSync(f.file, f.original)
    if (mode === 'same') expect(() => previewConfiguration(data, pkg, options)).toThrow('重新预览')
    if (mode === 'reload') data.presets.reload()
    if (mode === 'reconstruct') data = dataAt(f.root)
    expect(readFileSync(f.file)).toEqual(f.original)
    imported(data)
    const saved = JSON.parse(readFileSync(f.file, 'utf8')); const original = JSON.parse(f.original.toString())
    expect(saved.presets).toEqual(original.presets); expect(saved.current).toBe(original.current)
    expect(saved).not.toHaveProperty('roles')
    if (evidence === 'legacy') expect(readFileSync(f.file + '.corrupt', 'utf8')).toBe(malformed)
  })
  it('genuinely fresh disk library remains usable', () => {
    const f = setup(); const root = join(f.home, 'fresh')
    const data = dataAt(root)
    imported(data)
  })
  it('in-memory preset store keeps its initial import baseline', () => {
    const store = new JailbreakStore(undefined, () => {})
    expect(store.importBaseline().disk).toBeNull()
    store.appendImported([{ id: 'imported', name: '导入预设', head: '正文', mid: '', tail: '' }])
    expect(store.importBaseline().state.presets[1]?.id).toBe('imported')
  })
  it('valid cold library preserves all presets, default and orphan bindings', () => {
    const f = setup(); const data = dataAt(f.root); imported(data)
    const saved = JSON.parse(readFileSync(f.file, 'utf8')); const original = JSON.parse(f.original.toString())
    expect(saved.presets).toEqual(original.presets); expect(saved.current).toBe(original.current)
    expect(saved).not.toHaveProperty('roles')
  })
  it('invalid default remains rejected on cold loading without changing bytes', () => {
    const f = setup(); const original = JSON.parse(f.original.toString()); original.current = 'missing'
    writeFileSync(f.file, JSON.stringify(original)); const bytes = readFileSync(f.file)
    blocked(dataAt(f.root), f.root, 'stale'); expect(readFileSync(f.file)).toEqual(bytes)
  })
  it('cache cleanup preserves corrupt evidence and import remains blocked', async () => {
    const f = setup(); rmSync(f.file); writeFileSync(f.file + '.corrupt', malformed)
    const data = dataAt(f.root); const maintenance = new Maintenance(f.home, () => {})
    await maintenance.clear('cache'); blocked(data, f.root, 'stale')
    expect(readFileSync(f.file + '.corrupt', 'utf8')).toBe(malformed)
  })
  it('explicit all-data cleanup allows initial import in existing and reconstructed stores', async () => {
    const f = setup(); writeFileSync(f.file, malformed); writeFileSync(f.file + '.corrupt', priorCorrupt)
    const data = dataAt(f.root); blocked(data, f.root, 'stale')
    const maintenance = new Maintenance(f.home, () => {})
    maintenance.register({ reload: () => { data.presets.reload(); data.roles.reload() } })
    await maintenance.clear('all')
    expect(existsSync(f.file)).toBe(false); expect(existsSync(f.file + '.corrupt')).toBe(false)
    expect(data.presets.importBaseline().disk).toBeNull()
    expect(dataAt(f.root).presets.importBaseline().disk).toBeNull()
    imported(data)
  })
})
