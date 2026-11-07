import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToyAction } from '../../src/toy/api-types.ts'
import { ToyHost } from '../../src/toy/index.ts'
import { ToyController } from '../../src/toy/client/controller.ts'
import { defaultSettings, parseSettings } from '../../src/toy/settings.ts'
import { FakeClock, flush, MockTransport } from './fakes.ts'

function setup(connected = false) {
  const dir = mkdtempSync(join(tmpdir(), 'toy-promotion-'))
  const host = new ToyHost(dir, () => {})
  host.settings.save({ ...defaultSettings(), authorized: true, ...connected ? { deviceConnected: true } : {} })
  const clock = new FakeClock()
  const transport = new MockTransport(clock)
  transport.setPhase('disconnected')
  const actions: ToyAction[] = []
  let fail = false
  const controller = new ToyController({ kind: 'buttplug', clock, transport: () => transport, api: {
    get: async () => host.view(), beacon() {}, post: async action => {
      actions.push(action)
      if (fail) { fail = false; throw new Error('模拟保存失败') }
      return action.action === 'promotion.open' ? host.openPromotion() : host.view(host.apply(action))
    },
  } })
  return { dir, host, controller, transport, actions, fail: () => { fail = true } }
}

describe('device promotion history', () => {
  it('claims only once across windows and host restarts even with linkage disabled', () => {
    const { dir, host } = setup()
    host.apply({ action: 'module.enable', enabled: false })
    expect(host.openPromotion().showDeviceIntro).toBe(true)
    expect(host.openPromotion().showDeviceIntro).toBe(false)
    expect(new ToyHost(dir, () => {}).openPromotion().showDeviceIntro).toBe(false)
    expect(host.settings.value.enabled).toBe(false)
  })

  it('preserves an introduction already shown by older versions', () => {
    const { host } = setup()
    host.settings.save({ ...host.settings.value, deviceIntroSeen: true })
    expect(host.openPromotion().showDeviceIntro).toBe(false)
    expect(host.settings.value.deviceConnected).toBeUndefined()
  })

  it('persists connection history before attaching, and stale settings cannot clear it', () => {
    const { dir, host } = setup()
    const stale = host.settings.value
    host.apply({ action: 'device.connected' })
    host.apply({ action: 'settings.save', settings: { ...stale, deviceConnected: false, deviceIntroSeen: false, authorized: false } })
    host.apply({ action: 'module.enable', enabled: false })
    host.apply({ action: 'module.enable', enabled: true })
    const reloaded = new ToyHost(dir, () => {})
    expect(reloaded.settings.value).toMatchObject({ deviceConnected: true, deviceIntroSeen: true })
    expect(reloaded.openPromotion().showDeviceIntro).toBe(false)
    expect(reloaded.view('s1').session?.attached).toBe(false)
  })

  it('validates the connection history flag', () => {
    expect(() => parseSettings({ ...defaultSettings(), deviceConnected: 'yes' })).toThrow('设备连接记录无效')
    expect(parseSettings({ ...defaultSettings(), deviceConnected: true }).deviceConnected).toBe(true)
  })

  it('deduplicates simultaneous settings requests and does not show again on reopen', async () => {
    const { controller, actions } = setup()
    const first = controller.openPromotion()
    expect(controller.openPromotion()).toBe(first)
    expect(await first).toBe(true)
    expect(await controller.openPromotion()).toBe(false)
    expect(actions.filter(a => a.action === 'promotion.open')).toHaveLength(2)
    controller.dispose()
  })

  it('can retry if the introduction state could not be written', async () => {
    const { controller, host, fail } = setup()
    fail()
    await expect(controller.openPromotion()).rejects.toThrow('模拟保存失败')
    expect(host.settings.value.deviceIntroSeen).toBeUndefined()
    expect(await controller.openPromotion()).toBe(true)
    controller.dispose()
  })

  it('keeps promotion until a device becomes ready, then hides it before the save completes', async () => {
    const { controller, host, transport } = setup()
    await controller.load()
    transport.setPhase('connecting')
    transport.setPhase('waiting')
    expect(controller.getSnapshot().deviceConnected).toBe(false)
    expect(host.settings.value.deviceConnected).toBeUndefined()
    transport.setPhase('ready')
    expect(controller.getSnapshot().deviceConnected).toBe(true)
    controller.disconnect()
    expect(controller.getSnapshot().deviceConnected).toBe(true)
    expect(await controller.openPromotion()).toBe(false)
    await flush()
    expect(host.settings.value.deviceConnected).toBe(true)
    controller.dispose()
  })

  it('does not treat a resolved server connection without a ready device as success', async () => {
    const { controller, transport, host } = setup()
    await controller.load()
    transport.setPhase('waiting')
    await controller.connect()
    expect(controller.getSnapshot().deviceConnected).toBe(false)
    expect(host.settings.value.deviceConnected).toBeUndefined()
    controller.dispose()
  })

  it('retries a failed connection record on the next load after disconnect', async () => {
    const { controller, transport, host, fail } = setup()
    await controller.load()
    fail()
    transport.setPhase('ready')
    await flush()
    controller.disconnect()
    expect(host.settings.value.deviceConnected).toBeUndefined()
    expect(controller.getSnapshot().deviceConnected).toBe(true)
    await controller.load()
    await flush()
    expect(host.settings.value.deviceConnected).toBe(true)
    controller.dispose()
  })

  it('loads persisted history and hides promotion without connecting', async () => {
    const { controller, transport, actions } = setup(true)
    await controller.load()
    expect(controller.getSnapshot().deviceConnected).toBe(true)
    expect(await controller.openPromotion()).toBe(false)
    expect(transport.state.phase).toBe('disconnected')
    expect(actions).toHaveLength(0)
    controller.dispose()
  })
})
