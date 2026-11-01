import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ToyAction, ToySettings, ToyView } from '../../src/toy/api-types.ts'
import type { ToyApi } from '../../src/toy/client/api.ts'
import { ToyController, type QqbotSegments, type SegmentHooks, type SegmentStage } from '../../src/toy/client/controller.ts'
import { defaultMotion } from '../../src/toy/core/config.ts'
import { hotkeyFromEvent, matchesHotkey, validHotkey, type KeyLike } from '../../src/toy/core/hotkey.ts'
import type { Intent } from '../../src/toy/core/intent.ts'
import { LAST_STAGE_STOP_MS } from '../../src/toy/core/safety.ts'
import { linkageStatus } from '../../src/toy/client/status.ts'
import { BadRequest, ToyHost } from '../../src/toy/index.ts'
import { defaultSettings } from '../../src/toy/settings.ts'
import { FakeClock, flush, MockTransport } from './fakes.ts'
// dsh-qqbot 的显示时钟源码（测试用，插件运行时不引用它）。
import { ReplyClock } from '../../src/client/reply-clock.ts'
import { parseTimedReply } from '../../src/vendor/dialogue-timing/protocol.js'

const full: Intent = { range: 'full', tier: 'low', action: '稳定节奏' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 直接调真实的 ToyHost，和 HTTP 路由做同样的事。 */
class HostApi implements ToyApi {
  readonly host = new ToyHost(mkdtempSync(join(tmpdir(), 'toy-controller-')), () => {})
  readonly beacons: ToyAction[] = []
  async get(session?: string): Promise<ToyView> { return this.host.view(session) }
  async post(action: ToyAction): Promise<ToyView> {
    try {
      return this.host.view(this.host.apply(action))
    } catch (error) {
      throw error instanceof BadRequest ? new Error(`bad request: ${error.message}`) : error
    }
  }
  beacon(action: ToyAction): void { this.beacons.push(action); void this.post(action).catch(() => {}) }
}

class FakeSegments implements QqbotSegments {
  hooks: SegmentHooks | undefined
  pauses = 0
  register(hooks: SegmentHooks) { this.hooks = hooks; return () => { this.hooks = undefined } }
  pause() { this.pauses++; let done = false; return () => { if (!done) { done = true; this.pauses-- } } }
  /** 模拟 qqbot 时钟依次显示一条回复的段落。 */
  show(session: string, reply: string, stages: SegmentStage[], from = 0, to = stages.length) {
    const holds: (number | undefined)[] = []
    for (let i = from; i < to; i++) {
      const hold = this.hooks?.durations?.(session, reply, stages, i) ?? 1000
      holds.push(hold)
      this.hooks?.revealed?.(session, reply, i, stages[i]!, i === stages.length - 1 ? undefined : hold)
    }
    return holds
  }
}

// 运动时段落节奏固定 1 秒，保护倒计时类用例沿用原时序；运动节奏单独测。
const settings = (patch: Partial<ToySettings> = {}): ToySettings => ({ ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true, pacing: { seconds: 1 }, ...patch })

async function setup(patch: Partial<ToySettings> = {}) {
  const clock = new FakeClock()
  const transport = new MockTransport(clock)
  const api = new HostApi()
  api.host.settings.save(settings(patch))
  const controller = new ToyController({ api, kind: 'buttplug', transport: () => transport, clock })
  const segments = new FakeSegments()
  controller.connectSegments(segments)
  await controller.load()
  return { clock, transport, api, controller, segments }
}

describe('toy controller: attach and segments', () => {
  it('distinguishes connection, attachment, absent/invalid actions and protection in the sidebar', async () => {
    const { controller, segments, clock, transport } = await setup()
    // 此夹具没有登记服务，显示断言中补上已存在的 QQbot host。
    const status = (session = 's1') => linkageStatus({ ...controller.getSnapshot(), qqbot: true }, session)
    expect(status().label).toBe('未接入对话')
    transport.setPhase('waiting')
    expect(status().label).toBe('等待位移设备')
    transport.setPhase('ready')
    await controller.attach('s1')
    expect(status().label).toBe('等待动作')
    segments.show('s1', 'none', [{ text: '只有文字' }])
    expect(status().label).toBe('未收到动作')
    segments.show('s1', 'bad', [{ text: 'a', motion: { range: 'full' } }])
    expect(status().label).toBe('动作无效')
    expect(status('s2').detail).not.toContain('无效')
    segments.show('s1', 'good', [{ text: 'b', motion: full }])
    await clock.advance(1)
    expect(status().label).toBe('运行中')
    controller.pause()
    expect(status().label).toBe('已暂停')
    controller.resume()
    await clock.advance(LAST_STAGE_STOP_MS)
    expect(status().label).toBe('保护停止')
    expect(status().detail).toContain('30 秒')
    const count = transport.moves.length
    await clock.advance(LAST_STAGE_STOP_MS)
    expect(transport.moves).toHaveLength(count)
    segments.show('s1', 'stop', [{ text: '停', motion: { stop: true } }])
    expect(status().label).toBe('AI 已停止')
    controller.dispose()
  })

  it('does not replay a streamed stage when completion arrives after protection stopped it', async () => {
    const { controller, clock, transport } = await setup()
    const real = new ReplyClock({ delay: () => 1000, onChange() {}, onError(error) { throw error }, timers: clock })
    controller.connectSegments(real)
    await controller.attach('s1')
    const stages = [{ text: 'a', motion: full }]
    real.feed('s1', 'stream', stages, false, true)
    await clock.advance(6100)
    expect(controller.getSnapshot().moving).toBe(false)
    const count = transport.moves.length
    real.feed('s1', 'stream', stages, true, true)
    await clock.advance(100)
    expect(controller.getSnapshot().moving).toBe(false)
    expect(transport.moves).toHaveLength(count)
    controller.dispose()
    real.dispose()
  })

  it('clears the previous error notice after a valid action in a new reply', async () => {
    const { controller, segments, clock } = await setup()
    await controller.attach('s1')
    segments.show('s1', 'bad', [{ text: 'a', motion: { range: 'full' } }])
    expect(controller.getSnapshot().notice).toContain('无效')
    segments.show('s1', 'good', [{ text: 'b', motion: full }])
    await clock.advance(1)
    expect(controller.getSnapshot().moving).toBe(true)
    expect(controller.getSnapshot().notice).toBe('')
    controller.dispose()
  })

  it('reads sidebar state without renewing the watchdog or exposing another session', async () => {
    const { controller, segments, transport, clock } = await setup()
    expect(controller.livePlayback('s1')).toBeUndefined()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    await clock.advance(1000)
    const moves = transport.moves.length
    for (let i = 0; i < 100; i++) {
      expect(controller.livePlayback('s1')).toMatchObject({ remainingMs: 29000, tail: true })
      expect(controller.livePlayback('s2')).toBeUndefined()
    }
    expect(transport.moves.length).toBe(moves)
    controller.pause()
    await clock.advance(5000)
    expect(controller.livePlayback('s1')?.remainingMs).toBe(29000)
    controller.resume()
    await clock.advance(29000)
    expect(controller.livePlayback('s1')).toMatchObject({ action: '停止', remainingMs: undefined })
    await controller.detach()
    expect(controller.livePlayback('s1')).toBeUndefined()
    controller.dispose()
  })
  it('keeps resolved annotations and freezes the existing tail watchdog without display side effects', async () => {
    const { controller, segments, transport, clock, api } = await setup()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    segments.hooks?.ended?.('s1', '1:1', 'complete')
    const label = controller.stageAction('s1', '1:1', 0)
    expect(label).toContain('全程 0–100')
    await clock.advance(1000)
    expect(controller.tailPlayback('s1', '1:1', 0)?.remainingMs).toBe(LAST_STAGE_STOP_MS - 1000)
    const movingStops = transport.stops, rules = api.host.sessions.rules('s1')
    await controller.saveSettings({ ...controller.getSnapshot().settings!, display: { actions: true, countdown: false } })
    expect(transport.stops).toBe(movingStops)
    expect(controller.getSnapshot().moving).toBe(true)
    expect(controller.tailPlayback('s1', '1:1', 0)?.remainingMs).toBe(LAST_STAGE_STOP_MS - 1000)
    expect(api.host.sessions.rules('s1')).toBe(rules)
    controller.pause()
    await clock.advance(10000)
    expect(controller.tailPlayback('s1', '1:1', 0)).toEqual({ remainingMs: LAST_STAGE_STOP_MS - 1000, paused: true })
    const moves = transport.moves.length, stops = transport.stops
    await controller.saveSettings({ ...controller.getSnapshot().settings!, display: { actions: false, countdown: false } })
    for (let i = 0; i < 100; i++) { controller.stageAction('s1', '1:1', 0); controller.tailPlayback('s1', '1:1', 0) }
    expect([transport.moves.length, transport.stops]).toEqual([moves, stops])
    controller.resume()
    await clock.advance(LAST_STAGE_STOP_MS - 1000)
    expect(controller.tailPlayback('s1', '1:1', 0)).toBeUndefined()
    expect(controller.stageAction('s1', '1:1', 0)).toBe(label)
    segments.show('s1', '2:1', [{ text: 'b', motion: { tier: 'medium' } }])
    expect(controller.stageAction('s1', '2:1', 0)).toContain('全程 0–100 · 中速')
    expect(controller.stageAction('other', '2:1', 0)).toBeUndefined()
    controller.dispose()
  })
  it('drives only the attached session, stage by stage', async () => {
    const { controller, segments, api, transport, clock } = await setup()
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    expect(controller.getSnapshot().moving).toBe(false)

    await controller.attach('s1')
    expect(api.host.sessions.status('s1')).toBe('ready')
    expect(controller.getSnapshot().owner).toBe('s1')

    segments.show('s2', '2:1', [{ text: 'other', motion: full }])
    expect(controller.getSnapshot().moving).toBe(false)

    segments.show('s1', '2:1', [{ text: 'a', motion: full }, { text: 'b' }, { text: 'c', motion: { tier: 'medium' } }])
    await clock.advance(50)
    expect(transport.moves.length).toBeGreaterThan(0)
    // 第三段只写了变化项，补全成 full + medium + steady。
    expect((controller as unknown as { player: { intent: Intent } }).player.intent).toEqual({ ...full, tier: 'medium' })
  })

  it('continues the previous selection when a new reply starts without motion, and stops on stop', async () => {
    const { controller, segments } = await setup()
    await controller.attach('s1')
    const player = () => (controller as unknown as { player: { intent: Intent | null } }).player
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    segments.show('s1', '2:1', [{ text: 'b' }, { text: 'c', motion: { stop: true } }], 0, 1)
    expect(player().intent).toEqual(full)
    segments.show('s1', '2:1', [{ text: 'b' }, { text: 'c', motion: { stop: true } }], 1)
    expect(player().intent).toBeNull()
    // 停止之后，新回复第一段不写 motion 时不再沿用。
    segments.show('s1', '3:1', [{ text: 'd' }])
    expect(player().intent).toBeNull()
  })

  it('holds new motion for the full tempo, continuation only for reading time, and leaves idle replies to qqbot', async () => {
    const { controller, segments } = await setup({ pacing: { seconds: 9 } })
    await controller.attach('s1')
    expect(segments.show('s1', '1:1', [{ text: '聊天' }, { text: '还是聊天' }])).toEqual([1000, 1000])
    expect(segments.show('s1', '2:1', [{ text: 'a', motion: full }, { text: 'b' }, { text: '字'.repeat(30) }, { text: '字'.repeat(90) }, { text: 'c', motion: { stop: true } }, { text: 'd' }]))
      .toEqual([9000, 2000, 5000, 9000, 1000, 1000])
    // 新回复第一段没写 motion 时沿用上一条的动作，按接续段计时。
    segments.show('s1', '3:1', [{ text: 'a', motion: full }])
    expect(segments.show('s1', '4:1', [{ text: '继续' }, { text: '再继续', motion: { tier: 'medium' } }])).toEqual([2000, 9000])
    controller.dispose()
  })

  it('uses the 5 second interval by default and treats old min/max settings as default', async () => {
    for (const pacing of [undefined, { min: 5, max: 20, speed: 143 } as never]) {
      const { controller, segments } = await setup({ pacing })
      await controller.attach('s1')
      expect(segments.show('s1', '1:1', [{ text: '短', motion: full }, { text: '短' }])).toEqual([5000, 2000])
      controller.dispose()
    }
  })

  it('persists a custom sidebar interval across detaching, reloading and controller recreation', async () => {
    const { controller, segments, api, clock, transport } = await setup({ pacing: { seconds: 8 } })
    await controller.setPacing(7)
    expect(controller.getSnapshot().owner).toBeUndefined()
    expect(transport.moves).toHaveLength(0)
    await controller.attach('s1')
    expect(controller.getSnapshot().pacing).toEqual({ seconds: 7 })
    await controller.setPacing(15)
    expect(controller.getSnapshot().settings?.pacing).toEqual({ seconds: 15 })
    expect(segments.show('s1', '1:1', [{ text: 'a', motion: full }, { text: '字'.repeat(300) }])).toEqual([15000, 15000])
    await controller.detach()
    await controller.load()
    expect(controller.getSnapshot().pacing).toEqual({ seconds: 15 })
    controller.dispose()
    const reopened = new ToyController({ api, clock, kind: 'buttplug', transport: () => transport })
    await reopened.load()
    expect(reopened.getSnapshot().pacing).toEqual({ seconds: 15 })
    reopened.dispose()
  })

  it('keeps the saved interval after invalid input or a failed save and allows retry', async () => {
    const { controller, api } = await setup({ pacing: { seconds: 7 } })
    const post = vi.spyOn(api, 'post')
    await expect(controller.setPacing(0)).rejects.toThrow('整数秒')
    expect(post).not.toHaveBeenCalled()
    post.mockRejectedValueOnce(new Error('offline'))
    await expect(controller.setPacing(12)).rejects.toThrow('offline')
    expect(controller.getSnapshot().pacing).toEqual({ seconds: 7 })
    await controller.setPacing(12)
    expect(controller.getSnapshot().pacing).toEqual({ seconds: 12 })
    controller.dispose()
  })

  it('changes the next interval without interrupting motion or losing a concurrent setting', async () => {
    const { controller, api, segments, transport, clock } = await setup({ pacing: { seconds: 9 } })
    await controller.attach('s1')
    const stages = [{ text: 'a', motion: full }, { text: '字'.repeat(300) }]
    segments.show('s1', '1:1', stages, 0, 1)
    await clock.advance(1)
    const stops = transport.stops
    const rules = api.host.sessions.rules('s1')
    await Promise.all([
      controller.setPacing(11),
      controller.updateSettings(latest => ({ ...latest, display: { actions: false, countdown: false } })),
    ])
    expect(controller.getSnapshot().settings).toMatchObject({ pacing: { seconds: 11 }, display: { actions: false, countdown: false } })
    expect(controller.getSnapshot().moving).toBe(true)
    expect(transport.stops).toBe(stops)
    expect(api.host.sessions.rules('s1')).toBe(rules)
    expect(segments.hooks?.durations?.('s1', '1:1', stages, 1)).toBe(11000)
    controller.dispose()
  })

  it('keeps moving when the model writes a duration inside motion', async () => {
    const { controller, segments, clock } = await setup()
    await controller.attach('s1')
    for (const [reply, extra] of [['1:1', { cycles: 4 }], ['2:1', { seconds: 20 }]] as const) {
      const text = `[qq]${JSON.stringify({ version: 1, stages: [{ text: 'a', motion: { ...full, ...extra } }, { text: 'b' }] })}[/qq]`
      const stages = parseTimedReply(text)!.stages
      expect(stages[0]).toEqual({ text: 'a', motion: full })
      expect(segments.show('s1', reply, stages, 0, 1)[0]).toBe(1000)
      await clock.advance(1)
      expect(controller.getSnapshot().moving).toBe(true)
      expect(controller.getSnapshot().notice).toBe('')
    }
    controller.dispose()
  })

  it('stops on an invalid motion and executes a later valid action in the same reply', async () => {
    const { controller, segments, clock, transport } = await setup()
    await controller.attach('s1')
    const stages = [{ text: 'a', motion: { range: 'full' } }, { text: 'b', motion: full }]
    segments.show('s1', '1:1', stages, 0, 1)
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().notice).toContain('动作无效')
    segments.show('s1', '1:1', stages, 1)
    await clock.advance(1)
    expect(controller.getSnapshot().moving).toBe(true)
    expect(controller.getSnapshot().notice).toBe('')
    expect(transport.moves.length).toBeGreaterThan(0)
    controller.dispose()
  })

  it('stops when a reply turns out malformed: salvaged stages or a failed end', async () => {
    const { controller, segments } = await setup()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }, { text: 'b', salvaged: true }])
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().notice).toContain('格式有误')

    segments.show('s1', '2:1', [{ text: 'c', motion: full }])
    expect(controller.getSnapshot().moving).toBe(true)
    segments.hooks?.ended?.('s1', '2:1', 'failed')
    expect(controller.getSnapshot().moving).toBe(false)

    // 完整结束、被打断不停；没显示过段落的回复以 failed 结束也不停。
    segments.show('s1', '3:1', [{ text: 'd', motion: full }])
    segments.hooks?.ended?.('s1', '3:1', 'complete')
    segments.hooks?.ended?.('s1', '4:1', 'failed')
    expect(controller.getSnapshot().moving).toBe(true)
  })

  it('recovers after a salvaged stage without inheriting an earlier action or replaying duplicate stages', async () => {
    const { controller, segments, clock, transport } = await setup()
    await controller.attach('s1')
    const stages: SegmentStage[] = [
      { text: '先运动', motion: full },
      { text: '抢救文字', salvaged: true },
      { text: '仅改档位', motion: { tier: 'medium' } },
      { text: '只有文字' },
      { text: '完整动作', motion: full },
    ]
    segments.show('s1', 'reply', stages, 0, 1)
    await clock.advance(1)
    segments.show('s1', 'reply', stages, 1, 2)
    expect(controller.getSnapshot().activity).toBe('invalid')
    expect(controller.getSnapshot().moving).toBe(false)
    segments.show('s1', 'reply', stages, 2, 4)
    expect(controller.getSnapshot().moving).toBe(false)
    const count = transport.moves.length
    await clock.advance(100)
    expect(transport.moves).toHaveLength(count)
    segments.show('s1', 'reply', stages, 4)
    await clock.advance(1)
    expect(transport.moves.length).toBeGreaterThan(count)
    expect(controller.getSnapshot().notice).toBe('')
    // 已处理的错误段迟到重复，不能停止后来已经生效的有效段。
    segments.hooks?.revealed?.('s1', 'reply', 1, stages[1]!, undefined)
    expect(controller.getSnapshot().moving).toBe(true)
    await clock.advance(LAST_STAGE_STOP_MS)
    expect(controller.getSnapshot().activity).toBe('timeout')
    controller.dispose()
  })

  it('stops when the qqbot segment clock goes away', async () => {
    const clock = new FakeClock()
    const transport = new MockTransport(clock)
    const api = new HostApi()
    api.host.settings.save(settings())
    const controller = new ToyController({ api, kind: 'buttplug', transport: () => transport, clock })
    const segments = new FakeSegments()
    const disconnect = controller.connectSegments(segments)
    await controller.load()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    expect(controller.getSnapshot().moving).toBe(true)
    disconnect()
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().segments).toBe(false)
  })

  it('lets one device drive one session: attaching elsewhere detaches the first', async () => {
    const { controller, api } = await setup()
    await controller.attach('s1')
    await controller.attach('s2')
    expect(api.host.sessions.status('s1')).toBeUndefined()
    expect(api.host.sessions.status('s2')).toBe('ready')
  })

  it('requires a ready device and uses user limits without intersecting device reports', async () => {
    const { controller, transport, segments, clock } = await setup()
    transport.setPhase('disconnected')
    await expect(controller.attach('s1')).rejects.toThrow('请先连接设备')
    transport.state = { ...transport.state, phase: 'ready', hardware: { minPosition: 80, maxPosition: 100, maxSpeed: 300 } }
    transport.setPhase('ready')
    await controller.saveSettings(settings({ motion: { ...defaultMotion(), maxPosition: 50 } }))
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    await clock.advance(100)
    expect(controller.getSnapshot().moving).toBe(true)
    expect(transport.moves[0]?.limits).toMatchObject({ minPosition: 0, maxPosition: 50 })
    // 机内报告变化不重新裁剪用户范围，也不在控制层触发停止。
    const stops = transport.stops
    transport.state = { ...transport.state, hardware: { minPosition: 90, maxPosition: 100, maxSpeed: 200 } }
    transport.setPhase('ready')
    expect(transport.stops).toBe(stops)
    expect(controller.getSnapshot().moving).toBe(true)
    controller.dispose()
  })
})

