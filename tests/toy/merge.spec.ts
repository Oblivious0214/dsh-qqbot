import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as qqbot from '../../src/index.ts'
import { assembleParts, renderRuntime } from '../../src/prompt.ts'
import { STATE_PATH, type ToyView } from '../../src/toy/api-types.ts'
import { ToyHost, standaloneToyActive } from '../../src/toy/index.ts'
import { defaultSettings } from '../../src/toy/settings.ts'

type Route = { path: string; fetch(request: Request): Promise<Response> }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function mount(legacy = false) {
  const root = new Context()
  const routes = new Map<string, Route>()
  const entry = { options: { name: 'dsh-toy-buttplug' }, disabled: !legacy }
  root.provide('loader', { entries: () => [entry] })
  root.provide('connection', { fetch: { register(route: Route) {
    if (routes.has(route.path)) throw new Error(`重复路由 ${route.path}`)
    routes.set(route.path, route)
    return () => { routes.delete(route.path) }
  } } })
  const fiber = await root.plugin(qqbot)
  cleanups.push(() => fiber.dispose())
  const call = async (body?: unknown) => {
    const response = await routes.get(STATE_PATH)!.fetch(new Request(`http://localhost${STATE_PATH}?session=s1`,
      body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }))
    return { status: response.status, view: await response.json() as ToyView }
  }
  const prompt = () => assembleParts(root.qqbot.content, root.qqbot.store, { id: 's1' })
  return { root, routes, entry, fiber, call, prompt }
}

