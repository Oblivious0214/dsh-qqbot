import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { checkImageFile, outputSize } from '../src/client/images.ts'
import { buildQqCss } from '../src/client/qq-style.ts'
import { UiState } from '../src/client/ui-state.ts'
import { QqbotData } from '../src/content.ts'
import { applyLibraryAction } from '../src/library.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'
import { applyUiAction, BadRequest, decodeImage, imageResponse, UiStore, uiView } from '../src/ui.ts'
import { DEFAULT_UI_SETTINGS, IMAGE_PATH, segmentDelay } from '../src/ui-types.ts'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-ui-'))
  const warn = () => {}
  const data = new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn)
  data.roles.save({ id: 'alice', name: '爱丽丝', description: '', persona: '设定。' }, true)
  return { dir, data, ui: new UiStore(dir, warn) }
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')
const dataUrl = (type: string, bytes: Buffer) => `data:image/${type};base64,${bytes.toString('base64')}`

describe('ui settings', () => {
  it('uses defaults without a file and saves validated settings', () => {
    const { dir, data, ui } = setup()
    expect(uiView(data, ui, undefined).settings).toEqual(DEFAULT_UI_SETTINGS)
    applyUiAction(data, ui, { action: 'settings.save', settings: { ...DEFAULT_UI_SETTINGS, palette: 'green', chatMaxWidth: 1000.4 } })
    expect(new UiStore(dir, () => {}).settings).toMatchObject({ palette: 'green', chatMaxWidth: 1000 })
  })

  it('migrates the old immersive preference and keeps independent switches after reload', () => {
    const { dir, data, ui } = setup()
    const { hideTools, hideCommands, hideStats, hideThinking, ...older } = DEFAULT_UI_SETTINGS
    writeFileSync(join(dir, 'ui.json'), JSON.stringify({ ...older, immersive: false }))
    const migrated = new UiStore(dir, () => {})
    expect(migrated.settings).toMatchObject({ hideTools: false, hideCommands: false, hideStats: false, hideThinking: true })
    applyUiAction(data, ui, { action: 'settings.save', settings: { ...older, immersive: false } })
    expect(ui.settings.hideThinking).toBe(true)
    applyUiAction(data, ui, { action: 'settings.save', settings: { ...migrated.settings, hideTools: true, hideThinking: false } })
    expect(new UiStore(dir, () => {}).settings).toMatchObject({ hideTools: true, hideCommands: false, hideStats: false, hideThinking: false })
  })

  it('rejects invalid settings', () => {
    const { data, ui } = setup()
    expect(() => applyUiAction(data, ui, { action: 'settings.save', settings: { ...DEFAULT_UI_SETTINGS, palette: 'pink' } })).toThrow(BadRequest)
    expect(() => applyUiAction(data, ui, { action: 'settings.save', settings: { ...DEFAULT_UI_SETTINGS, chatMaxWidth: 1601 } })).toThrow('聊天宽度')
    expect(() => applyUiAction(data, ui, { action: 'settings.save', settings: { palette: 'green' } })).toThrow(BadRequest)
  })

  it('retains a background when switching palettes and reactivates it on upload', () => {
    const { dir, data, ui } = setup()
    applyUiAction(data, ui, { action: 'background.set', data: dataUrl('png', PNG) })
    applyUiAction(data, ui, { action: 'settings.save', settings: { ...ui.settings, palette: 'green', backgroundEnabled: false } })
    const reloaded = new UiStore(dir, () => {})
    const version = reloaded.background().find()?.version
    expect(version).toBeTypeOf('number')
    expect(buildQqCss(reloaded.settings, version)).not.toContain('background-image')
    applyUiAction(data, reloaded, { action: 'settings.save', settings: { ...reloaded.settings, backgroundEnabled: true } })
    expect(buildQqCss(reloaded.settings, version)).toContain('kind=background')
    applyUiAction(data, reloaded, { action: 'settings.save', settings: { ...reloaded.settings, backgroundEnabled: false } })
    applyUiAction(data, reloaded, { action: 'background.set', data: dataUrl('jpeg', JPEG) })
    expect(new UiStore(dir, () => {}).settings.backgroundEnabled).toBe(true)
  })

  it('keeps existing backgrounds enabled when reading or saving older settings', () => {
    const { dir, data, ui } = setup()
    const { backgroundEnabled: _enabled, ...older } = DEFAULT_UI_SETTINGS
    writeFileSync(join(dir, 'ui.json'), JSON.stringify(older))
    expect(new UiStore(dir, () => {}).settings.backgroundEnabled).toBe(true)
    applyUiAction(data, ui, { action: 'settings.save', settings: older })
    expect(ui.settings.backgroundEnabled).toBe(true)
    expect(() => applyUiAction(data, ui, { action: 'settings.save', settings: { ...older, backgroundEnabled: 'yes' } })).toThrow(BadRequest)
  })

  it('keeps the valid fields of a hand-edited file', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'ui.json'), JSON.stringify({ palette: 'black', chatMaxWidth: 'wide', bubbleTail: false }))
    expect(new UiStore(dir, () => {}).settings).toEqual({ ...DEFAULT_UI_SETTINGS, palette: 'black', bubbleTail: false })
  })

  it('drops old interval settings when loading and saving', () => {
    const { dir, data } = setup()
    const oldSettings = { ...DEFAULT_UI_SETTINGS, palette: 'black', intervalMethod: 'random', intervalSpeed: 143, intervalMin: 0, intervalMax: 0, logBase: 1.1 }
    writeFileSync(join(dir, 'ui.json'), JSON.stringify(oldSettings))
    const ui = new UiStore(dir, () => {})
    const expected = { ...DEFAULT_UI_SETTINGS, palette: 'black' }
    expect(ui.settings).toEqual(expected)
    applyUiAction(data, ui, { action: 'settings.save', settings: oldSettings })
    expect(JSON.parse(readFileSync(join(dir, 'ui.json'), 'utf8'))).toEqual({ version: 1, ...expected })
  })

  it('defaults a missing typing speed and rejects invalid ones', () => {
    const { dir, data, ui } = setup()
    const { typingSpeed, ...older } = DEFAULT_UI_SETTINGS
    writeFileSync(join(dir, 'ui.json'), JSON.stringify(older))
    expect(new UiStore(dir, () => {}).settings).toEqual(DEFAULT_UI_SETTINGS)
    applyUiAction(data, ui, { action: 'settings.save', settings: { ...older, typingSpeed: 'slow' } })
    expect(ui.settings.typingSpeed).toBe('slow')
    for (const typingSpeed of ['medium', null, 100]) {
      expect(() => applyUiAction(data, ui, { action: 'settings.save', settings: { ...DEFAULT_UI_SETTINGS, typingSpeed } })).toThrow(BadRequest)
    }
    writeFileSync(join(dir, 'ui.json'), JSON.stringify({ ...older, typingSpeed: 'warp' }))
    expect(new UiStore(dir, () => {}).settings).toEqual(DEFAULT_UI_SETTINGS)
  })

  it('reports the session role only when asked', () => {
    const { data, ui } = setup()
    expect(uiView(data, ui, undefined).session).toBeUndefined()
    const roster = [{ id: 'alice', name: '爱丽丝', description: '' }]
    expect(uiView(data, ui, 's1').session).toEqual({ role: null, roster, turns: [] })
    data.bindings.set('s1', 'alice')
    expect(uiView(data, ui, 's1').session).toEqual({ role: { id: 'alice', name: '爱丽丝' }, roster, turns: [] })
  })

  it('sets the role of a session before or after it starts', () => {
    const { data, ui } = setup()
    data.bindings.setDefaultRole('alice')
    // 还没开始的会话选了"不用角色"，默认角色不能接管它。
    applyUiAction(data, ui, { action: 'session.role', session: 'session-1', role: null })
    data.settle({ id: 'session-1' })
    expect(data.bindings.get('session-1')).toBeNull()
    expect(uiView(data, ui, 'session-1').session?.role).toBeNull()
    applyUiAction(data, ui, { action: 'session.role', session: 'session-1', role: 'alice' })
    expect(uiView(data, ui, 'session-1').session?.role).toEqual({ id: 'alice', name: '爱丽丝' })
    expect(() => applyUiAction(data, ui, { action: 'session.role', session: 'session-1', role: 'bob' })).toThrow('不在角色库')
    expect(() => applyUiAction(data, ui, { action: 'session.role', session: '__proto__', role: null })).toThrow(BadRequest)
    expect(() => applyUiAction(data, ui, { action: 'session.role', session: 1, role: null })).toThrow(BadRequest)
    expect(data.bindings.get('session-1')).toBe('alice')
  })

  it('reports the role of each turn, with names read from the library', () => {
    const { data, ui } = setup()
    data.roles.save({ id: 'bob', name: '鲍勃', description: '', persona: '设定。' }, true)
    data.bindings.set('s1', 'alice')
    data.recordTurn({ id: 's1' }, 1)
    data.recordTurn({ id: 's1' }, 2)
    data.bindings.set('s1', 'bob')
    data.recordTurn({ id: 's1' }, 3)
    data.roles.save({ id: 'alice', name: '小爱', description: '', persona: '设定。' }, false)
    expect(uiView(data, ui, 's1').session).toMatchObject({
      role: { id: 'bob', name: '鲍勃' },
      turns: [{ turn: 1, role: { id: 'alice', name: '小爱' } }, { turn: 3, role: { id: 'bob', name: '鲍勃' } }],
    })
    // 删掉的角色在旧轮次上显示为没有角色。
    data.roles.remove('alice')
    expect(uiView(data, ui, 's1').session?.turns[0]).toEqual({ turn: 1, role: null })
  })
})

