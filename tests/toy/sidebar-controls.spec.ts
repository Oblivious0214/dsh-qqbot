import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BURST, type ToyAction, type ToySettings, type ToyView } from '../../src/toy/api-types.ts'
import type { ToyApi } from '../../src/toy/client/api.ts'
import { ToyController, type QqbotSegments, type SegmentHooks, type SegmentStage } from '../../src/toy/client/controller.ts'
import { burstTier, defaultMotion, tierBudget, type MotionConfig } from '../../src/toy/core/config.ts'
import type { Intent } from '../../src/toy/core/intent.ts'
import { adjustBounds, liveMotion, manualPackets, outputBounds, type LiveAdjust } from '../../src/toy/core/motion.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { PresetPlayback } from '../../src/toy/motion-library/playback.ts'
import { BadRequest, ToyHost } from '../../src/toy/index.ts'
import { DEFAULT_CLIMAX_PROMPTS, aftercareText, climaxText } from '../../src/toy/climax-prompt.ts'
import { defaultSettings, parseSettings } from '../../src/toy/settings.ts'
import { FakeClock, flush, MockTransport } from './fakes.ts'

const full: Intent = { range: 'full', tier: 'high', action: '稳定节奏' }

class HostApi implements ToyApi {
  readonly host = new ToyHost(mkdtempSync(join(tmpdir(), 'toy-sidebar-')), () => {})
  async get(session?: string): Promise<ToyView> { return this.host.view(session) }
  async post(action: ToyAction): Promise<ToyView> {
    try { return this.host.view(this.host.apply(action)) }
    catch (error) { throw error instanceof BadRequest ? new Error(`bad request: ${error.message}`) : error }
  }
  beacon(action: ToyAction): void { void this.post(action).catch(() => {}) }
}

class FakeSegments implements QqbotSegments {
  hooks: SegmentHooks | undefined
  register(hooks: SegmentHooks) { this.hooks = hooks; return () => { this.hooks = undefined } }
  pause() { return () => {} }
  show(session: string, reply: string, stages: SegmentStage[]) {
    stages.forEach((stage, i) => this.hooks?.revealed?.(session, reply, i, stage, i === stages.length - 1 ? undefined : 1000))
  }
}

async function setup(patch: Partial<ToySettings> = {}) {
  const clock = new FakeClock()
  const transport = new MockTransport(clock)
  const api = new HostApi()
  api.host.settings.save({ ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true, ...patch })
  const controller = new ToyController({ api, kind: 'buttplug', transport: () => transport, clock })
  const segments = new FakeSegments()
  controller.connectSegments(segments)
  await controller.load()
  await controller.attach('s1')
  return { clock, transport, api, controller, segments }
}

const limited: MotionConfig = { ...defaultMotion(), minPosition: 20, maxPosition: 70, maxSpeed: 300 }

