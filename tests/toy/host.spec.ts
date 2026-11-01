import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as qqbot from '../../src/index.ts'
import { assembleParts, renderRuntime } from '../../src/prompt.ts'
import { describe, expect, it } from 'vitest'
import { STATE_PATH, type ToyView } from '../../src/toy/api-types.ts'
import { defaultMotion } from '../../src/toy/core/config.ts'
import { DEFAULT_PROACTIVITY_TEXTS } from '../../src/toy/core/rules.ts'
import * as toy from '../../src/toy/index.ts'
import { ToyHost } from '../../src/toy/index.ts'
import { defaultSettings } from '../../src/toy/settings.ts'
import { dataDir } from '../../src/toy/storage.ts'

type Route = { path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }

async function mount(withQqbot: boolean) {
  const root = new Context()
  const routes = new Map<string, Route>()
  root.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } })
  const qqbotFiber = withQqbot ? await root.plugin(qqbot.QqbotService) : undefined
  const fiber = await root.plugin(toy)
  const call = async (body?: unknown, query = '') => {
    const init = body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }
    const response = await routes.get(STATE_PATH)!.fetch(new Request(`http://127.0.0.1${STATE_PATH}${query}`, init))
    return { status: response.status, body: await response.json() as ToyView & { error?: string; message?: string } }
  }
  await call({ action: 'module.enable', enabled: true })
  const service = () => (root as unknown as { qqbot: qqbot.QqbotService }).qqbot
  const prompt = (id: string) => assembleParts(service().content, service().store, { id })
  const runtime = (id: string) => renderRuntime(service().store, { id })
  return { root, routes, call, fiber, qqbotFiber, prompt, runtime }
}

const authorized = { ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true }