describe('toy controller: attach notice', () => {
  it('attaches without a redundant success notice and has no session level override', async () => {
    const { controller, api } = await setup()
    await controller.attach('s1')
    expect(controller.getSnapshot().notice).toBe('')
    expect(controller.getSnapshot().ownerView).toMatchObject({ proactivity: 0 })
    expect(controller.getSnapshot().ownerView).not.toHaveProperty('chosen')
    expect(api.host.sessions.rules('s1')).not.toContain('自主性：')
  })
})

describe('precise interruption reasons', () => {
  it('identifies a reply interrupted by new input without falsely claiming an immediate device stop', async () => {
    const { controller, clock } = await setup()
    const reply = new ReplyClock({ delay: () => 1000, onChange() {}, onError(error) { throw error }, timers: clock })
    controller.connectSegments(reply)
    await controller.attach('s1')
    reply.feed('s1', 'r', [{ text: 'a', motion: full }, { text: 'b' }], true, true)
    await clock.advance(0)
    reply.interrupt('s1')
    expect(controller.getSnapshot().moving).toBe(true)
    expect(linkageStatus({ ...controller.getSnapshot(), qqbot: true }, 's1').detail).toContain('不会因此立即停止')
    await clock.advance(6000)
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.lastInterruption('s1')).toContain('剩余段落已被新消息打断')
    expect(controller.lastInterruption('s1')).toContain('已自动停止')
    controller.dispose()
    reply.dispose()
  })

  it('restores the page-exit reason after reload and tolerates unavailable tab storage', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
    const { controller } = await setup()
    try {
      await controller.attach('s1')
      controller.pagehide()
      const next = await setup()
      expect(next.controller.lastInterruption('s1')).toContain('页面正在关闭或刷新')
      expect(next.controller.lastInterruption('s2')).toBeUndefined()
      vi.stubGlobal('sessionStorage', { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } })
      await next.controller.attach('s2')
      expect(() => next.controller.pause()).not.toThrow()
      expect(next.controller.lastInterruption('s2')).toContain('暂停按钮')
      next.controller.dispose()
    } finally { controller.dispose(); vi.unstubAllGlobals() }
  })

  it('does not replace user cancellation with a late connection error', async () => {
    const { controller, transport } = await setup()
    const pending = deferred<typeof transport.state>()
    transport.connect = () => { transport.setPhase('connecting'); return pending.promise }
    const connecting = controller.connect()
    controller.disconnect()
    pending.reject(new Error('连接已关闭'))
    await connecting
    expect(controller.getSnapshot().notice).toContain('用户取消了设备连接')
    controller.dispose()
  })

  it('reports runtime send failures against the current stage and keeps parameter-update reasons', async () => {
    const { controller, segments, transport, clock } = await setup()
    await controller.attach('s1')
    segments.show('s1', 'r', [{ text: 'a', motion: full }])
    await clock.advance(1)
    await controller.saveSettings(settings({ motion: { ...defaultMotion(), maxPosition: 50 } }))
    expect(controller.lastInterruption('s1')).toContain('运动参数已更新')
    transport.fail = new Error('模拟发送失败')
    segments.show('s1', 'next', [{ text: 'a' }, { text: 'b', motion: { ...full, tier: 'medium' } }])
    await clock.advance(2000)
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.lastInterruption('s1')).toContain('第 2 段动作执行已中断：模拟发送失败')
    controller.dispose()
  })

  it('keeps stage error and timeout reasons through text-only stages, with session-local history', async () => {
    const { controller, segments, clock } = await setup()
    await controller.attach('s1')
    const stages = [{ text: 'a', motion: full }, { text: 'bad', motion: { tier: 'oops' } }, { text: 'text' }, { text: 'recover', motion: full }]
    segments.show('s1', 'r', stages, 0, 3)
    expect(controller.getSnapshot().activity).toBe('invalid')
    expect(controller.getSnapshot().notice).toContain('第 2 段')
    expect(controller.getSnapshot().notice).toContain('后续完整有效动作仍可执行')
    const reason = controller.lastInterruption('s1')
    expect(controller.lastInterruption('other')).toBeUndefined()
    segments.show('s1', 'r', stages, 3)
    expect(controller.getSnapshot().moving).toBe(true)
    expect(controller.getSnapshot().notice).toBe('')
    expect(controller.lastInterruption('s1')).toBe(reason)
    await clock.advance(LAST_STAGE_STOP_MS)
    expect(controller.lastInterruption('s1')).toContain('第 4 段为末段')
    expect(controller.lastInterruption('s1')).toContain('30 秒')
    segments.show('s1', 'next', [{ text: 'a', motion: full }, { text: 'b' }], 0, 1)
    await clock.advance(6000)
    expect(controller.lastInterruption('s1')).toContain('预计间隔 1.0 秒加 5 秒')
    controller.dispose()
  })

  it('distinguishes button, hotkey, model stop, manual disconnect, transfer and detach', async () => {
    const { controller, segments } = await setup({ hotkey: 'Ctrl+KeyM' })
    await controller.attach('s1')
    controller.pause()
    expect(controller.lastInterruption('s1')).toContain('暂停按钮')
    controller.resume()
    controller.hotkey({ code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })
    expect(controller.lastInterruption('s1')).toContain('暂停快捷键')
    controller.resume()
    segments.show('s1', 'stop', [{ text: 'a', motion: full }, { text: 'b', motion: { stop: true } }])
    expect(controller.lastInterruption('s1')).toContain('AI 在第 2 段要求停止')
    await controller.attach('s2')
    expect(controller.lastInterruption('s1')).toContain('转交另一个对话')
    expect(controller.lastInterruption('s2')).toBeUndefined()
    await controller.detach()
    expect(controller.lastInterruption('s2')).toContain('用户退出')
    expect(linkageStatus({ ...controller.getSnapshot(), qqbot: true }, 's1').detail).not.toContain('用户退出')
    await controller.attach('s2')
    controller.disconnect()
    expect(controller.lastInterruption('s2')).toContain('用户主动断开')
    controller.dispose()
  })

  it('distinguishes backend reset, revocation, remote disable and conflicts', async () => {
    for (const mode of ['reset', 'revoked', 'disabled', 'conflict'] as const) {
      const { controller, api } = await setup()
      await controller.attach('s1')
      const view = await api.get('s1')
      api.get = async () => ({ ...view, controlEpoch: 'changed',
        settings: { ...view.settings, authorized: mode !== 'revoked', enabled: mode !== 'disabled' },
        ...(mode === 'conflict' ? { conflict: '请停用旧插件' } : {}),
      })
      await controller.load()
      expect(controller.getSnapshot().owner).toBeUndefined()
      expect(controller.lastInterruption('s1')).toContain({ reset: '后台控制状态已重置', revoked: '授权已撤回', disabled: '总开关已关闭', conflict: '旧独立联动插件冲突' }[mode])
      controller.dispose()
    }
  })

  it('retains the sync-loss cause after settings synchronization recovers', async () => {
    vi.useFakeTimers()
    const { controller, api } = await setup()
    try {
      await controller.attach('s1')
      let calls = 0
      ;(api as ToyApi).watch = async (_revision, signal) => {
        calls++
        if (calls === 1) { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error }
        if (calls > 2) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return api.host.view(undefined)
      }
      const watching = controller.watch()
      await flush()
      expect(controller.getSnapshot().owner).toBeUndefined()
      expect(controller.lastInterruption('s1')).toContain('超过 25 秒')
      await vi.advanceTimersByTimeAsync(1000)
      expect(controller.getSnapshot().loadError).toBe('')
      expect(controller.lastInterruption('s1')).toContain('手动连接和接入')
      expect(controller.getSnapshot().transport.phase).toBe('disconnected')
      controller.dispose()
      await watching
    } finally { controller.dispose(); vi.useRealTimers() }
  })

  it('does not overwrite a pause reason with a non-stopping status-report failure', async () => {
    const { controller, api } = await setup()
    await controller.attach('s1')
    const post = api.post.bind(api)
    api.post = action => action.action === 'session.status' ? Promise.reject(new Error('offline')) : post(action)
    controller.pause()
    await flush()
    expect(controller.getSnapshot().syncWarning).toContain('没有触发停止')
    expect(controller.getSnapshot().notice).toContain('暂停按钮')
    expect(controller.lastInterruption('s1')).toContain('暂停按钮')
    controller.dispose()
  })

  it('preserves device removal details and keeps late stop failures with the original session', async () => {
    const { controller, segments, transport } = await setup()
    await controller.attach('s1')
    segments.show('s1', 'r', [{ text: 'a', motion: full }])
    transport.state = { ...transport.state, message: '原位移设备已移除', error: '' }
    transport.setPhase('waiting')
    expect(controller.lastInterruption('s1')).toContain('设备已不可用：原位移设备已移除')
    transport.setPhase('ready')
    const pending = deferred<void>()
    let first = true
    transport.stop = () => { if (first) { first = false; return pending.promise } return Promise.resolve() }
    controller.pause()
    await controller.attach('s2')
    pending.reject(new Error('stop rejected'))
    await flush()
    expect(controller.lastInterruption('s1')).toContain('无法确认设备已停下')
    expect(controller.lastInterruption('s2')).toBeUndefined()
    expect(linkageStatus({ ...controller.getSnapshot(), qqbot: true }, 's2').detail).not.toContain('stop rejected')
    controller.dispose()
  })

  it('reports clock removal, explicit shutdown, page exit and plugin disposal', async () => {
    for (const mode of ['clock', 'switch', 'page', 'dispose'] as const) {
      const { controller, segments } = await setup()
      const remove = controller.connectSegments(segments)
      await controller.attach('s1')
      segments.show('s1', 'r', [{ text: 'a', motion: full }])
      if (mode === 'clock') remove()
      else if (mode === 'switch') await controller.setEnabled(false)
      else if (mode === 'page') controller.pagehide()
      else controller.dispose()
      expect(controller.lastInterruption('s1')).toContain({ clock: '分段显示服务已退出', switch: '用户关闭联动', page: '页面正在关闭或刷新', dispose: '联动模块已卸载' }[mode])
      expect(controller.getSnapshot().moving).toBe(false)
      controller.dispose()
    }
  })
})