describe('本场实际行程与速度', () => {
  it('直接使用实际起止坐标，仍受总行程截断，未调时跟随 AI', () => {
    const bounds = outputBounds(full, limited)
    expect(adjustBounds(bounds, limited, { bounds: [0, 100] })).toEqual([20, 70])
    expect(adjustBounds(bounds, limited, { bounds: [30, 55] })).toEqual([30, 55])
    const intent: Intent = { range: 'middle', tier: 'low', action: '稳定节奏' }
    expect(liveMotion(intent, limited).bounds).toEqual(outputBounds(intent, limited))
    expect(liveMotion(intent, limited, { bounds: [25, 65] }).bounds).toEqual([25, 65])
    expect(adjustBounds(bounds, limited, { bounds: [80, 90] })).toEqual([69, 70])
  })

  it('绝对速度独立于 AI 速度档，并按总速度上限截断', () => {
    /** 实际速度（距离 ÷ 时长），不含进入包。 */
    const speeds = (adjust: LiveAdjust, intent = full) => {
      const clip = defaultActionLibrary().library.clips.find(c => c.name === full.action)!
      const playback = new PresetPlayback(intent, limited, clip, {}, adjust)
      const out: number[] = []
      let last: number | undefined
      let lastSpeed: number | undefined
      let lastDuration = 0
      while (out.length < 60) {
        const packet = playback.next(lastSpeed, lastDuration)!
        expect(packet.position).toBeGreaterThanOrEqual(20)
        expect(packet.position).toBeLessThanOrEqual(70)
        expect(packet.speed).toBeLessThanOrEqual(300)
        if (last !== undefined && !packet.hold) out.push(Math.abs(packet.position - last) * 1000 / packet.durationMs)
        playback.consume(packet, packet.durationMs)
        last = packet.position
        if (!packet.hold) lastSpeed = packet.speed
        lastDuration = packet.durationMs
      }
      return out
    }
    expect(Math.max(...speeds({ speed: 999 }))).toBeLessThanOrEqual(300)
    expect(Math.max(...speeds({ speed: 50 }))).toBeLessThan(Math.max(...speeds({ speed: 200 })))
    expect(Math.max(...speeds({ speed: 180 }, { ...full, tier: 'low' }))).toBeCloseTo(Math.max(...speeds({ speed: 180 })), 0)
  })

  it('运行中按实际窗口和速度接续，AI 换范围和档位不会覆盖手调项，退出后复原', async () => {
    const { controller, segments, transport, clock } = await setup({ motion: limited })
    segments.show('s1', 'r1', [{ text: 'a', motion: full }])
    await clock.advance(3000)
    controller.setLiveMotion({ bounds: [30, 55], speed: 65 })
    expect(controller.getSnapshot().liveMotion).toEqual({ bounds: [30, 55], speed: 65 })
    expect(controller.livePlayback('s1')!.action).toContain('行程 30–55 · 65 unit/s')
    const before = transport.moves.length
    await clock.advance(3000)
    const after = transport.moves.slice(before)
    expect(after.length).toBeGreaterThan(0)
    for (const move of after) {
      expect(move.limits.maxSpeed).toBeLessThanOrEqual(65)
      expect(move.position).toBeGreaterThanOrEqual(30)
      expect(move.position).toBeLessThanOrEqual(55)
    }
    segments.show('s1', 'r2', [{ text: 'b', motion: { ...full, range: 'upper', tier: 'low' } }])
    expect(controller.getSnapshot().liveMotion).toEqual({ bounds: [30, 55], speed: 65 })
    await controller.detach()
    expect(controller.getSnapshot().adjust).toEqual({})
  })

  it('独立调整、限幅、复原及重新接入不保存设置或改变模型规则', async () => {
    const { controller, segments, api } = await setup({ motion: limited })
    const before = JSON.stringify(api.host.view('s1'))
    const intent: Intent = { ...full, range: 'upper', tier: 'low' }
    segments.show('s1', 'r1', [{ text: 'a', motion: intent }])
    controller.setLiveMotion({ speed: 999 })
    expect(controller.getSnapshot().liveMotion).toEqual({ bounds: outputBounds(intent, limited), speed: 300 })
    controller.setLiveMotion({ bounds: [0, 100] })
    expect(controller.getSnapshot().adjust).toEqual({ bounds: [20, 70], speed: 300 })
    controller.setLiveMotion({ bounds: [60, 30], speed: NaN })
    expect(controller.getSnapshot().adjust).toEqual({ bounds: [20, 70], speed: 300 })
    controller.resetLiveMotion()
    expect(controller.getSnapshot().liveMotion).toEqual({ bounds: outputBounds(intent, limited), speed: Math.round(tierBudget(limited, 'low').nominal) })
    expect(JSON.stringify(api.host.view('s1'))).toBe(before)
    controller.setLiveMotion({ speed: 45 })
    await controller.attach('s2')
    expect(controller.getSnapshot().adjust).toEqual({})
  })

  it('静止时拖动不启动；暂停中修改到恢复时生效，不延长原倒计时', async () => {
    const { controller, segments, transport, clock } = await setup({ motion: limited })
    controller.setLiveMotion({ bounds: [40, 60], speed: 60 })
    await clock.advance(1000)
    expect(transport.moves).toHaveLength(0)
    segments.show('s1', 'r1', [{ text: 'a', motion: full }])
    await clock.advance(3000)
    controller.pause()
    const remaining = controller.livePlayback('s1')!.remainingMs!
    const count = transport.moves.length
    controller.setLiveMotion({ bounds: [25, 35], speed: 30 })
    await clock.advance(5000)
    expect(transport.moves).toHaveLength(count)
    expect(controller.livePlayback('s1')!.remainingMs).toBe(remaining)
    controller.resume()
    await clock.advance(2000)
    expect(transport.moves.length).toBeGreaterThan(count)
    for (const move of transport.moves.slice(count)) {
      expect(move.position).toBeGreaterThanOrEqual(25)
      expect(move.position).toBeLessThanOrEqual(35)
      expect(move.limits.maxSpeed).toBeLessThanOrEqual(30)
    }
    controller.setLiveMotion({ speed: 20 })
    await clock.advance(remaining - 1999)
    expect(controller.getSnapshot().moving).toBe(false)
  })

  it('总限制收紧后实际滑条值与后续发包均夹在新的限制内', async () => {
    const { controller, segments, transport, clock, api } = await setup({ motion: limited })
    controller.setLiveMotion({ bounds: [50, 70], speed: 250 })
    segments.show('s1', 'r1', [{ text: 'a', motion: full }])
    await clock.advance(1000)
    const count = transport.moves.length
    await controller.saveSettings({ ...api.host.settings.value, motion: { ...limited, minPosition: 25, maxPosition: 45, maxSpeed: 40 } })
    expect(controller.getSnapshot().liveMotion).toEqual({ bounds: [44, 45], speed: 40 })
    await clock.advance(5000)
    expect(transport.moves.length).toBeGreaterThan(count)
    for (const move of transport.moves.slice(count)) {
      expect(move.position).toBeGreaterThanOrEqual(44)
      expect(move.position).toBeLessThanOrEqual(45)
      expect(move.limits.maxSpeed).toBeLessThanOrEqual(40)
    }
  })
})

