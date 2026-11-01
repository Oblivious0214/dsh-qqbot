import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToyHost } from '../../src/toy/index.ts'
import { DEFAULT_BURST, type ToyAction, type ToySettings } from '../../src/toy/api-types.ts'
import { ToyController, type SegmentHooks } from '../../src/toy/client/controller.ts'
import { SafetyWordInput } from '../../src/toy/client/safety-word-input.ts'
import { DEFAULT_SAFETY_WORDS, parseSafetyWords, slowerSpeed } from '../../src/toy/core/safety-words.ts'
import { RECOMMENDED_HOTKEY } from '../../src/toy/core/hotkey.ts'
import { defaultSettings, parseSettings, SettingsStore } from '../../src/toy/settings.ts'
import { FakeClock, MockTransport, legacyMotion } from './fakes.ts'

const intent = { range: 'middle', tier: 'high', action: '稳定节奏' } as const
const empty = JSON.stringify({ users: [], replies: [], partial: null })

async function setup(patch: Partial<ToySettings> = {}) {
  const host = new ToyHost(mkdtempSync(join(tmpdir(), 'safety-word-')), () => {})
  host.settings.save({ ...defaultSettings(), motion: legacyMotion(), enabled: true, authorized: true, safetyWords: { ...DEFAULT_SAFETY_WORDS, enabled: true }, ...patch })
  const clock = new FakeClock(), transport = new MockTransport(clock)
  const posts: ToyAction[] = []
  const controller = new ToyController({ kind: 'buttplug', transport: () => transport, clock, api: {
    get: async session => host.view(session), beacon() {},
    post: async action => { posts.push(action); return host.view(host.apply(action)) },
  } })
  let hooks!: SegmentHooks
  controller.connectSegments({ register: value => { hooks = value; return () => {} }, pause: () => () => {} })
  await controller.load(); await controller.attach('s1')
  controller.observeInput('s1', empty, '[]')
  const send = (text = '慢一点', requestId = 'one', session = 's1') => controller.observeInput(session, empty, JSON.stringify([{ requestId, text }]))
  const show = (reply = '1:1', motion: unknown = intent, index = 0, hold?: number) => hooks.revealed?.('s1', reply, index, { text: 'x', ...motion === undefined ? {} : { motion } }, hold)
  return { host, controller, clock, transport, hooks, posts, send, show }
}