describe('avatar per turn in the browser', () => {
  it('picks the role recorded for each turn and re-reads on a new turn', async () => {
    const a = { id: 'a', name: '甲' }
    const b = { id: 'b', name: '乙' }
    let session: unknown = { role: b, turns: [{ turn: 2, role: a }, { turn: 4, role: b }] }
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ settings: DEFAULT_UI_SETTINGS, avatars: {}, session }))))
    vi.stubGlobal('fetch', fetch)
    try {
      const state = new UiState()
      expect(state.roleAt('s1', 1)).toBeUndefined()
      await vi.waitFor(() => { expect(state.roleAt('s1', 1)).toEqual(a) })
      // 最早一条之前按最早一条，之后的轮次按最后一条。
      expect([1, 2, 3, 4, 9].map(turn => state.roleAt('s1', turn)?.id)).toEqual(['a', 'a', 'a', 'b', 'b'])
      state.noteTurn('s1', 4)
      session = { role: null, turns: [{ turn: 2, role: a }, { turn: 4, role: b }, { turn: 5, role: null }] }
      state.noteTurn('s1', 5)
      await vi.waitFor(() => { expect(state.roleAt('s1', 5)).toBeNull() })
      expect(state.roleAt('s1', 4)).toEqual(b)
      // 还没有记录的会话按当前角色。
      session = { role: a, turns: [] }
      state.refreshRole('s2')
      await vi.waitFor(() => { expect(state.roleAt('s2', 7)).toEqual(a) })
      state.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sets the role of a session and keeps the answer', async () => {
    const roster = [{ id: 'a', name: '甲', description: '' }]
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { role: string | null }
      const role = body?.role === 'a' ? { id: 'a', name: '甲' } : null
      return Promise.resolve(new Response(JSON.stringify({ settings: DEFAULT_UI_SETTINGS, avatars: {}, session: { role, roster, turns: [] } })))
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const state = new UiState()
      expect(state.session('s1')).toBeUndefined()
      await vi.waitFor(() => { expect(state.session('s1')?.roster).toEqual(roster) })
      await state.setRole('s1', 'a')
      expect(state.session('s1')?.role).toEqual({ id: 'a', name: '甲' })
      expect(fetch).toHaveBeenLastCalledWith('api/qqbot/ui?session=s1', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ action: 'session.role', session: 's1', role: 'a' }),
      }))
      state.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('images', () => {
  it('checks the file signature, not the declared type', () => {
    expect(decodeImage(dataUrl('png', PNG), 1024).type).toBe('png')
    expect(() => decodeImage(dataUrl('png', JPEG), 1024)).toThrow('不符')
    expect(() => decodeImage(dataUrl('svg+xml', PNG), 1024)).toThrow('只支持')
    expect(() => decodeImage(dataUrl('png', PNG), 4)).toThrow('太大')
  })

  it('stores one avatar per role and serves it', async () => {
    const { dir, data, ui } = setup()
    expect(() => applyUiAction(data, ui, { action: 'avatar.set', role: 'bob', data: dataUrl('png', PNG) })).toThrow('不在角色库')
    expect(() => applyUiAction(data, ui, { action: 'avatar.set', role: '../x', data: dataUrl('png', PNG) })).toThrow(BadRequest)
    applyUiAction(data, ui, { action: 'avatar.set', role: 'alice', data: dataUrl('png', PNG) })
    applyUiAction(data, ui, { action: 'avatar.set', role: 'alice', data: dataUrl('jpeg', JPEG) })
    expect(readdirSync(join(dir, 'images', 'avatars'))).toEqual(['alice.jpeg'])
    expect(Object.keys(uiView(data, ui, undefined).avatars)).toEqual(['alice'])

    const response = imageResponse(ui, new Request(`http://x${IMAGE_PATH}?kind=avatar&role=alice&v=1`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG)
    expect(imageResponse(ui, new Request(`http://x${IMAGE_PATH}?kind=avatar&role=bob`)).status).toBe(404)
    expect(imageResponse(ui, new Request(`http://x${IMAGE_PATH}?kind=avatar&role=..%2Fui`)).status).toBe(400)
    expect(imageResponse(ui, new Request(`http://x${IMAGE_PATH}?kind=file`)).status).toBe(400)

    applyUiAction(data, ui, { action: 'avatar.remove', role: 'alice' })
    expect(uiView(data, ui, undefined).avatars).toEqual({})
  })

  it('sets and removes the background', () => {
    const { data, ui } = setup()
    applyUiAction(data, ui, { action: 'background.set', data: dataUrl('jpeg', JPEG) })
    expect(uiView(data, ui, undefined).background).toBeTypeOf('number')
    applyUiAction(data, ui, { action: 'background.remove' })
    expect(uiView(data, ui, undefined).background).toBeUndefined()
  })

  it('moves the avatar to the trash with its role', () => {
    const { dir, data, ui } = setup()
    applyUiAction(data, ui, { action: 'avatar.set', role: 'alice', data: dataUrl('png', PNG) })
    applyLibraryAction(data, { action: 'role.remove', id: 'alice' }, ui)
    expect(existsSync(join(dir, 'images', 'avatars', 'alice.png'))).toBe(false)
    const trash = readdirSync(join(dir, 'roles-trash'))
    expect(trash).toHaveLength(2)
    expect(trash.find(name => name.endsWith('-alice.avatar.png'))).toBeDefined()
  })
})

describe('cropped image output', () => {
  it('makes avatars a fixed square and only shrinks backgrounds', () => {
    expect(outputSize('avatar', 900, 900)).toEqual({ width: 256, height: 256 })
    expect(outputSize('background', 3840, 2160)).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('background', 1000, 3000)).toEqual({ width: 640, height: 1920 })
    expect(outputSize('background', 800, 450)).toEqual({ width: 800, height: 450 })
  })

  it('checks the picked file before cropping', () => {
    const file = (type: string, size: number) => ({ type, size }) as File
    expect(() => { checkImageFile(file('image/png', 1000)) }).not.toThrow()
    expect(() => { checkImageFile(file('image/svg+xml', 1000)) }).toThrow('只支持')
    expect(() => { checkImageFile(file('image/jpeg', 41 * 1024 * 1024)) }).toThrow('太大')
  })
})