describe('手动定位', () => {
  it('慢速移到总设置行程内的目标后停住', () => {
    const packets = manualPackets(45, limited, {}, 20)
    const first = packets.next().value
    expect(first.position).toBe(45)
    expect(first.hold).toBe(false)
    expect(first.speed).toBeLessThanOrEqual(300)
    expect(packets.next().value.hold).toBe(true)
  })

  it('拖动打断 AI 动作，AI 下一段照常接管；暂停打断手动定位', async () => {
    const { controller, segments, transport, clock } = await setup({ motion: limited })
    segments.show('s1', 'r1', [{ text: 'a', motion: full }])
    await clock.advance(2000)
    const stops = transport.stops
    controller.manual(100)
    expect(controller.getSnapshot().mode).toBe('manual')
    expect(transport.stops).toBe(stops + 1)
    await clock.advance(5000)
    const moves = transport.moves.filter(move => move.at >= 2000)
    expect(moves.at(-1)?.position).toBe(70)
    expect(new Set(moves.map(move => move.position)).size).toBe(1)
    segments.show('s1', 'r2', [{ text: 'b', motion: { range: 'lower', tier: 'low', action: 'steady' } }])
    expect(controller.getSnapshot().mode).toBe('ai')
    controller.manual(10)
    expect(controller.getSnapshot().mode).toBe('manual')
    controller.pause()
    expect(controller.getSnapshot().mode).toBe('ai')
    expect(controller.getSnapshot().moving).toBe(false)
    const sent = transport.moves.length
    controller.manual(50)
    await clock.advance(3000)
    expect(transport.moves.length).toBe(sent)
    controller.resume()
    await clock.advance(1000)
    expect(transport.moves.length).toBe(sent)
  })

  it('手动定位保持 30 秒后自动停止', async () => {
    const { controller, clock } = await setup()
    controller.manual(30)
    await clock.advance(30001)
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().notice).toContain('手动定位已保持 30 秒')
  })
})