describe('可选安全词降速', () => {
  it('默认关闭；预设可删空，校验并持久化自定义词句', () => {
    expect(DEFAULT_SAFETY_WORDS.enabled).toBe(false)
    expect(parseSettings(defaultSettings()).safetyWords).toBeUndefined()
    const folder = mkdtempSync(join(tmpdir(), 'safety-settings-'))
    const store = SettingsStore.at(folder, () => {})
    store.save({ ...defaultSettings(), safetyWords: { enabled: true, words: [' 慢些 ', '慢些'] } })
    expect(SettingsStore.at(folder, () => {}).value.safetyWords).toEqual({ enabled: true, words: ['慢些'] })
    expect(parseSafetyWords({ enabled: true, words: [] }).words).toEqual([])
    for (const words of [[''], [42], ['a'.repeat(41)], Array(21).fill('慢')]) expect(() => parseSafetyWords({ enabled: true, words })).toThrow()
  })

  it('高→中、中→低、低档继续降低，极低上限仍不升速', () => {
    const config = legacyMotion()
    expect(slowerSpeed(425, config)).toBe(274)
    expect(slowerSpeed(274, config)).toBe(100)
    expect(slowerSpeed(100, config)).toBe(80)
    expect(slowerSpeed(2, { ...config, maxSpeed: 2, speedBreakpoints: [0, 1] })).toBe(2)
  })

  it('直接降低发包速度，保持行程、轨迹、设置和暂停状态，旧回复不能夺回；新回复恢复 AI', async () => {
    const { controller, clock, transport, send, show, host, posts, hooks } = await setup()
    show()
    await clock.advance(5000)
    const settings = JSON.stringify(host.settings.value), before = transport.moves.length, stops = transport.stops, count = posts.length
    send('请慢一点，太快了')
    expect(controller.getSnapshot()).toMatchObject({ paused: false, moving: true, liveMotion: { speed: 274 } })
    expect(transport.stops).toBe(stops)
    expect(JSON.stringify(host.settings.value)).toBe(settings)
    expect(posts.length).toBe(count)
    show('1:1', { ...intent, tier: 'high' }, 1)
    hooks.ended?.('s1', '1:1', 'failed')
    expect(controller.getSnapshot().moving).toBe(true)
    await clock.advance(3000)
    expect(transport.moves.length).toBeGreaterThan(before)
    for (const move of transport.moves.slice(before)) {
      expect(move.limits.maxSpeed).toBeLessThanOrEqual(274)
      expect(move.position).toBeGreaterThanOrEqual(30)
      expect(move.position).toBeLessThanOrEqual(70)
    }
    show('2:1')
    expect(controller.getSnapshot().liveMotion?.speed).toBe(425)
    expect(controller.getSnapshot().notice).toBe('')
    controller.dispose()
  })

  it('发送回显与落盘去重，同一条含多个词只降一次；后续消息可以再降', async () => {
    const { controller, send, show } = await setup()
    show(); send('慢一点 太快了')
    send('慢一点 太快了')
    controller.observeInput('s1', JSON.stringify({ users: [{ id: 'u1', seq: 4, rpcId: 'one', text: '慢一点 太快了' }], replies: [], partial: null }), '[]')
    expect(controller.getSnapshot().liveMotion?.speed).toBe(274)
    send('慢一点', 'two')
    expect(controller.getSnapshot().liveMotion?.speed).toBe(100)
    controller.dispose()
  })

  it.each([{ safetyWords: { enabled: false, words: ['慢一点'] } }, { safetyWords: { enabled: true, words: [] } }])('关闭或删空不触发', async patch => {
    const { controller, send, show } = await setup(patch)
    show(); send()
    expect(controller.getSnapshot().liveMotion?.speed).toBe(425)
    controller.dispose()
  })

  it('不匹配、其他会话、已暂停、停止时均不启动动作；快捷键继续暂停', async () => {
    const { controller, send, show, transport, clock } = await setup({ hotkey: RECOMMENDED_HOTKEY })
    send(); expect(transport.moves).toHaveLength(0)
    show(); send('普通消息', 'two'); send('慢一点', 'three', 's2')
    expect(controller.getSnapshot().liveMotion?.speed).toBe(425)
    expect(controller.hotkey({ code: 'KeyM', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false })).toBe(true)
    const count = transport.moves.length
    send('慢一点', 'four'); await clock.advance(1000)
    expect(controller.getSnapshot().paused).toBe(true)
    expect(transport.moves).toHaveLength(count)
    controller.dispose()
  })

  it('不延长自动停止；退出重接清除临时降速并保留手调', async () => {
    const { controller, clock, send, show, hooks } = await setup({ motion: { ...legacyMotion(), autoStopSeconds: 10 } })
    controller.setLiveMotion({ speed: 300, bounds: [25, 65] })
    show(); await clock.advance(5000); send()
    expect(controller.getSnapshot().liveMotion).toEqual({ speed: 100, bounds: [25, 65] })
    hooks.revealed?.('s1', '2:1', 0, { text: '继续' }, undefined)
    expect(controller.getSnapshot().liveMotion?.speed).toBe(300)
    send('慢一点', 'two')
    await clock.advance(10000)
    expect(controller.getSnapshot().moving).toBe(false)
    await controller.detach(); await controller.attach('s1'); show('3:1')
    expect(controller.getSnapshot().liveMotion?.speed).toBe(425)
    controller.dispose()
  })

  it.each(['burst', 'aftercare', 'manual'] as const)('程序 %s 也能降速，新 AI 回复接管且不自动进入温存', async mode => {
    const { controller, send, show, transport, clock } = await setup(mode === 'aftercare' ? { burst: { ...DEFAULT_BURST, seconds: 5 } } : {})
    if (mode === 'manual') controller.manual(50)
    else {
      await controller.burst()
      if (mode === 'aftercare') await clock.advance(5001)
    }
    await clock.advance(3000)
    const speed = controller.getSnapshot().liveMotion!.speed
    const stops = transport.stops
    send()
    expect(controller.getSnapshot().liveMotion!.speed).toBeLessThan(speed)
    expect(controller.getSnapshot().phase).toBeUndefined()
    expect(transport.stops).toBe(stops)
    const before = transport.moves.length
    await clock.advance(3000)
    const lowered = controller.getSnapshot().liveMotion!.speed
    expect(transport.moves.slice(before).every(move => move.limits.maxSpeed <= lowered)).toBe(true)
    show('2:1')
    expect(controller.getSnapshot().mode).toBe('ai')
    expect(controller.getSnapshot().liveMotion?.speed).toBe(425)
    controller.dispose()
  })

  it('程序动作在新回复无 motion 时也交还控制，不先启动旧动作', async () => {
    const { controller, hooks, send, transport, clock } = await setup()
    await controller.burst(); await clock.advance(2000); send()
    const count = transport.moves.length
    hooks.revealed?.('s1', 'new', 0, { text: '只有文字' }, undefined)
    await clock.advance(1000)
    expect(controller.getSnapshot().mode).toBe('ai')
    expect(controller.getSnapshot().moving).toBe(false)
    expect(transport.moves).toHaveLength(count)
    controller.dispose()
  })

  it('临时降速仍允许暂停和恢复；新回复的部分 motion 按原 AI 选择补全', async () => {
    const { controller, show, send } = await setup()
    show(); send(); controller.pause(); controller.resume()
    expect(controller.getSnapshot().liveMotion?.speed).toBe(274)
    show('2:1', { tier: 'medium' })
    expect(controller.getSnapshot().liveMotion).toEqual({ bounds: [30, 70], speed: 275 })
    controller.dispose()
  })
})

describe('安全词输入观察', () => {
  it('历史只建基线，翻页、重复渲染和候选都不触发；发送与落盘只触发一次', () => {
    const input = new SafetyWordInput(), send = vi.fn()
    const chat = JSON.stringify({ users: [{ id: 'old', seq: 4, text: '慢一点' }], replies: [{ turn: 1, step: 1, seq: 5 }], partial: { turn: 2, step: 1 } })
    input.observe(chat, '[]', send)
    input.observe(chat, '[]', send)
    expect(send).not.toHaveBeenCalled()
    input.observe(chat, JSON.stringify([{ requestId: 'one', text: '慢一点' }]), send)
    expect(send).toHaveBeenCalledExactlyOnceWith('慢一点', ['1:1', '2:1'])
    input.observe(JSON.stringify({ ...JSON.parse(chat), users: [{ id: 'older', seq: 1, text: '慢一点' }, { id: 'new', seq: 7, rpcId: 'one', text: '慢一点' }] }), '[]', send)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
