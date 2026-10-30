import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { CONFIG_PATH, type ConfigOptions } from '../src/config-types.ts'
import { importConfiguration, previewConfiguration } from '../src/config-import.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'
import * as host from '../src/index.ts'

const dirs: string[] = []
const options: ConfigOptions = { presets: true, roles: true, conflict: 'skip' }
const config = {
  format: 'dsh-qqbot-config', version: 1,
  presets: [{ name: '测试预设', head: '开头', mid: '中间', tail: '结尾' }],
  roles: [{ name: '测试角色', persona: '角色设定。', preset: '测试预设', proactivity: 'follow',
    proactivityTexts: { follow: '自定义说明。', high: '' }, motionActions: ['slide'], motionRanges: ['full'] }],
}
function data() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-'))
  dirs.push(dir)
  const warn = () => {}
  return { dir, data: new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn) }
}
function apply(d: QqbotData, value: unknown = config, settings: ConfigOptions = options) {
  return importConfiguration(d, value, settings, previewConfiguration(d, value, settings).revision)
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('qqbot-config-')) throw new Error('测试目录不符合预期')
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('portable configuration', () => {
  it('previews without writing, imports generated keys and resolves references by name', () => {
    const { dir, data: d } = data()
    const preview = previewConfiguration(d, config, options)
    expect(preview.entries.map(e => [e.kind, e.target, e.status])).toEqual([['preset', '测试预设', 'add'], ['role', '测试角色', 'add']])
    expect(readdirSync(dir)).toEqual([])
    expect(importConfiguration(d, config, options, preview.revision)).toEqual({ presets: 1, roles: 1, skipped: 0 })
    const role = d.roles.list()[0]!
    expect(role.id).toMatch(/^r-[0-9a-f]{8}$/)
    expect(role).toMatchObject({ proactivity: 'follow', proactivityTexts: { follow: '自定义说明。', high: '' }, motionActions: ['slide'] })
    expect(d.presets.forRole(role.id)).toMatchObject({ name: '测试预设', head: '开头', mid: '中间', tail: '结尾' })
    expect(d.presets.forRole(role.id).id).toMatch(/^p-[0-9a-f]{8}$/)
    expect(d.presets.defaultId).toBe('default')
    expect(d.bindings.defaultRole).toBeUndefined()
    expect(existsSync(join(dir, 'sessions.json'))).toBe(false)
    const reloaded = JailbreakStore.at(dir, () => {})
    expect(reloaded.forRole(role.id)).toEqual(d.presets.forRole(role.id))
  })

  it('skips repeats and preserves existing edited content, defaults, bindings and bytes', () => {
    const { dir, data: d } = data()
    apply(d)
    const role = d.roles.list()[0]!
    d.roles.save({ ...role, persona: '用户改过。' }, false)
    d.bindings.set('existing-session', role.id)
    const before = readFileSync(join(dir, 'presets.json'))
    const sessions = readFileSync(join(dir, 'sessions.json'))
    const backups = readdirSync(join(dir, 'import-backups'))
    expect(apply(d)).toEqual({ presets: 0, roles: 0, skipped: 2 })
    expect(d.roles.list()).toHaveLength(1)
    expect(d.roles.list()[0]?.persona).toBe('用户改过。')
    expect(readFileSync(join(dir, 'presets.json'))).toEqual(before)
    expect(readFileSync(join(dir, 'sessions.json'))).toEqual(sessions)
    expect(readdirSync(join(dir, 'import-backups'))).toEqual(backups)
  })

  it('copies conflicts and binds the copied role to the copied preset', () => {
    const { data: d } = data()
    apply(d)
    apply(d, config, { ...options, conflict: 'copy' })
    const role = d.roles.list().find(r => r.name === '测试角色（导入）')!
    expect(d.presets.forRole(role.id).name).toBe('测试预设（导入）')
    apply(d, config, { ...options, conflict: 'copy' })
    expect(d.roles.list().map(r => r.name)).toContain('测试角色（导入 2）')
  })

  it('does not overwrite a collision with an incoming name while generating copy names', () => {
    const { data: d } = data()
    apply(d)
    const incoming = { ...config, presets: [...config.presets, { name: '测试预设（导入）', head: '独立预设' }], roles: [] }
    apply(d, incoming, { ...options, conflict: 'copy' })
    expect(new Set(d.presets.list().map(p => p.name)).size).toBe(d.presets.list().length)
    expect(d.presets.list().some(p => p.head === '独立预设')).toBe(true)
  })

  it('supports each category separately and rejects missing dependencies before writing', () => {
    const { dir, data: d } = data()
    expect(() => apply(d, config, { ...options, presets: false })).toThrow('同时导入')
    expect(readdirSync(dir)).toEqual([])
    expect(apply(d, config, { ...options, roles: false })).toMatchObject({ presets: 1, roles: 0 })
    expect(apply(d, config, { ...options, presets: false })).toMatchObject({ presets: 0, roles: 1 })
    expect(d.presets.forRole(d.roles.list()[0]!.id).name).toBe('测试预设')
    expect(apply(d, config, { ...options, roles: false, presets: false })).toEqual({ presets: 0, roles: 0, skipped: 0 })
  })

  it('fixes an unspecified role preset to the current QQ default and normalizes Windows newlines', () => {
    const { data: d } = data()
    apply(d, { format: config.format, version: 1, roles: [{ name: '独立角色', persona: '第一行\r\n第二行' }] })
    const role = d.roles.list()[0]!
    expect(role.persona).toBe('第一行\n第二行')
    expect(d.presets.roleChoice(role.id)).toBe('default')
  })

  it.each([
    null, {}, { ...config, version: 2 }, { ...config, format: 'old-plugin' },
    { ...config, settings: { authorized: true } },
    { ...config, presets: [{ ...config.presets[0], id: '../../escape' }] },
    { ...config, roles: [{ ...config.roles[0], voice: 'v-12345678' }] },
    { ...config, roles: [{ ...config.roles[0], motionActions: ['unknown'] }] },
    { ...config, roles: [{ ...config.roles[0], proactivityTexts: { high: 1 } }] },
    { ...config, presets: [config.presets[0], config.presets[0]] },
    { ...config, roles: [config.roles[0], config.roles[0]] },
    { ...config, presets: [{ name: '换\n行', head: '' }] },
    { ...config, roles: [{ name: '空角色', persona: '' }] },
    { ...config, roles: [{ name: '非法', persona: 'x', id: 'r-existing' }] },
    { ...config, roles: [], presets: [] },
    { ...config, roles: Array(101).fill(config.roles[0]) },
    { ...config, roles: [{ name: '太大', persona: '字'.repeat(750_000) }] },
  ])('rejects malformed, unsupported and oversized packages with no writes (%#)', value => {
    const { dir, data: d } = data()
    expect(() => previewConfiguration(d, value, options)).toThrow()
    expect(readdirSync(dir)).toEqual([])
    expect(d.roles.list()).toEqual([])
    expect(d.presets.list()).toHaveLength(1)
  })

  it('rejects stale previews and changed options before making a backup', () => {
    const { dir, data: d } = data()
    const preview = previewConfiguration(d, config, options)
    expect(() => importConfiguration(d, config, { ...options, conflict: 'copy' }, preview.revision)).toThrow('重新预览')
    d.presets.save({ name: '另一个预设', head: '', mid: '', tail: '' }, true)
    expect(() => importConfiguration(d, config, options, preview.revision)).toThrow('重新预览')
    expect(existsSync(join(dir, 'import-backups'))).toBe(false)
  })

  it('backs up the exact original preset file and records additions', () => {
    const { dir, data: d } = data()
    d.presets.save({ name: '旧预设', head: '保留', mid: '', tail: '' }, true)
    const original = readFileSync(join(dir, 'presets.json'))
    apply(d)
    const backup = join(dir, 'import-backups', readdirSync(join(dir, 'import-backups'))[0]!)
    expect(readFileSync(join(backup, 'presets.json'))).toEqual(original)
    expect(JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'))).toMatchObject({ presetsExisted: true, addedRoles: [d.roles.list()[0]!.id] })
  })

  it('rolls back all new roles when the final preset commit fails; retry works', () => {
    const { dir, data: d } = data()
    d.roles.save({ name: '原角色', persona: '原正文', description: '' }, true)
    const before = d.roles.list()
    const failure = vi.spyOn(d.presets, 'appendImported').mockImplementationOnce(() => { throw new Error('模拟磁盘写入失败') })
    expect(() => apply(d)).toThrow('模拟磁盘写入失败')
    expect(d.roles.list()).toEqual(before)
    expect(readdirSync(join(dir, 'roles'))).toEqual([before[0]!.id])
    expect(existsSync(join(dir, 'presets.json'))).toBe(false)
    expect(d.presets.list()).toHaveLength(1)
    failure.mockRestore()
    expect(apply(d).roles).toBe(1)
  })

  it('stops before importing when the backup location cannot be created', () => {
    const { dir, data: d } = data()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'import-backups'), 'occupied')
    expect(() => apply(d)).toThrow()
    expect(existsSync(join(dir, 'roles'))).toBe(false)
    expect(d.presets.list()).toHaveLength(1)
  })
})