describe('高潮与温存', () => {
  it('高潮刺激设定秒数后按默认进入温存，温存结束后停止', async () => {
    const { controller, transport, clock } = await setup({ burst: { ...DEFAULT_BURST, seconds: 5, aftercareSeconds: 6 } })
    await controller.burst()
    expect(controller.getSnapshot().phase).toEqual({ kind: 'burst' })
    expect(controller.getSnapshot().mode).toBe('burst')
    expect(controller.livePlayback('s1')?.action).toMatch(/^高潮/)
    await clock.advance(5001)
    expect(controller.getSnapshot().phase).toEqual({ kind: 'aftercare' })
    const start = clock.now()
    await clock.advance(12000)
    expect(controller.getSnapshot().phase).toBeUndefined()
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().owner).toBe('s1')
    const [low, high] = outputBounds({ range: 'upper', tier: 'low', action: 'auto' }, defaultMotion())
    for (const move of transport.moves.filter(m => m.at > start)) {
      expect(move.position).toBeGreaterThanOrEqual(low)
      expect(move.position).toBeLessThanOrEqual(high)
    }
  })

  it('刺激结束设为停止时不进入温存', async () => {
    const { controller, clock } = await setup({ burst: { ...DEFAULT_BURST, seconds: 5, after: 'stop' } })
    await controller.burst()
    await clock.advance(5001)
    expect(controller.getSnapshot().phase).toBeUndefined()
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().notice).toContain('高潮已结束')
  })

  it('取消高潮停在原位但不退出联动，AI 下一段接管', async () => {
    const { controller, segments, clock, api } = await setup()
    await controller.burst()
    segments.show('s1', 'r1', [{ text: 'a', motion: { range: 'lower', tier: 'low', action: 'steady' } }])
    expect(controller.getSnapshot().mode).toBe('burst')
    await controller.cancelPhase()
    expect(controller.getSnapshot().phase).toBeUndefined()
    expect(controller.getSnapshot().moving).toBe(false)
    expect(controller.getSnapshot().paused).toBe(false)
    expect(controller.getSnapshot().owner).toBe('s1')
    expect(api.host.sessions.status('s1')).toBe('ready')
    segments.show('s1', 'r2', [{ text: 'b', motion: full }])
    await clock.advance(10)
    expect(controller.getSnapshot().moving).toBe(true)
    expect(controller.getSnapshot().mode).toBe('ai')
  })

  it('高潮中不能手动切到温存；温存可提前结束，暂停按钮随时可停', async () => {
    const { controller, clock } = await setup({ burst: { ...DEFAULT_BURST, seconds: 5 } })
    await controller.burst()
    expect('aftercare' in controller).toBe(false)
    await clock.advance(5001)
    expect(controller.getSnapshot().phase?.kind).toBe('aftercare')
    expect(controller.livePlayback('s1')?.action).toMatch(/^温存 · /)
    controller.pause()
    expect(controller.getSnapshot().moving).toBe(false)
    controller.resume()
    await clock.advance(10)
    expect(controller.getSnapshot().moving).toBe(true)
    await controller.cancelPhase()
    expect(controller.getSnapshot().phase).toBeUndefined()
    expect(controller.getSnapshot().owner).toBe('s1')
  })

  it('高潮速度：中速用中速档上限，自己填的速度直接生效，本场手调速度优先', async () => {
    const medium = await setup({ burst: { ...DEFAULT_BURST, speed: 'medium' } })
    await medium.controller.burst()
    expect(medium.controller.livePlayback('s1')?.speed).toBe(`${tierBudget(defaultMotion(), 'medium').max} unit/s`)

    const custom = await setup({ burst: { ...DEFAULT_BURST, speed: 120 } })
    await custom.controller.burst()
    expect(custom.controller.livePlayback('s1')?.speed).toBe('120 unit/s')
    await custom.clock.advance(4000)
    let from: number | undefined
    for (const move of custom.transport.moves) {
      if (from !== undefined) expect(Math.abs(move.position - from) * 1000 / move.durationMs).toBeLessThanOrEqual(121)
      from = move.position
    }
    custom.controller.setLiveMotion({ speed: 200 })
    expect(custom.controller.livePlayback('s1')?.speed).toBe('200 unit/s')
  })

  it('高潮速度选档：不可用时往低档找；自己填的速度取所在档，超上限取最高可用档', () => {
    const motion = defaultMotion()
    expect(burstTier(motion, 'high')).toBe('high')
    expect(burstTier(motion, 'medium')).toBe('medium')
    expect(burstTier(motion, 100)).toBe('low')
    expect(burstTier(motion, 200)).toBe('medium')
    expect(burstTier({ ...motion, maxSpeed: 200 }, 450)).toBe('high')
    // 上限压到 2 时只剩一档，中速也只能落到它。
    expect(burstTier({ ...motion, maxSpeed: 2 }, 'medium')).toBe('high')
  })

  it('暂停时不能开始高潮', async () => {
    const { controller } = await setup()
    controller.pause()
    await expect(controller.burst()).rejects.toThrow()
    expect(controller.getSnapshot().phase).toBeUndefined()
  })
})

