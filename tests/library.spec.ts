import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import * as host from '../src/index.ts'
import { applyLibraryAction, BadRequest, libraryView } from '../src/library.ts'
import { LIBRARY_PATH, type LibraryView } from '../src/library-types.ts'
import { JailbreakStore } from '../src/presets.ts'
import { parseRole, renderRole, RoleLibrary } from '../src/roles.ts'
import { buildPromptView } from '../src/viewer.ts'
import { QqbotRegistryStore } from '../src/registry.ts'

function data(dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-library-'))) {
  const warn = () => {}
  return { dir, data: new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn) }
}

const draft = { id: 'alice', name: '爱丽丝', description: '室友', persona: '爱丽丝的设定。' }

describe('role files written by the editor', () => {
  it('round-trips names with quotes and keeps other frontmatter fields', () => {
    const existing = '---\nid: alice\nname: 旧名\nvoiceId: "v-1"\nmemeFrequency: low\ncustom: 保留\n---\n\n旧设定。\n'
    const text = renderRole({ ...draft, name: '"小" 爱', description: '', memeFrequency: 'off' }, existing)
    expect(text).toContain('voiceId: "v-1"')
    expect(text).toContain('custom: 保留')
    expect(parseRole(text, 'x')).toMatchObject({
      id: 'alice', name: '"小" 爱', description: '', persona: '爱丽丝的设定。', voiceId: 'v-1', memeFrequency: 'off',
    })
  })

  it('drops the meme frequency line when the editor resets it to default', () => {
    const existing = '---\nid: alice\nmemeFrequency: high\ncustom: 保留\n---\n\n旧设定。\n'
    const text = renderRole(draft, existing)
    expect(text).not.toContain('memeFrequency')
    expect(text).toContain('custom: 保留')
    expect(parseRole(text, 'x')?.memeFrequency).toBeUndefined()
    expect(() => new RoleLibrary(mkdtempSync(join(tmpdir(), 'dsh-qqbot-library-')), () => {}).save({ ...draft, memeFrequency: 'often' }, true))
      .toThrow('表情频率无效')
  })

  it('writes the proactivity cap, drops it when unlimited and rejects unknown values', () => {
    const existing = '---\nid: alice\nproactivity: follow\ncustom: 保留\n---\n\n旧设定。\n'
    expect(parseRole(existing, 'x')?.proactivity).toBe('follow')
    expect(parseRole(renderRole({ ...draft, proactivity: 'situational' }, existing), 'x')?.proactivity).toBe('situational')
    const cleared = renderRole(draft, existing)
    expect(cleared).not.toContain('proactivity')
    expect(cleared).toContain('custom: 保留')
    expect(parseRole('---\nproactivity: wild\n---\n正文', 'x')?.proactivity).toBeUndefined()
    expect(() => new RoleLibrary(mkdtempSync(join(tmpdir(), 'dsh-qqbot-library-')), () => {}).save({ ...draft, proactivity: 'wild' }, true))
      .toThrow('联动主动性无效')
  })

  it('handles files without frontmatter', () => {
    expect(parseRole(renderRole(draft, '只有正文。'), 'alice')).toMatchObject({ id: 'alice', name: '爱丽丝', persona: '爱丽丝的设定。' })
  })

  it('makes up the id of a new role and refuses a second role with the same name', () => {
    const { dir, data: d } = data()
    const { id: _, ...noId } = draft
    const id = applyLibraryAction(d, { action: 'role.save', create: true, role: noId })
    expect(id).toMatch(/^r-[0-9a-f]{8}$/)
    expect(readFileSync(join(dir, 'roles', id!, 'ROLE.md'), 'utf8')).toContain(`id: ${id}`)
    expect(libraryView(d, id).saved).toBe(id)
    expect(() => applyLibraryAction(d, { action: 'role.save', create: true, role: { ...noId, persona: '另一个。' } })).toThrow('已经有叫"爱丽丝"的角色')
    // 改自己时名称不算重复；改成别人的名称不行。
    applyLibraryAction(d, { action: 'role.save', create: false, role: { ...noId, id, persona: '新设定。' } })
    const other = applyLibraryAction(d, { action: 'role.save', create: true, role: { ...noId, name: '鲍勃' } })
    expect(() => applyLibraryAction(d, { action: 'role.save', create: false, role: { ...noId, id: other } })).toThrow('已经有叫')
    expect(d.roles.list().map(role => role.name).sort()).toEqual(['爱丽丝', '鲍勃'].sort())
  })

  it('creates <id>/ROLE.md and refuses duplicates either way', () => {
    const { dir, data: d } = data()
    d.roles.save(draft, true)
    expect(existsSync(join(dir, 'roles', 'alice', 'ROLE.md'))).toBe(true)
    expect(() => d.roles.save(draft, true)).toThrow('已经存在')
    expect(() => d.roles.save({ ...draft, id: 'bob' }, false)).toThrow('不在角色库')
    expect(() => d.roles.save({ ...draft, name: 'a\nb' }, false)).toThrow('不能换行')
  })

  it('updates the file the role was read from, even when its id differs from the file name', () => {
    const { dir, data: d } = data()
    mkdirSync(join(dir, 'roles'), { recursive: true })
    writeFileSync(join(dir, 'roles', 'old-name.md'), '---\nid: alice\nname: A\n---\n旧设定。')
    d.roles.reload()
    d.roles.save({ ...draft, persona: '新设定。' }, false)
    expect(readdirSync(join(dir, 'roles'))).toEqual(['old-name.md'])
    expect(d.roles.get('alice')?.persona).toBe('新设定。')
  })

  it('does not overwrite an unreadable file with the same id', () => {
    const { dir, data: d } = data()
    mkdirSync(join(dir, 'roles'), { recursive: true })
    writeFileSync(join(dir, 'roles', 'alice.md'), '---\nname: 没有正文\n---\n')
    expect(() => d.roles.save(draft, true)).toThrow('读不出角色')
    expect(readFileSync(join(dir, 'roles', 'alice.md'), 'utf8')).toContain('没有正文')
  })

  it('moves removed roles to roles-trash, whole directory included', () => {
    const { dir, data: d } = data()
    d.roles.save(draft, true)
    writeFileSync(join(dir, 'roles', 'alice', 'avatar.png'), 'x')
    d.roles.remove('alice')
    expect(d.roles.get('alice')).toBeUndefined()
    const [trashed] = readdirSync(join(dir, 'roles-trash'))
    expect(trashed).toMatch(/-alice$/)
    expect(readdirSync(join(dir, 'roles-trash', trashed!)).sort()).toEqual(['ROLE.md', 'avatar.png'])
  })
})