describe('settings and sessions', () => {
  it('starts unauthorized and refuses to attach until authorized', async () => {
    const { call } = await mount(false)
    const initial = await call(undefined, '?session=s1')
    expect(initial.body.settings.authorized).toBe(false)
    expect(initial.body.qqbot).toBe(false)
    expect(initial.body.session).toMatchObject({ attached: false, rules: '' })
    const refused = await call({ action: 'session.attach', session: 's1', status: 'ready' })
    expect([refused.status, refused.body.message]).toEqual([409, '请先完成首次授权'])
  })

  it('validates input', async () => {
    const { call } = await mount(false)
    expect((await call('{')).status).toBe(400)
    expect((await call({ action: 'nope', session: 's1' })).status).toBe(400)
    expect((await call({ action: 'session.attach', status: 'ready' })).status).toBe(400)
    expect((await call({ action: 'session.attach', session: 's1', status: 'moving' })).status).toBe(400)
    expect((await call({ action: 'settings.save', settings: { ...authorized, motion: { ...defaultMotion(), maxSpeed: 900 } } })).status).toBe(400)
    expect((await call(undefined, `?session=${'x'.repeat(513)}`)).status).toBe(400)
  })

  it('persists settings and keeps sessions in memory only', async () => {
    const { call, fiber } = await mount(false)
    await call({ action: 'settings.save', settings: { ...authorized, resumeHotkey: 'Ctrl+KeyR' } })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    const saved = JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8'))
    expect(saved).toMatchObject({ authorized: true, resumeHotkey: 'Ctrl+KeyR' })
    await fiber.dispose()
    const again = await mount(false)
    const view = await again.call(undefined, '?session=s1')
    expect(view.body.settings.resumeHotkey).toBe('Ctrl+KeyR')
    expect(view.body.session?.attached).toBe(false)
  })

  it('ignores the old default level and always starts sessions in follow mode', () => {
    const dir = join(dataDir(), 'unit-legacy-default')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...authorized, proactivity: 1 }))
    const host = new ToyHost(dir, () => {})
    expect(host.settings.value.authorized).toBe(true)
    expect(host.settings.value).not.toHaveProperty('proactivity')
    host.apply({ action: 'session.attach', session: 's1', status: 'ready' })
    expect(host.sessions.proactivity('s1')).toBe(0)
    host.apply({ action: 'settings.save', settings: { ...authorized, proactivity: 1 } })
    expect(host.sessions.proactivity('s1')).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).not.toHaveProperty('proactivity')
    host.apply({ action: 'session.attach', session: 's2', status: 'ready' })
    expect(host.sessions.proactivity('s2')).toBe(0)
    host.apply({ action: 'session.detach', session: 's1' })
    host.apply({ action: 'session.attach', session: 's1', status: 'ready' })
    expect(host.sessions.proactivity('s1')).toBe(0)
  })

  it('rejects the removed session level override', async () => {
    const { call } = await mount(false)
    await call({ action: 'settings.save', settings: authorized })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    const result = await call({ action: 'session.proactivity', session: 's1', level: 2, confirmed: true })
    expect(result.status).toBe(400)
    expect((await call(undefined, '?session=s1')).body.session).toMatchObject({ proactivity: 0 })
    expect((await call(undefined, '?session=s1')).body.session).not.toHaveProperty('chosen')
  })

  it('stores only the rewritten level texts', async () => {
    const { call } = await mount(false)
    const texts = { follow: DEFAULT_PROACTIVITY_TEXTS.follow, high: '改过的高自主性。' }
    const saved = await call({ action: 'settings.save', settings: { ...authorized, proactivityTexts: texts } })
    expect(saved.body.settings.proactivityTexts).toEqual({ high: '改过的高自主性。' })
    const reset = await call({ action: 'settings.save', settings: { ...authorized, proactivityTexts: { high: DEFAULT_PROACTIVITY_TEXTS.high } } })
    expect(reset.body.settings).not.toHaveProperty('proactivityTexts')
    expect((await call({ action: 'settings.save', settings: { ...authorized, proactivityTexts: { wild: 'x' } } })).status).toBe(400)
    expect((await call({ action: 'settings.save', settings: { ...authorized, proactivityTexts: { high: 'x'.repeat(2001) } } })).status).toBe(400)
  })

  it('detaches every session when authorization is withdrawn', () => {
    const host = new ToyHost(join(dataDir(), 'unit-revoke'), () => {})
    host.apply({ action: 'module.enable', enabled: true })
    host.apply({ action: 'settings.save', settings: authorized })
    host.apply({ action: 'session.attach', session: 's1', status: 'ready' })
    host.apply({ action: 'session.attach', session: 's2', status: 'paused' })
    host.apply({ action: 'settings.save', settings: { ...authorized, authorized: false } })
    expect([host.sessions.status('s1'), host.sessions.status('s2')]).toEqual([undefined, undefined])
  })
})