describe('host：高潮设置', () => {
  it('校验爆发设置，旧设置缺省为默认，旧的方式字段丢弃', () => {
    const base = { ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true }
    expect(parseSettings(base).burst).toBeUndefined()
    expect(parseSettings({ ...base, burst: { mode: 'ai', seconds: 120, after: 'stop', aftercareSeconds: 5 } }).burst).toEqual({ seconds: 120, after: 'stop', aftercareSeconds: 5 })
    expect(() => parseSettings({ ...base, burst: { ...DEFAULT_BURST, seconds: 121 } })).toThrow()
    expect(() => parseSettings({ ...base, burst: { ...DEFAULT_BURST, after: 'x' } })).toThrow()
    expect(parseSettings({ ...base, burst: { ...DEFAULT_BURST, speed: 'medium' } }).burst?.speed).toBe('medium')
    expect(parseSettings({ ...base, burst: { ...DEFAULT_BURST, speed: 180 } }).burst?.speed).toBe(180)
    for (const speed of ['low', 1, 501, 12.5]) expect(() => parseSettings({ ...base, burst: { ...DEFAULT_BURST, speed } })).toThrow(/高潮速度/)
  })

  it('不再接受旧的爆发／温存消息操作', async () => {
    const api = new HostApi()
    await expect(api.post({ action: 'session.prompt', session: 's1', prompt: 'burst' } as unknown as ToyAction)).rejects.toThrow(/bad request/)
  })
})