describe('configuration route lifecycle', () => {
  it('previews, imports, validates requests and disposes with the plugin', async () => {
    type Route = { path: string; fetch: (request: Request) => Promise<Response> }
    const routes = new Map<string, Route>()
    const root = new Context()
    root.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } })
    root.provide('agents', { get: () => undefined })
    root.provide('agentPresets', { presetForSession: () => null })
    const fiber = await root.plugin(host)
    const call = (body: unknown) => routes.get(CONFIG_PATH)!.fetch(new Request(`http://localhost${CONFIG_PATH}`, {
      method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    try {
      expect((await call('{')).status).toBe(400)
      expect((await call({ action: 'invalid' })).status).toBe(400)
      expect((await call({ action: 'preview', config: {}, options })).status).toBe(400)
      const response = await call({ action: 'preview', config, options })
      expect(response.status).toBe(200)
      const { preview } = await response.json() as { preview: { revision: string } }
      const imported = await call({ action: 'import', config, options, revision: preview.revision })
      expect(await imported.json()).toMatchObject({ imported: { presets: 1, roles: 1 }, library: { roles: [{ name: '测试角色' }] } })
      expect((await call({ action: 'import', config, options, revision: preview.revision })).status).toBe(409)
      expect((await call('x'.repeat(2 * 1024 * 1024 + 4097))).status).toBe(413)
    } finally { await fiber.dispose() }
    expect(routes.has(CONFIG_PATH)).toBe(false)
  })
})