describe('library actions', () => {
  it('makes up the id of a new preset and refuses a second preset with the same name', () => {
    const { data: d } = data()
    const id = applyLibraryAction(d, { action: 'preset.save', create: true, preset: { name: '温和', head: 'H', mid: '', tail: '' } })
    expect(id).toMatch(/^p-[0-9a-f]{8}$/)
    expect(d.presets.get(id!)?.head).toBe('H')
    expect(() => applyLibraryAction(d, { action: 'preset.save', create: true, preset: { name: '温和', head: '', mid: '', tail: '' } })).toThrow('已经有叫"温和"的预设')
    expect(() => applyLibraryAction(d, { action: 'preset.save', create: false, preset: { id, name: '默认', head: '', mid: '', tail: '' } })).toThrow('已经有叫')
    applyLibraryAction(d, { action: 'preset.save', create: false, preset: { id, name: '温和', head: 'H2', mid: '', tail: '' } })
    expect(d.presets.get(id!)?.head).toBe('H2')
  })

  it('saves presets with create/overwrite checks and assigns them to roles', () => {
    const { data: d } = data()
    const preset = { id: 'soft', name: '温和', head: 'H', mid: '', tail: 'T' }
    applyLibraryAction(d, { action: 'preset.save', create: true, preset })
    expect(() => applyLibraryAction(d, { action: 'preset.save', create: true, preset })).toThrow('已经存在')
    expect(() => applyLibraryAction(d, { action: 'preset.save', create: false, preset: { ...preset, id: 'nope' } })).toThrow('不在了')
    applyLibraryAction(d, { action: 'role.save', create: true, role: draft })
    expect(() => applyLibraryAction(d, { action: 'role.preset', id: 'bob', preset: 'soft' })).toThrow('不在角色库')
    applyLibraryAction(d, { action: 'role.preset', id: 'alice', preset: 'soft' })
    applyLibraryAction(d, { action: 'role.default', id: 'alice' })
    const view = libraryView(d)
    expect(view.roles).toEqual([{ ...draft, preset: 'soft' }])
    expect(view.defaultRole).toBe('alice')
    expect(view.presets.map(p => p.id)).toEqual(['default', 'soft'])
    // 新会话用默认角色和它选的预设。
    expect(d.jailbreakFor({ id: 'new' }).head).toBe('H')
    applyLibraryAction(d, { action: 'role.preset', id: 'alice' })
    applyLibraryAction(d, { action: 'role.default' })
    expect(libraryView(d).roles[0]?.preset).toBeUndefined()
    expect(libraryView(d).defaultRole).toBeUndefined()
  })

  it('separates malformed requests from failed operations', () => {
    const { data: d } = data()
    expect(() => applyLibraryAction(d, null)).toThrow(BadRequest)
    expect(() => applyLibraryAction(d, { action: 'drop.all' })).toThrow(BadRequest)
    expect(() => applyLibraryAction(d, { action: 'preset.remove' })).toThrow(BadRequest)
    expect(() => applyLibraryAction(d, { action: 'preset.remove', id: 'default' })).toThrow('至少要保留一份预设')
  })

  it('tells the prompt viewer which role and preset to edit', () => {
    const { data: d } = data()
    applyLibraryAction(d, { action: 'role.save', create: true, role: draft })
    d.bindings.set('s1', 'alice')
    const view = buildPromptView({ session: { id: 's1' }, content: d, store: new QqbotRegistryStore(), lastPrompt: undefined, workingDirectory: undefined, tools: [] })
    expect([view.roleId, view.presetId]).toEqual(['alice', 'default'])
  })
})