describe('segment delay', () => {
  const steady = () => 0.5
  it('simulates typing the next segment: a short pause plus time per character', () => {
    expect(segmentDelay('短句', DEFAULT_UI_SETTINGS, steady)).toBe(496)
    expect(segmentDelay('字'.repeat(10), DEFAULT_UI_SETTINGS, steady)).toBe(1200)
    expect(segmentDelay('one two three', DEFAULT_UI_SETTINGS, steady)).toBe(848)
    expect(segmentDelay('字'.repeat(1000), DEFAULT_UI_SETTINGS, steady)).toBe(4000)
  })

  it('scales by typing speed with its own cap', () => {
    expect(segmentDelay('短句', { typingSpeed: 'fast' }, steady)).toBe(312)
    expect(segmentDelay('短句', { typingSpeed: 'slow' }, steady)).toBe(736)
    expect(segmentDelay('字'.repeat(1000), { typingSpeed: 'fast' }, steady)).toBe(2800)
    expect(segmentDelay('字'.repeat(1000), { typingSpeed: 'slow' }, steady)).toBe(5600)
  })

  it('varies by ±25% and never drops below 300 ms', () => {
    expect(segmentDelay('短句', DEFAULT_UI_SETTINGS, () => 0)).toBe(372)
    expect(segmentDelay('短句', DEFAULT_UI_SETTINGS, () => 1)).toBe(620)
    expect(segmentDelay('好', { typingSpeed: 'fast' }, () => 0)).toBe(300)
    expect(segmentDelay('好的', DEFAULT_UI_SETTINGS, steady)).toBeLessThan(segmentDelay('今天下班以后我们一起去江边看烟花吧', DEFAULT_UI_SETTINGS, steady))
  })
})

