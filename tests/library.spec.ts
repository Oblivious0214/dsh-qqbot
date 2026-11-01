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
    const existing = '---\nid: alice\nname: 旧名\nvoice: v-0000000a\nmemeFrequency: low\ncustom: 保留\n---\n\n旧设定。\n'
    const text = renderRole({ ...draft, name: '"小" 爱', description: '', memeFrequency: 'off', voice: 'v-0000000b' }, existing)
    expect(text).toContain('custom: 保留')
    expect(parseRole(text, 'x')).toMatchObject({
      id: 'alice', name: '"小" 爱', description: '', persona: '爱丽丝的设定。', voice: 'v-0000000b', memeFrequency: 'off',
    })
    // 编辑器选"不用语音"时去掉这一行。
    expect(renderRole(draft, text)).not.toContain('voice')
    expect(() => new RoleLibrary(mkdtempSync(join(tmpdir(), 'dsh-qqbot-library-')), () => {}).save({ ...draft, voice: 'v-1' }, true)).toThrow('音色无效')
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

  it('writes motion preferences as comma lists, keeps action names in order and drops unknown ranges', () => {
    // 偏好动作是动作库名称，按写的顺序去重；是否还在动作库里由联动模块判断。
    const existing = '---\nid: alice\nmotionActions: 滑动, 稳定节奏，滑动, \nmotionRanges: nowhere\ncustom: 保留\n---\n\n旧设定。\n'
    const parsed = parseRole(existing, 'x')
    expect(parsed?.motionActions).toEqual(['滑动', '稳定节奏'])
    expect(parsed).not.toHaveProperty('motionRanges')
    const written = renderRole({ ...draft, motionActions: ['稳定节奏', '滑动'], motionRanges: ['full', 'upper'] }, existing)
    expect(written).toContain('motionActions: "稳定节奏, 滑动"')
    expect(parseRole(written, 'x')).toMatchObject({ motionActions: ['稳定节奏', '滑动'], motionRanges: ['full', 'upper'] })
    const cleared = renderRole(draft, existing)
    expect(cleared).not.toMatch(/motionActions|motionRanges/)
    expect(cleared).toContain('custom: 保留')
    const library = new RoleLibrary(mkdtempSync(join(tmpdir(), 'dsh-qqbot-library-')), () => {})
    for (const motionActions of [['a,b'], [''], [1], 'steady', Array.from({ length: 21 }, (_, i) => `动作${i}`)]) {
      expect(() => library.save({ ...draft, motionActions }, true)).toThrow('偏好动作')
    }
    expect(() => library.save({ ...draft, motionRanges: 'full' }, true)).toThrow('偏好范围无效')
    // 按提交顺序去重；空列表等于没写。
    expect(library.save({ ...draft, motionActions: ['滑动', '稳定节奏', '滑动'], motionRanges: [] }, true))
      .toMatchObject({ motionActions: ['滑动', '稳定节奏'] })
  })

  it('round-trips per-role autonomy prompts and exposes them to the editor', () => {
    const { data: d } = data()
    const texts = { follow: '按角色决定。\n保留 "引号" 和 \\ 路径。', high: '' }
    applyLibraryAction(d, { action: 'role.save', create: true, role: { ...draft, proactivityTexts: texts } })
    expect(libraryView(d).roles[0]?.proactivityTexts).toEqual(texts)
    expect(d.roles.get('alice')?.proactivityTexts).toEqual(texts)
    applyLibraryAction(d, { action: 'role.save', create: false, role: draft })
    expect(d.roles.get('alice')).not.toHaveProperty('proactivityTexts')
    expect(renderRole(draft, renderRole({ ...draft, proactivityTexts: texts }, undefined))).not.toContain('proactivityTexts:')
    for (const invalid of [{ wild: 'x' }, { high: 2 }, { follow: 'x'.repeat(2001) }, []]) {
      expect(() => d.roles.save({ ...draft, proactivityTexts: invalid }, false)).toThrow('自主性提示词')
    }
    expect(parseRole('---\nproactivityTexts: {bad}\n---\n设定。', 'x')).not.toHaveProperty('proactivityTexts')
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
  it('saves a concrete preset with the role and keeps it when the default changes', () => {
    const { dir, data: d } = data()
    d.presets.save({ id: 'soft', name: '温和', head: 'H', mid: '', tail: '' }, true)
    applyLibraryAction(d, { action: 'role.save', create: true, role: { ...draft, preset: 'default' } })
    d.presets.setDefault('soft')
    expect(d.presets.forRole('alice').id).toBe('default')
    applyLibraryAction(d, { action: 'role.save', create: false, role: { ...draft, persona: '新设定', preset: 'soft' } })
    expect(libraryView(d).roles[0]).toMatchObject({ persona: '新设定', preset: 'soft' })
    // 预设关系仍放预设存储，不混进角色正文或卡片字段。
    expect(readFileSync(join(dir, 'roles', 'alice', 'ROLE.md'), 'utf8')).not.toContain('preset:')
    // 旧调用不传预设，也不能意外清空已选关系。
    applyLibraryAction(d, { action: 'role.save', create: false, role: draft })
    expect(d.presets.roleChoice('alice')).toBe('soft')
  })

  it('rejects missing presets before writing or overwriting a role', () => {
    const { data: d } = data()
    expect(() => applyLibraryAction(d, { action: 'role.save', create: true, role: { ...draft, preset: 'missing' } })).toThrow('重新选择')
    expect(d.roles.list()).toEqual([])
    applyLibraryAction(d, { action: 'role.save', create: true, role: { ...draft, preset: 'default' } })
    expect(() => applyLibraryAction(d, { action: 'role.save', create: false, role: { ...draft, name: '不应写入', preset: null } })).toThrow('重新选择')
    expect(d.roles.get('alice')?.name).toBe(draft.name)
    expect(d.presets.roleChoice('alice')).toBe('default')
  })

  it('makes up the id of a new preset and refuses a second preset with the same name', () => {
    const { data: d } = data()
    const id = applyLibraryAction(d, { action: 'preset.save', create: true, preset: { name: '温和', head: 'H', mid: '', tail: '' } })
    expect(id).toMatch(/^p-[0-9a-f]{8}$/)
    expect(d.presets.get(id!)?.head).toBe('H')
    expect(() => applyLibraryAction(d, { action: 'preset.save', create: true, preset: { name: '温和', head: '', mid: '', tail: '' } })).toThrow('已经有叫"温和"的通用提示词')
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
    expect(view.roles).toEqual([{ ...draft, preset: 'soft', memory: '' }])
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
    expect(() => applyLibraryAction(d, { action: 'preset.remove', id: 'default' })).toThrow('至少要保留一份通用提示词')
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
    return { routes, call, fiber, root }
  }

  it('reads, writes and reports errors', async () => {
    const { routes, call, fiber } = await mount()
    expect(routes.get(LIBRARY_PATH)?.methods).toEqual(['GET', 'POST'])
    expect((await call()).body.presets.map(p => p.id)).toEqual(['default'])
    expect((await call('{')).status).toBe(400)
    expect((await call({ action: 'nope' })).body.error).toBe('bad-request')
    const failed = await call({ action: 'preset.remove', id: 'default' })
    expect([failed.status, failed.body.error, failed.body.message]).toEqual([409, 'failed', '至少要保留一份通用提示词'])
    const saved = await call({ action: 'role.save', create: true, role: draft })
    expect(saved.status).toBe(200)
    expect(saved.body.roles.map(r => r.id)).toEqual(['alice'])
    await fiber.dispose()
    expect(routes.has(LIBRARY_PATH)).toBe(false)
  })

  it('reports only currently registered optional capabilities, including disposal', async () => {
    const { call, fiber, root, routes } = await mount()
    expect((await call()).body.features).toEqual({ meme: false, toy: false })
    await routes.get('/api/qqbot/toy/state')!.fetch(new Request('http://localhost/api/qqbot/toy/state', {
      method: 'POST', body: JSON.stringify({ action: 'module.enable', enabled: true }),
    }))
    expect((await call()).body.features).toEqual({ meme: false, toy: true })
    let meme = true
    root.provide('tools', { get: (name: string) => name === 'send_meme' && meme ? {} : undefined })
    // 设备尚未接入会话也可编辑偏好；只检查插件登记，不求值规则。
    expect((await call()).body.features).toEqual({ meme: true, toy: true })
    meme = false
    await routes.get('/api/qqbot/toy/state')!.fetch(new Request('http://localhost/api/qqbot/toy/state', {
      method: 'POST', body: JSON.stringify({ action: 'module.enable', enabled: false }),
    }))
    expect((await call()).body.features).toEqual({ meme: false, toy: false })
    await fiber.dispose()
  })
})