describe('single package linkage', () => {
  it('starts enabled and unauthorized with both annotations hidden, including after full cleanup', () => {
    const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'display-default-'))
    const host = new ToyHost(dir, () => {})
    expect(host.settings.value).toMatchObject({ enabled: true, authorized: false, display: { actions: false, countdown: false } })
    host.apply({ action: 'module.enable', enabled: false })
    expect(new ToyHost(dir, () => {}).settings.value.enabled).toBe(false)
    host.reset()
    expect(host.settings.value).toMatchObject({ enabled: true, authorized: false, display: { actions: false, countdown: false } })
  })

  it.each([{ actions: false, countdown: true }, { actions: false, countdown: false }])('preserves independent annotation choices through enable transitions and reload: %j', display => {
    const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'display-enable-'))
    const host = new ToyHost(dir, () => {})
    host.apply({ action: 'module.enable', enabled: true })
    expect(host.settings.value.display).toEqual({ actions: false, countdown: false })
    host.apply({ action: 'settings.save', settings: { ...host.settings.value, display } })
    host.apply({ action: 'settings.save', settings: { ...host.settings.value, hotkey: 'Ctrl+KeyM' } })
    host.apply({ action: 'module.enable', enabled: true })
    expect(host.settings.value.display).toEqual(display)
    expect(new ToyHost(dir, () => {}).settings.value.display).toEqual(display)
    host.apply({ action: 'module.enable', enabled: false })
    expect(host.settings.value.display).toEqual(display)
    host.apply({ action: 'module.enable', enabled: true })
    expect(new ToyHost(dir, () => {}).settings.value.display).toEqual(display)
    expect(host.settings.value.authorized).toBe(false)
    expect(host.view('s1').session?.attached).toBe(false)
  })

  it('remembers the first settings introduction through toggles, stale forms and host reload', () => {
    const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'intro-'))
    const host = new ToyHost(dir, () => {})
    const initial = host.settings.value
    expect(initial.deviceIntroSeen).toBeUndefined()
    host.apply({ action: 'module.enable', enabled: false })
    expect(host.settings.value.deviceIntroSeen).toBeUndefined()
    host.apply({ action: 'module.enable', enabled: true })
    expect(host.settings.value.deviceIntroSeen).toBeUndefined()
    expect(host.openPromotion().showDeviceIntro).toBe(true)
    expect(host.settings.value.deviceIntroSeen).toBe(true)
    host.apply({ action: 'settings.save', settings: initial })
    host.apply({ action: 'module.enable', enabled: false })
    expect(new ToyHost(dir, () => {}).settings.value.deviceIntroSeen).toBe(true)
    expect(host.settings.value.authorized).toBe(false)
  })

  it('authorization does not consume the settings introduction', () => {
    const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'intro-consent-'))
    const host = new ToyHost(dir, () => {})
    host.apply({ action: 'settings.save', settings: { ...host.settings.value, authorized: true } })
    expect(new ToyHost(dir, () => {}).settings.value.deviceIntroSeen).toBeUndefined()
    expect(host.openPromotion().showDeviceIntro).toBe(true)
    expect(new ToyHost(dir, () => {}).settings.value.deviceIntroSeen).toBe(true)
    host.apply({ action: 'settings.save', settings: { ...host.settings.value, authorized: false, deviceIntroSeen: false } })
    expect(host.settings.value.deviceIntroSeen).toBe(true)
  })

  it('waits for the old standalone fiber to finish unloading before claiming its slots', () => {
    const entry = { options: { name: 'dsh-toy-buttplug' }, disabled: true }
    expect(standaloneToyActive([entry])).toBe(false)
    expect(standaloneToyActive([{ ...entry, fiber: { state: 2 } }])).toBe(true)
    expect(standaloneToyActive([{ ...entry, fiber: { state: 5 } }])).toBe(true)
    expect(standaloneToyActive([{ ...entry, fiber: { state: 4 } }])).toBe(false)
    expect(standaloneToyActive([{ ...entry, disabled: false }])).toBe(true)
  })
  it('mounts with QQbot, preserves settings, disables independently and disposes with its parent', async () => {
    const dir = join(process.env['DSH_HOME']!, 'toy-buttplug')
    mkdirSync(dir, { recursive: true })
    const { enabled: _, ...oldSettings } = { ...defaultSettings(), authorized: true, behavior: '用户现有规则', hotkey: 'Ctrl+KeyM' }
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(oldSettings))
    const original = readFileSync(join(dir, 'settings.json'), 'utf8')
    const { root, routes, fiber, call, prompt } = await mount()
    expect((await call()).view.settings).toMatchObject({ enabled: true, authorized: true, behavior: '用户现有规则' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(original)
    expect(prompt().some(p => p.name === 'qqbot:ext:toy')).toBe(false)
    await call({ action: 'session.attach', session: 's1', status: 'ready' })
    expect(prompt().find(p => p.name === 'qqbot:ext:toy')?.text).toContain('用户现有规则')
    expect(renderRuntime(root.qqbot.store, { id: 's1' })).toContain('device:')
    const roleContent = root.qqbot.content
    await call({ action: 'module.enable', enabled: false })
    expect(root.qqbot.content).toBe(roleContent)
    expect(root.qqbot.store.snapshot().extensions).toEqual([])
    expect(renderRuntime(root.qqbot.store, { id: 's1' })).not.toContain('device:')
    expect((await call({ action: 'session.attach', session: 's1', status: 'ready' })).status).toBe(409)
    await call({ action: 'settings.save', settings: { ...oldSettings, enabled: true } })
    expect((await call()).view.settings.enabled).toBe(false)
    await call({ action: 'module.enable', enabled: true })
    expect((await call()).view.session?.attached).toBe(false)
    expect(prompt().some(p => p.name === 'qqbot:ext:toy')).toBe(false)
    await fiber.dispose()
    expect(routes.has(STATE_PATH)).toBe(false)
    expect(root.get('qqbot')).toBeUndefined()
  })

  it('blocks the built-in module when an enabled standalone package is present', async () => {
    const { root, call, prompt, entry } = await mount(true)
    await call({ action: 'module.enable', enabled: true })
    expect((await call()).view.conflict).toContain('旧的独立联动插件')
    expect(root.qqbot.store.snapshot().extensions).toEqual([])
    expect((await call({ action: 'session.attach', session: 's1', status: 'ready' })).status).toBe(409)
    expect(prompt().some(p => p.name === 'qqbot:ext:toy')).toBe(false)
    // 由用户在插件管理停用旧包；内置模块只读，不自行改配置。
    entry.disabled = true
    expect((await call()).view.conflict).toBeUndefined()
    expect(root.qqbot.store.snapshot().extensions.map(p => p.name)).toEqual(['toy'])
  })

  it('wakes every waiting page on disable and settles waits on abort or disposal', async () => {
    const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'watch-'))
    const host = new ToyHost(dir, () => {})
    const revision = host.view(undefined).revision!
    const abort = new AbortController()
    const waits = [host.watch(revision, abort.signal), host.watch(revision, abort.signal)]
    host.apply({ action: 'module.enable', enabled: false })
    await Promise.all(waits)
    expect(new ToyHost(dir, () => {}).view(undefined).settings.enabled).toBe(false)
    const cancelled = host.watch(host.view(undefined).revision!, abort.signal)
    abort.abort()
    await cancelled
    const disposed = host.watch(host.view(undefined).revision!, new AbortController().signal)
    host.dispose()
    await disposed
    expect(host.view(undefined).settings.enabled).toBe(false)
  })
})