describe('高潮消息', () => {
  const recorder = () => {
    const sent: { session: string; text: string; summary: string }[] = []
    const cancelled: string[] = []
    return { sent, cancelled, prompter: { send: (session: string, text: string, summary: string) => { sent.push({ session, text, summary }) }, cancel: (session: string) => { cancelled.push(session) } } }
  }

  it('按下高潮立即开始设备流程，同时按当前设置投一条消息', async () => {
    const { controller, api } = await setup({ burst: { seconds: 15, after: 'aftercare', aftercareSeconds: 45 } })
    const r = recorder()
    api.host.prompter = r.prompter
    await controller.burst()
    expect(controller.getSnapshot().mode).toBe('burst')
    expect(r.sent).toEqual([{ session: 's1', text: climaxText({ seconds: 15, after: 'aftercare', aftercareSeconds: 45 }), summary: '高潮' }])
    expect(r.sent[0]!.text).toContain('15 秒')
    expect(r.sent[0]!.text).toContain('约 5 段')
    expect(r.sent[0]!.text).toContain('这条只写高潮过程')
  })

  it('刺激结束转入温存时再投一条温存消息', async () => {
    const { controller, api, clock } = await setup({ burst: { seconds: 5, after: 'aftercare', aftercareSeconds: 45 } })
    const r = recorder()
    api.host.prompter = r.prompter
    await controller.burst()
    await clock.advance(5001)
    expect(controller.getSnapshot().phase?.kind).toBe('aftercare')
    await Promise.resolve()
    expect(r.sent.map(m => m.summary)).toEqual(['高潮', '温存'])
    expect(r.sent[1]!.text).toBe(aftercareText({ seconds: 5, after: 'aftercare', aftercareSeconds: 45 }))
    expect(r.sent[1]!.text).toContain('45 秒')
  })

  it('段数随秒数增加，有上下限', () => {
    expect(climaxText({ ...DEFAULT_BURST, seconds: 5 })).toContain('约 4 段')
    expect(climaxText({ ...DEFAULT_BURST, seconds: 60 })).toContain('约 20 段')
    expect(climaxText({ ...DEFAULT_BURST, seconds: 120 })).toContain('约 30 段')
    expect(aftercareText({ ...DEFAULT_BURST, aftercareSeconds: 60 })).toContain('约 15 段')
  })

  it('刺激结束后停止时，消息不提温存', () => {
    const text = climaxText({ seconds: 20, after: 'stop', aftercareSeconds: 60 })
    expect(text).toContain('20 秒')
    expect(text).not.toContain('温存')
    expect(text).toContain('约 7 段')
  })

  it('消息发不出去时设备照常运行并提示', async () => {
    const { controller } = await setup()
    await controller.burst()
    expect(controller.getSnapshot().mode).toBe('burst')
    expect(controller.getSnapshot().notice).toContain('没能通知 AI')
  })

  it('取消高潮或提前结束温存时撤回未处理的消息', async () => {
    const { controller, api, clock } = await setup({ burst: { ...DEFAULT_BURST, seconds: 5 } })
    const r = recorder()
    api.host.prompter = r.prompter
    await controller.burst()
    await controller.cancelPhase()
    expect(r.cancelled).toEqual(['s1'])
    await controller.burst()
    await clock.advance(5001)
    expect(controller.getSnapshot().phase?.kind).toBe('aftercare')
    await controller.cancelPhase()
    expect(r.cancelled).toEqual(['s1', 's1'])
  })

  it('未接入的会话不能投递', async () => {
    const api = new HostApi()
    api.host.settings.save({ ...defaultSettings(), enabled: true, authorized: true })
    api.host.prompter = recorder().prompter
    await expect(api.post({ action: 'session.climax', session: 's2' })).rejects.toThrow(/尚未接入/)
  })

  it('用户改写的通知按当前时长填入秒数和段数', async () => {
    const { controller, api, clock } = await setup({ burst: { seconds: 9, after: 'aftercare', aftercareSeconds: 8 }, climaxPrompts: { climax: '冲 {秒数} 秒，写 {段数} 段', aftercare: '歇 {秒数} 秒，写 {段数} 段' } })
    const r = recorder()
    api.host.prompter = r.prompter
    await controller.burst()
    await clock.advance(9001)
    await Promise.resolve()
    expect(r.sent.map(m => m.text)).toEqual(['冲 9 秒，写 4 段', '歇 8 秒，写 3 段'])
  })

  it('通知设置只保存改过的项，空文本和未知项被拒绝', () => {
    const base = { ...defaultSettings(), authorized: true }
    expect(parseSettings({ ...base, climaxPrompts: { climax: DEFAULT_CLIMAX_PROMPTS.climax, aftercare: '新的' } }).climaxPrompts).toEqual({ aftercare: '新的' })
    expect(parseSettings({ ...base, climaxPrompts: { climax: DEFAULT_CLIMAX_PROMPTS.climax } }).climaxPrompts).toBeUndefined()
    expect(() => parseSettings({ ...base, climaxPrompts: { climax: '  ' } })).toThrow()
    expect(() => parseSettings({ ...base, climaxPrompts: { other: 'x' } })).toThrow()
  })

  it('默认温存 60 秒', () => {
    expect(DEFAULT_BURST.aftercareSeconds).toBe(60)
  })
})