describe('library route', () => {
  type Route = { path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }

  async function mount() {
    const root = new Context()
    const routes = new Map<string, Route>()
    root.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } })
    root.provide('agents', { get: () => undefined })
    root.provide('agentPresets', { presetForSession: () => null })
    const fiber = await root.plugin(host)
    const call = async (body?: unknown) => {
      const init = body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }
      const response = await routes.get(LIBRARY_PATH)!.fetch(new Request(`http://127.0.0.1${LIBRARY_PATH}`, init))
      return { status: response.status, body: await response.json() as LibraryView & { error?: string; message?: string } }
    }
    return { routes, call, fiber }
  }

  it('reads, writes and reports errors', async () => {
    const { routes, call, fiber } = await mount()
    expect(routes.get(LIBRARY_PATH)?.methods).toEqual(['GET', 'POST'])
    expect((await call()).body.presets.map(p => p.id)).toEqual(['default'])
    expect((await call('{')).status).toBe(400)
    expect((await call({ action: 'nope' })).body.error).toBe('bad-request')
    const failed = await call({ action: 'preset.remove', id: 'default' })
    expect([failed.status, failed.body.error, failed.body.message]).toEqual([409, 'failed', '至少要保留一份预设'])
    const saved = await call({ action: 'role.save', create: true, role: draft })
    expect(saved.status).toBe(200)
    expect(saved.body.roles.map(r => r.id)).toEqual(['alice'])
    await fiber.dispose()
    expect(routes.has(LIBRARY_PATH)).toBe(false)
  })
})
