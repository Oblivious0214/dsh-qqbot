import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoleLibrary } from '../src/roles.ts'
import { JailbreakStore } from '../src/presets.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function interrupted(existing: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-config-window-')); roots.push(root)
  const module = (name: string) => JSON.stringify(new URL('../src/' + name + '.ts', import.meta.url).href)
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import { QqbotData } from ${module('content')};
    import { RoleLibrary } from ${module('roles')};
    import { JailbreakStore } from ${module('presets')};
    import { SessionBindings } from ${module('bindings')};
    import { importConfiguration, previewConfiguration } from ${module('config-import')};
    const root = ${JSON.stringify(root)}, warn = () => {};
    const presets = JailbreakStore.at(root, warn);
    if (${existing}) presets.setCurrent('default');
    const data = new QqbotData(new RoleLibrary(root + '/roles', warn), SessionBindings.at(root, warn), presets, warn);
    const append = presets.appendImported.bind(presets);
    presets.appendImported = (...args) => { append(...args); process.exit(73); };
    const value = { format: 'dsh-qqbot-config', version: 1, roles: [{ name: '窗口角色', persona: '原正文' }] };
    const options = { presets: true, roles: true, conflict: 'skip' };
    importConfiguration(data, value, options, previewConfiguration(data, value, options).revision);
  `], { encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(73)
  const file = join(root, 'import-backups', readdirSync(join(root, 'import-backups'))[0]!, 'manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  expect(manifest.state).toBe('prepared'); expect(manifest.commitReceipt).toBeUndefined()
  expect(manifest.before).toEqual(manifest.after); expect(manifest.presetsExisted).toBe(existing)
  expect(existsSync(join(root, 'presets.json'))).toBe(true)
  return { root, file, manifest, presetBytes: readFileSync(join(root, 'presets.json')) }
}
describe('configuration append before receipt process exit', () => {
  it.each([false, true])('fresh startup resolves identical states with original file=%s', existing => {
    const { root, file, manifest, presetBytes } = interrupted(existing)
    const roles = new RoleLibrary(join(root, 'roles'), () => {})
    expect(roles.list()).toHaveLength(existing ? 0 : 1)
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe(existing ? 'rolled-back' : 'committed')
    expect(readFileSync(join(root, 'presets.json'))).toEqual(presetBytes)
    expect(JailbreakStore.at(root, () => {}).currentId).toBe(manifest.after.current)
    roles.reload(); expect(roles.list()).toHaveLength(existing ? 0 : 1)
  })
  it.each(['presets', 'role', 'missing-role'])('preserves evidence after external %s change', kind => {
    const { root, file, manifest } = interrupted(false)
    const presetFile = join(root, 'presets.json'), roleFile = join(root, manifest.roleFiles[0].path, 'ROLE.md')
    if (kind === 'presets') {
      const state = JSON.parse(readFileSync(presetFile, 'utf8')); state.presets[0].head = '外部修改'
      writeFileSync(presetFile, JSON.stringify(state))
    } else if (kind === 'role') writeFileSync(roleFile, '外部角色修改')
    else rmSync(roleFile)
    const presetBytes = readFileSync(presetFile), roleBytes = existsSync(roleFile) ? readFileSync(roleFile) : undefined
    expect(() => new RoleLibrary(join(root, 'roles'), () => {})).toThrow()
    expect(readFileSync(presetFile)).toEqual(presetBytes)
    expect(existsSync(roleFile) ? readFileSync(roleFile) : undefined).toEqual(roleBytes)
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('prepared')
  })
})