describe('toy controller: stopping', () => {
  const intentOf = (controller: ToyController) => (controller as unknown as { player: { intent: Intent | null } }).player.intent

  it('pauses text and device together, and resumes both', async () => {
    const { controller, segments, api, transport, clock } = await setup()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    await clock.advance(10)
    controller.pause()
    await flush()
    expect(segments.pauses).toBe(1)
    expect(api.host.sessions.status('s1')).toBe('paused')
    expect(controller.getSnapshot().moving).toBe(false)
    const sent = transport.moves.length
    await clock.advance(5000)
    expect(transport.moves.length).toBe(sent)
    controller.resume()
    await flush()
    expect(segments.pauses).toBe(0)
    expect(api.host.sessions.status('s1')).toBe('ready')
    expect(controller.getSnapshot().moving).toBe(true)
  })

  it('pauses on the Ctrl+M hotkey once set, also inside text fields; it never resumes', async () => {
    const { controller } = await setup({ hotkey: 'Ctrl+KeyM' })
    const key = (patch: Partial<KeyLike> = {}): KeyLike => ({ code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...patch })
    await controller.attach('s1')
    expect(controller.hotkey(key({ ctrlKey: false }))).toBe(false)
    expect(controller.hotkey(key({ target: { closest: () => ({}) } }))).toBe(true)
    expect(controller.getSnapshot().paused).toBe(true)
    expect(controller.hotkey(key())).toBe(false)
    expect(controller.getSnapshot().paused).toBe(true)
  })

  it('resumes on the optional resume hotkey', async () => {
    const { controller } = await setup({ hotkey: 'Ctrl+KeyM', resumeHotkey: 'Ctrl+Alt+KeyM' })
    const key = (patch: Partial<KeyLike> = {}): KeyLike => ({ code: 'KeyM', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...patch })
    await controller.attach('s1')
    expect(controller.hotkey(key({ altKey: true }))).toBe(false) // 没暂停时恢复键不做事
    expect(controller.hotkey(key())).toBe(true)
    expect(controller.hotkey(key({ altKey: true }))).toBe(true)
    expect(controller.getSnapshot().paused).toBe(false)
  })

  it('ignores every key by default, with no pause hotkey; the pause button still works', async () => {
    const { controller } = await setup()
    await controller.attach('s1')
    for (const code of ['KeyM', 'Space', 'Backspace']) {
      expect(controller.hotkey({ code, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe(false)
      expect(controller.hotkey({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBe(false)
    }
    expect(controller.getSnapshot().paused).toBe(false)
    controller.pause()
    expect(controller.getSnapshot().paused).toBe(true)
  })

  it('pauses on plain space only outside text fields', async () => {
    const { controller } = await setup({ hotkey: 'Space' })
    const key = (patch: Partial<KeyLike> = {}): KeyLike => ({ code: 'Space', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...patch })
    expect(controller.hotkey(key())).toBe(false) // 没有接入的会话
    await controller.attach('s1')
    const input = { closest: (selector: string) => selector.includes('textarea') ? {} : null }
    expect(controller.hotkey(key({ target: input }))).toBe(false)
    expect(controller.hotkey(key({ repeat: true }))).toBe(false)
    expect(controller.hotkey(key({ target: { closest: () => null } }))).toBe(true)
    expect(controller.getSnapshot().paused).toBe(true)
    expect(controller.hotkey(key())).toBe(false)
    expect(controller.getSnapshot().paused).toBe(true)
  })

  it('reports a dropped connection as disconnected, and ready again after reconnecting', async () => {
    const { controller, segments, api, transport } = await setup()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    transport.setPhase('disconnected')
    await flush()
    expect(controller.getSnapshot().moving).toBe(false)
    expect(api.host.sessions.status('s1')).toBe('disconnected')
    expect(controller.getSnapshot().notice).toContain('断开')
    transport.setPhase('ready')
    await flush()
    expect(api.host.sessions.status('s1')).toBe('ready')
    // 断开清掉了选择：新回复第一段不写 motion 时不会自己动起来。
    segments.show('s1', '2:1', [{ text: 'b' }])
    expect(controller.getSnapshot().moving).toBe(false)
  })

  it('times out like the player does and keeps the selection for the next reply', async () => {
    const { controller, segments, clock } = await setup()
    await controller.attach('s1')
    segments.show('s1', '1:1', [{ text: 'a', motion: full }])
    await clock.advance(LAST_STAGE_STOP_MS + 10)
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().notice).toContain('自动停止')
    segments.show('s1', '2:1', [{ text: 'b', motion: { tier: 'medium' } }])
    expect(intentOf(controller)).toEqual({ ...full, tier: 'medium' })
  })

  it('exits when authorization is revoked, and on page hide', async () => {
    const { controller, api, transport } = await setup()
    await controller.attach('s1')
    await controller.saveSettings(settings({ authorized: false }))
    expect(controller.getSnapshot().owner).toBeUndefined()
    expect(api.host.sessions.status('s1')).toBeUndefined()

    await controller.saveSettings(settings())
    expect(transport.state.phase).toBe('disconnected')
    transport.setPhase('ready') // 撤回授权也断开；再次授权不会自动恢复连接。
    await controller.attach('s2')
    controller.pagehide()
    await flush()
    expect(api.beacons).toContainEqual({ action: 'session.detach', session: 's2' })
    expect(api.host.sessions.status('s2')).toBeUndefined()
  })
})

describe('built-in linkage switch', () => {
  it('stops synchronously, releases paused text, persists off and never resumes on enable', async () => {
    const { controller, api, transport, segments, clock } = await setup()
    await controller.attach('s1')
    segments.show('s1', 'reply', [{ text: 'a', motion: full }])
    controller.pause()
    expect(segments.pauses).toBe(1)
    const off = controller.setEnabled(false)
    expect(controller.getSnapshot()).toMatchObject({ enabled: false, moving: false, paused: false, owner: undefined })
    expect(segments.pauses).toBe(0)
    expect(transport.state.phase).toBe('disconnected')
    const moves = transport.moves.length
    segments.show('s1', 'reply2', [{ text: 'b', motion: full }])
    await clock.advance(5000)
    await off
    expect(transport.moves).toHaveLength(moves)
    expect(api.host.sessions.status('s1')).toBeUndefined()
    await expect(controller.connect()).rejects.toThrow('联动已关闭')
    await expect(controller.attach('s1')).rejects.toThrow('联动已关闭')
    await controller.setEnabled(true)
    expect(controller.getSnapshot()).toMatchObject({ enabled: true, moving: false, owner: undefined })
    expect(transport.state.phase).toBe('disconnected')
    controller.dispose()
  })

  it('does not revive an attach or connection that finishes after disabling', async () => {
    const { controller, api, transport } = await setup()
    const original = api.post.bind(api)
    const pending = deferred<ToyView>()
    api.post = action => action.action === 'session.attach' ? pending.promise : original(action)
    const attach = controller.attach('s1')
    await flush()
    const off = controller.setEnabled(false)
    pending.resolve({ settings: settings(), qqbot: true, session: { attached: true, rules: 'stale', proactivity: 0 } })
    await Promise.all([attach, off])
    expect(controller.getSnapshot().owner).toBeUndefined()
    await controller.setEnabled(true)
    const connecting = deferred<typeof transport.state>()
    transport.connect = () => connecting.promise
    const connect = controller.connect()
    await controller.setEnabled(false)
    transport.setPhase('ready')
    connecting.resolve(transport.state)
    await connect
    expect(transport.state.phase).toBe('disconnected')
    expect(controller.getSnapshot().enabled).toBe(false)
    controller.dispose()
  })

  it('keeps the device stopped if saving the off switch fails', async () => {
    const { controller, api, transport, segments } = await setup()
    await controller.attach('s1')
    segments.show('s1', 'reply', [{ text: 'a', motion: full }])
    const original = api.post.bind(api)
    api.post = action => action.action === 'module.enable' ? Promise.reject(new Error('disk full')) : original(action)
    await expect(controller.setEnabled(false)).rejects.toThrow('disk full')
    expect(controller.getSnapshot()).toMatchObject({ owner: undefined, moving: false })
    expect(transport.state.phase).toBe('disconnected')
    controller.dispose()
  })

  it('ignores a stale load response and updates another open page through the watch', async () => {
    const { controller, api, transport, segments } = await setup()
    const originalGet = api.get.bind(api)
    const stale = deferred<ToyView>()
    api.get = () => stale.promise
    const load = controller.load()
    await controller.setEnabled(false)
    stale.resolve({ settings: settings(), qqbot: true })
    await load
    expect(controller.getSnapshot().enabled).toBe(false)
    api.get = originalGet
    await controller.setEnabled(true)
    transport.setPhase('ready')
    await controller.attach('s1')
    segments.show('s1', 'reply', [{ text: 'a', motion: full }])
    ;(api as ToyApi).watch = async (revision, signal) => { await api.host.watch(revision, signal); return api.host.view(undefined) }
    const watching = controller.watch()
    await flush()
    api.host.apply({ action: 'module.enable', enabled: false })
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ enabled: false, moving: false, owner: undefined })
    expect(transport.state.phase).toBe('disconnected')
    controller.dispose()
    await watching
  })

  it('stops after a rapid off/on in another page even if only the final enabled snapshot arrives', async () => {
    const { controller, api, transport, segments } = await setup()
    await controller.attach('s1')
    segments.show('s1', 'reply', [{ text: 'a', motion: full }])
    api.host.apply({ action: 'module.enable', enabled: false })
    api.host.apply({ action: 'module.enable', enabled: true })
    await controller.load()
    expect(controller.getSnapshot()).toMatchObject({ enabled: true, moving: false, owner: undefined })
    expect(transport.state.phase).toBe('disconnected')
    controller.dispose()
  })
})

describe('hotkey', () => {
  const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  it('accepts space or a combination with Ctrl, Alt or Meta', () => {
    expect(validHotkey('Space')).toBe(true)
    expect(validHotkey('Ctrl+Shift+KeyS')).toBe(true)
    expect(validHotkey('Shift+KeyS')).toBe(false)
    expect(validHotkey('KeyS')).toBe(false)
    expect(validHotkey('Escape')).toBe(false)
    expect(validHotkey('')).toBe(false)
    expect(hotkeyFromEvent(key('KeyS', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+KeyS')
    expect(hotkeyFromEvent(key('KeyS'))).toBeUndefined()
  })
  it('lets a combination fire inside text fields', () => {
    const field = { closest: () => ({}) }
    expect(matchesHotkey('Ctrl+KeyQ', key('KeyQ', { ctrlKey: true, target: field }))).toBe(true)
    expect(matchesHotkey('Space', key('Space', { target: field }))).toBe(false)
    expect(matchesHotkey('Space', key('Space', { target: { isContentEditable: true } }))).toBe(false)
  })
  it('has no pause hotkey by default; Ctrl+M may be set; the resume hotkey is optional and must differ', () => {
    const host = new ToyHost(mkdtempSync(join(tmpdir(), 'toy-hotkey-')), () => {})
    expect(host.settings.value.hotkey).toBe('')
    const { hotkey: _, ...withoutHotkey } = settings()
    expect(host.settings.save(withoutHotkey).hotkey).toBe('')
    expect(host.settings.save({ ...settings(), hotkey: 'Ctrl+KeyM' }).hotkey).toBe('Ctrl+KeyM')
    expect(() => host.settings.save({ ...settings(), hotkey: 'Ctrl+KeyX' })).toThrow('暂停快捷键无效')
    expect(host.settings.save({ ...settings(), resumeHotkey: '' }).resumeHotkey).toBeUndefined()
    expect(host.settings.save({ ...settings(), resumeHotkey: 'Ctrl+KeyR' }).resumeHotkey).toBe('Ctrl+KeyR')
    expect(() => host.settings.save({ ...settings(), hotkey: 'Ctrl+KeyM', resumeHotkey: 'Ctrl+KeyM' })).toThrow('不能和暂停快捷键相同')
    expect(() => host.settings.save({ ...settings(), resumeHotkey: 'Ctrl+KeyV' })).toThrow('恢复快捷键无效')
  })

  it('replaces a saved hotkey that is no longer allowed without dropping the rest of the settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toy-hotkey-'))
    new ToyHost(dir, () => {}).settings.save(settings())
    const file = join(dir, 'settings.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...saved, hotkey: 'Ctrl+KeyX', resumeHotkey: 'Ctrl+KeyM' }))
    const warnings: string[] = []
    const loaded = new ToyHost(dir, (message) => { warnings.push(message) }).settings.value
    expect(loaded).toMatchObject({ authorized: true, hotkey: '', resumeHotkey: 'Ctrl+KeyM', motion: saved.motion })
    expect(warnings).toHaveLength(1)
    writeFileSync(file, JSON.stringify({ ...saved, hotkey: 'Ctrl+KeyM', resumeHotkey: 'Ctrl+KeyV' }))
    const reloaded = new ToyHost(dir, () => {}).settings.value
    expect(reloaded.hotkey).toBe('Ctrl+KeyM')
    expect(reloaded.resumeHotkey).toBeUndefined()
  })

  it('rejects the editing shortcuts but keeps their Alt and plain-letter variants', () => {
    for (const value of ['Ctrl+KeyX', 'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyZ', 'Ctrl+Shift+KeyZ', 'Ctrl+KeyY', 'Ctrl+KeyA', 'Meta+KeyC']) {
      expect(validHotkey(value)).toBe(false)
    }
    for (const value of ['Ctrl+KeyM', 'Ctrl+Alt+KeyX', 'Alt+KeyC', 'Ctrl+Shift+KeyS']) expect(validHotkey(value)).toBe(true)
    expect(hotkeyFromEvent(key('KeyX', { ctrlKey: true }))).toBeUndefined()
  })
})

describe('with the real dsh-qqbot reply clock', () => {
  async function real(patch: Partial<ToySettings> = {}) {
    const clock = new FakeClock()
    const transport = new MockTransport(clock)
    const api = new HostApi()
    api.host.settings.save(settings(patch))
    const controller = new ToyController({ api, kind: 'buttplug', transport: () => transport, clock })
    const reply = new ReplyClock({ delay: () => 1000, onChange: () => {}, onError: (error) => { throw error }, timers: clock })
    // 结构类型：dsh-qqbot 的 ReplyClock 直接满足本插件声明的 QqbotSegments。
    const segments: QqbotSegments = reply
    controller.connectSegments(segments)
    await controller.load()
    await controller.attach('s1')
    return { clock, transport, controller, reply }
  }
  const intentOf = (controller: ToyController) => (controller as unknown as { player: { intent: Intent | null } }).player.intent

  it('continues after a bad action in the same reply while respecting pause and protection', async () => {
    const { clock, controller, reply, transport } = await real()
    reply.feed('s1', 'recovery', [
      { text: '正常', motion: full },
      { text: '错误', motion: { tier: 'unknown' } },
      { text: '重新开始', motion: full },
    ], true, true)
    await clock.advance(1000)
    expect(intentOf(controller)).toBeNull()
    controller.pause()
    const count = transport.moves.length
    await clock.advance(10000)
    expect(reply.count('s1', 'recovery')).toBe(2)
    expect(transport.moves).toHaveLength(count)
    controller.resume()
    await clock.advance(1000)
    expect(reply.count('s1', 'recovery')).toBe(3)
    expect(intentOf(controller)).toEqual(full)
    expect(transport.moves.length).toBeGreaterThan(count)
    await clock.advance(LAST_STAGE_STOP_MS)
    expect(intentOf(controller)).toBeNull()
    const stopped = transport.moves.length
    await clock.advance(10000)
    expect(transport.moves).toHaveLength(stopped)
    controller.dispose()
    reply.dispose()
  })

  it('follows streamed stages, motion pacing and pause', async () => {
    const { clock, controller, reply } = await real({ pacing: { seconds: 6 } })
    const first = { text: 'a', motion: full }
    reply.feed('s1', '1:1', [first], false, true)
    await clock.advance(0)
    expect(intentOf(controller)).toEqual(full)
    const hold = 6000
    reply.feed('s1', '1:1', [first, { text: 'b', motion: { tier: 'medium' } }], true, true)
    controller.pause()
    await clock.advance(hold + 1000)
    expect(reply.count('s1', '1:1')).toBe(1)
    controller.resume()
    await clock.advance(hold - 1)
    expect(reply.count('s1', '1:1')).toBe(1)
    await clock.advance(1)
    expect(reply.count('s1', '1:1')).toBe(2)
    expect(intentOf(controller)).toEqual({ ...full, tier: 'medium' })
  })
})