describe('qqbot registration', () => {
  it('puts rules only into attached qqbot sessions and status into runtime', async () => {
    const { call, root, prompt, runtime } = await mount(true)
    // 明确验证无角色会话，不受 QQbot 首次初始化的默认角色影响。
    const service = (root as unknown as { qqbot: qqbot.QqbotService }).qqbot
    service.content.bindings.set('s1', null)
    expect((await call()).body.qqbot).toBe(true)
    expect(prompt('s1').some(part => part.name === 'qqbot:ext:toy')).toBe(false)
    expect(runtime('s1')).not.toContain('device:')

    await call({ action: 'settings.save', settings: authorized })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    const part = prompt('s1').find(p => p.name === 'qqbot:ext:toy')
    // 测试里没有 loader 条目，来源退回 cordis 插件名；DSH 里装的是包名 dsh-toy-buttplug。
    expect(part?.source).toBe('toy-buttplug')
    expect(part?.text).toContain('设备联动')
    expect(part?.text).not.toContain('自主性：')
    expect(prompt('s2').some(p => p.name === 'qqbot:ext:toy')).toBe(false)
    expect(runtime('s1')).toContain('device: 已连接，可以安排动作')

    // 暂停只改 runtime，规则文本不变（前缀缓存不失效）。
    await call({ action: 'session.status', session: 's1', status: 'paused' })
    expect(prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text).toBe(part?.text)
    expect(runtime('s1')).toContain('device: 用户已暂停')

    // 拖滑条（行程、速度）不改规则。
    await call({ action: 'settings.save', settings: { ...authorized, motion: { ...defaultMotion(), maxPosition: 40, maxSpeed: 200 } } })
    expect(prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text).toBe(part?.text)

    await call({ action: 'session.detach', session: 's1' })
    expect(prompt('s1').some(p => p.name === 'qqbot:ext:toy')).toBe(false)
    expect(runtime('s1')).not.toContain('device:')
  })

  it('uses only the role card level and follows role edits, switches and reattachment', async () => {
    const { call, root, prompt } = await mount(true)
    const service = (root as unknown as { qqbot: qqbot.QqbotService }).qqbot
    const roles = join(process.env['DSH_HOME']!, 'qqbot', 'roles')
    mkdirSync(join(roles, 'calm'), { recursive: true })
    writeFileSync(join(roles, 'calm', 'ROLE.md'), '---\nid: calm\nname: 安静\nproactivity: follow\n---\n\n设定。\n')
    mkdirSync(join(roles, 'free'), { recursive: true })
    writeFileSync(join(roles, 'free', 'ROLE.md'), '---\nid: free\nname: 随性\n---\n\n设定。\n')
    service.content.roles.reload()
    service.content.bindings.set('s1', 'calm')

    await call({ action: 'settings.save', settings: authorized })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    let view = (await call(undefined, '?session=s1')).body.session
    expect(view).toMatchObject({ proactivity: 0, role: { name: '安静', proactivity: 0 } })
    expect(prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text).toContain('自主性：低自主性')

    // 没写档位的角色使用低自主性。
    service.content.bindings.set('s1', 'free')
    view = (await call(undefined, '?session=s1')).body.session
    expect(view).toMatchObject({ proactivity: 0, role: { name: '随性' } })
    expect(view?.role).not.toHaveProperty('proactivity')
    expect(prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text).toContain('自主性：低自主性')

    // 修改角色为中档、高档，下一轮直接使用角色值。
    for (const [key, level, label] of [['situational', 1, '中自主性'], ['high', 2, '高自主性']] as const) {
      writeFileSync(join(roles, 'free', 'ROLE.md'), `---\nid: free\nname: 随性\nproactivity: ${key}\n---\n\n设定。\n`)
      service.content.roles.reload()
      expect((await call(undefined, '?session=s1')).body.session?.proactivity).toBe(level)
      expect(prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text).toContain(`自主性：${label}`)
    }
    await call({ action: 'session.detach', session: 's1' })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    expect((await call(undefined, '?session=s1')).body.session?.proactivity).toBe(2)
    expect((await call(undefined, '?session=s2')).body.session?.proactivity).toBe(0)

    // 无角色时不注入自主性，重新绑定角色时继续取角色值。
    service.content.bindings.set('s1', null)
    const noRole = prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text
    expect(noRole).toContain('设备联动')
    expect(noRole).not.toContain('自主性：')
    expect((await call(undefined, '?session=s1')).body.session?.proactivity).toBe(0)
    service.content.bindings.set('s1', 'free')
    expect(prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text).toContain('自主性：高自主性')
  })

  it('puts the role card preferences into the rules and drops unknown values', async () => {
    const { call, root, prompt } = await mount(true)
    const service = (root as unknown as { qqbot: qqbot.QqbotService }).qqbot
    const roles = join(process.env['DSH_HOME']!, 'qqbot', 'roles')
    mkdirSync(join(roles, 'slow'), { recursive: true })
    writeFileSync(join(roles, 'slow', 'ROLE.md'), '---\nid: slow\nname: 慢慢\nmotionActions: 滑动, 不存在的动作\nmotionRanges: upper\n---\n\n设定。\n')
    service.content.roles.reload()
    service.content.bindings.set('s1', 'slow')

    await call({ action: 'settings.save', settings: authorized })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    const view = (await call(undefined, '?session=s1')).body.session
    expect(view?.role).toEqual({ name: '慢慢', actions: ['滑动'], ranges: ['upper'] })
    const rules = () => prompt('s1').find(p => p.name === 'qqbot:ext:toy')?.text
    expect(rules()).toContain('慢慢偏好动作 滑动，范围 upper；用户没有提出时优先从中选。')

    // 去掉偏好后这一行消失。
    writeFileSync(join(roles, 'slow', 'ROLE.md'), '---\nid: slow\nname: 慢慢\n---\n\n设定。\n')
    service.content.roles.reload()
    expect(rules()).not.toContain('偏好')
  })

  it('uses each role autonomy prompt before legacy defaults without changing other sessions', async () => {
    const { call, root, prompt } = await mount(true)
    const service = (root as unknown as { qqbot: qqbot.QqbotService }).qqbot
    const role = { name: '角色甲', description: '', persona: '设定。', proactivityTexts: { follow: '甲的低档说明。', situational: '' } }
    service.content.roles.save({ ...role, id: 'a' }, true)
    service.content.roles.save({ ...role, id: 'b', name: '角色乙', proactivityTexts: { follow: '乙的低档说明。' } }, true)
    service.content.bindings.set('s1', 'a')
    service.content.bindings.set('s2', 'b')
    await call({ action: 'settings.save', settings: { ...authorized, proactivityTexts: { follow: '旧全局低档。', high: '旧全局高档。' } } })
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    await call({ action: 'session.attach', session: 's2', status: 'ready' })
    const rules = (id: string) => prompt(id).find(p => p.name === 'qqbot:ext:toy')?.text ?? ''
    expect(service.role({ id: 's1' })?.proactivityTexts).toEqual(role.proactivityTexts)
    expect(rules('s1')).toContain('甲的低档说明。')
    expect(rules('s1')).not.toContain('旧全局低档。')
    expect(rules('s2')).toContain('乙的低档说明。')
    expect(rules('s2')).not.toContain('甲的低档说明。')
    expect(rules('s3')).toBe('')
    service.content.roles.save({ ...role, id: 'a', proactivity: 'situational' }, false)
    expect(rules('s1')).toContain('自主性：中自主性。')
    expect(rules('s1')).not.toContain(DEFAULT_PROACTIVITY_TEXTS.situational)
    service.content.roles.save({ ...role, id: 'a', proactivity: 'high' }, false)
    expect(rules('s1')).toContain('旧全局高档。')
    service.content.roles.save({ ...role, id: 'a', proactivity: 'high', proactivityTexts: { high: '新角色高档。' } }, false)
    expect(rules('s1')).toContain('新角色高档。')
    expect(rules('s2')).toContain('乙的低档说明。')
    const defaults = (await call()).body.proactivityDefaults
    expect(defaults).toEqual({ ...DEFAULT_PROACTIVITY_TEXTS, follow: '旧全局低档。', high: '旧全局高档。' })
    service.content.bindings.set('s1', null)
    expect(rules('s1')).not.toContain('自主性：')
    expect(rules('s1')).not.toContain('新角色高档。')
  })

  it('unregisters when either plugin is disposed', async () => {
    const { call, fiber, qqbotFiber, root } = await mount(true)
    const service = (root as unknown as { qqbot: qqbot.QqbotService }).qqbot
    const names = () => service.store.snapshot().extensions.map(e => e.name)
    expect(names()).toEqual(['toy'])
    await fiber.dispose()
    expect(names()).toEqual([])
    expect(service.store.snapshot().runtime.map(r => r.name)).toEqual(['role', 'voice'])
    // 插件重新加载后再次登记；qqbot 停用后本插件照常提供接口，只是不再登记。
    const again = await root.plugin(toy)
    expect(names()).toEqual(['toy'])
    await qqbotFiber!.dispose()
    expect((await call()).body.qqbot).toBe(false)
    await again.dispose()
  })
})