describe('qq style', () => {
  it('scopes every rule under [data-qqbot]', () => {
    const css = buildQqCss({ ...DEFAULT_UI_SETTINGS, avatars: true, bubbleTail: true, hideTools: true }, 1)
    // 去掉 @keyframes 块和 @media 外壳，剩下的每条规则的每个选择器都要在 qqbot 节点下。
    const flat = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').replace(/@media[^{]*\{/g, '')
    const selectors = [...flat.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(match => match[1]!.split(','))
      .map(selector => selector.replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean)
    expect(selectors.length).toBeGreaterThan(20)
    for (const selector of selectors) expect(selector).toMatch(/^(?:body\[data-ds-dark-theme\] )?\[data-qqbot\]/)
  })

  it('draws the avatar only on replies that have a role', () => {
    const css = buildQqCss({ ...DEFAULT_UI_SETTINGS, avatars: true }, undefined)
    const before = [...css.matchAll(/([^{}]+)\{[^{}]*--qqbot-initial/g)].map(match => match[1]!.trim())
    expect(before).toHaveLength(1)
    expect(before[0]).toContain('[data-qqbot-reply][data-qqbot-role]')
  })

  it('controls each immersive feature independently', () => {
    const off = { ...DEFAULT_UI_SETTINGS, hideTools: false, hideCommands: false, hideStats: false, hideThinking: false }
    const tools = buildQqCss({ ...off, hideTools: true }, undefined)
    expect(tools).toContain("turn-process'")
    expect(tools).not.toContain("kind='command'")
    expect(tools).not.toContain("[data-clock='end']")
    const commands = buildQqCss({ ...off, hideCommands: true }, undefined)
    expect(commands).toContain("kind='command'")
    expect(commands).not.toContain("turn-process'")
    const thinking = buildQqCss({ ...off, hideThinking: true }, undefined)
    expect(thinking).toContain("[data-chat-running]::after { content: '对方输入中…'")
    expect(thinking).toContain("[data-process-activity='thinking']")
    expect(buildQqCss(off, undefined)).not.toContain('对方输入中…')
  })

  it('follows the switches', () => {
    expect(buildQqCss({ ...DEFAULT_UI_SETTINGS, avatars: false }, undefined)).not.toContain('--qqbot-initial')
    expect(buildQqCss({ ...DEFAULT_UI_SETTINGS, hideTools: false }, undefined)).not.toContain("turn-process'")
    expect(buildQqCss(DEFAULT_UI_SETTINGS, undefined)).not.toContain('background-image')
    expect(buildQqCss(DEFAULT_UI_SETTINGS, 5)).toContain('kind=background&v=5')
    expect(buildQqCss({ ...DEFAULT_UI_SETTINGS, palette: 'green' }, undefined)).toContain('#95EC69')
  })
})
