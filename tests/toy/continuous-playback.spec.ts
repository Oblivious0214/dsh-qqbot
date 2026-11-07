import { describe, expect, it } from 'vitest'
import { MotionPlayer } from '../../src/toy/client/player.ts'
import { PresetPlayback } from '../../src/toy/motion-library/playback.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { saveClip } from '../../src/toy/motion-library/library.ts'
import type { ActionLibrary } from '../../src/toy/motion-library/config.ts'
import type { Intent } from '../../src/toy/core/intent.ts'
import { FakeClock, MockTransport, flush, legacyMotion } from './fakes.ts'
import type { MoveLimits } from '../../src/toy/client/transport.ts'

const intent: Intent = { action: '长片段', range: 'full', tier: 'low' }
// 30 秒非均匀源：停留、窄峰和斜率变化均保留。
const points = [{ at: 0, pos: 20 }, { at: 5000, pos: 80 }, { at: 11000, pos: 80 }, { at: 11300, pos: 20 }, { at: 20000, pos: 50 }, { at: 30000, pos: 30 }]
function library(): ActionLibrary {
  const value = defaultActionLibrary()
  return { ...value, library: saveClip(value.library, '长片段', { points }, 0, 30000, { kind: 'segment' }),
    pools: { low: [{ name: '长片段', weight: 'high' }], medium: [{ name: '稳定节奏', weight: 'high' }], high: [{ name: '渐快', weight: 'high' }] } }
}
function setup(value = library(), delayed = false) {
  const clock = new FakeClock()
  class DeferredTransport extends MockTransport {
    release: (() => void) | undefined
    delay = delayed
    override async move(position: number, durationMs: number, limits: MoveLimits) {
      const at = clock.now()
      const result = await super.move(position, durationMs, limits)
      if (this.delay) await new Promise<void>(resolve => { this.release = resolve })
      return { ...result, remainingMs: Math.max(0, durationMs - (clock.now() - at)) }
    }
  }
  const transport = new DeferredTransport(clock)
  const stopped: string[] = []
  const player = new MotionPlayer(transport, { onStop: cause => stopped.push(cause) }, clock)
  const config = { ...legacyMotion(), autoStopSeconds: 0 }
  player.configure(config)
  player.configureLibrary(value)
  return { player, clock, transport, stopped, config }
}

describe('source cursor and AI completion selection', () => {
  it.each([false, true])('keeps user pause through model stop, replacement and tuning (pending move: %s)', async delayed => {
    const { player, clock, transport, config, stopped } = setup(library(), delayed)
    player.reveal(intent, 5000)
    await clock.advance(1500)
    player.pause()
    const count = transport.moves.length
    player.reveal(null, 5000)
    expect(player.paused).toBe(true)
    expect(player.completed).toBe(false)
    expect(player.sourceCursor).toBeUndefined()
    expect(stopped).toEqual(['model'])
    player.reveal(intent, 5000)
    player.setAdjust({ speed: 70, bounds: [35, 55] })
    player.configure({ ...config, minPosition: 30, maxPosition: 60, maxSpeed: 100 })
    transport.delay = false
    transport.release?.()
    await clock.advance(10000)
    expect(transport.moves).toHaveLength(count)
    expect(player.paused).toBe(true)
    expect(player.sourceCursor).toEqual({ sourceMs: 0, pass: 0, completed: false })
    player.resume()
    await flush()
    expect(transport.moves).toHaveLength(count + 1)
    expect(player.sourceCursor!.sourceMs).toBe(0)
    expect(transport.moves[count]!.position).toBe(39)
    expect(transport.moves[count]!.limits.maxSpeed).toBeLessThanOrEqual(100)
    player.dispose()
  })

  it('model stop clears completion and restarts the same unpaused choice at source zero; other stops clear pause', async () => {
    const { player, clock, transport } = setup()
    player.reveal(intent, undefined)
    await clock.advance(200000)
    expect(player.completed).toBe(true)
    player.reveal(null, 5000)
    expect(player.completed).toBe(false)
    expect(player.paused).toBe(false)
    const count = transport.moves.length
    player.reveal(intent, 5000)
    await flush()
    expect(transport.moves).toHaveLength(count + 1)
    expect(player.sourceCursor).toEqual({ sourceMs: 0, pass: 0, completed: false })
    player.pause()
    player.stop('user')
    expect(player.paused).toBe(false)
    player.dispose()
  })

  it('maps fractional source time through a hold and narrow peak independently of rounded position', () => {
    const clip = library().library.clips.at(-1)!
    const active = new PresetPlayback(intent, legacyMotion(), clip, {}, { speed: 100 }, { sourceMs: 8000.125, pass: 0, completed: false })
    expect(active.cursor().sourceMs).toBeCloseTo(8000.125, 8)
    const entry = active.next()!
    active.consume(entry, entry.durationMs)
    expect(active.cursor().sourceMs).toBeCloseTo(8000.125, 8)
    const hold = active.next()!
    expect(hold.hold).toBe(true)
    // 此参数下每个100ms子步对应50ms源时间；8000.125位于[8000,8050]。
    active.consume(hold, hold.durationMs / 2)
    expect(active.cursor().sourceMs).toBeCloseTo((8000.125 + 8050) / 2, 8)
    const peak = new PresetPlayback(intent, legacyMotion(), clip, {}, { bounds: [49, 51], speed: 60 }, { sourceMs: 11123.456, pass: 0, completed: false })
    expect(peak.cursor().sourceMs).toBeCloseTo(11123.456, 8)
    const before = peak.cursor().sourceMs
    const p = peak.next()!
    peak.consume(p, p.durationMs)
    expect(peak.cursor().sourceMs).toBeCloseTo(before, 8)
  })

  it('plays 30000 source ms across six 5-second bubbles with one entry and the mapped duration', async () => {
    const { player, clock, transport, config, stopped } = setup()
    // 手调100使窄峰不把整条源压缩到少于六个气泡。
    player.setAdjust({ speed: 100 })
    const clip = library().library.clips.at(-1)!
    const reference = new PresetPlayback(intent, config, clip, {}, { speed: 100 })
    let total = 0, entries = 0, lastSpeed: number | undefined, lastDuration = 0
    const expected: { position: number; durationMs: number }[] = []
    for (let p = reference.next(lastSpeed, lastDuration); p !== undefined; p = reference.next(lastSpeed, lastDuration)) {
      total += p.durationMs
      if (p.entry) entries++
      if (!p.hold) { expected.push({ position: p.position, durationMs: p.durationMs }); lastSpeed = p.speed }
      lastDuration = p.durationMs
      reference.consume(p, p.durationMs)
    }
    expect(total).toBeGreaterThan(30000)
    player.reveal(intent, 5000)
    let cursor = 0
    for (let i = 0; i < 6; i++) {
      await clock.advance(5000)
      expect(player.sourceCursor!.sourceMs).toBeGreaterThanOrEqual(cursor)
      cursor = player.sourceCursor!.sourceMs
      player.reveal(i % 2 ? undefined : intent, 5000)
    }
    player.reveal(undefined, undefined)
    await clock.advance(total - clock.now() - 1)
    expect(stopped).toEqual([])
    await clock.advance(1)
    expect(stopped).toEqual(['complete'])
    expect(player.sourceCursor).toEqual({ sourceMs: 30000, pass: 0, completed: true })
    expect(entries).toBe(1)
    expect(transport.moves.map(({ position, durationMs }) => ({ position, durationMs }))).toEqual(expected)
  })

  it('remaps only after consuming the pending packet and keeps the actual auto clip across disjoint pools', async () => {
    const { player, clock, transport } = setup()
    player.setAdjust({ speed: 100 })
    player.reveal({ ...intent, action: 'auto' }, 5000)
    await clock.advance(1000) // entry complete; first source packet now executing
    const before = player.sourceCursor!
    const packet = transport.moves.at(-1)!
    player.reveal({ ...intent, action: 'auto', tier: 'high', range: 'upper' }, 5000)
    player.setAdjust({ speed: 80 })
    player.setAdjust({ speed: 60, bounds: [40, 70] })
    expect(player.sourceCursor).toEqual(before)
    await clock.advance(packet.at + packet.durationMs - clock.now())
    expect(player.presetName).toBe('长片段')
    expect(player.sourceCursor!.sourceMs).toBeGreaterThan(before.sourceMs)
    const continued = player.sourceCursor!.sourceMs
    // 重映射进入包不消费源时间。
    const entry = transport.moves.at(-1)!
    expect(entry.position).toBeGreaterThanOrEqual(40)
    expect(entry.position).toBeLessThanOrEqual(70)
    await clock.advance(entry.durationMs / 2)
    player.pause()
    expect(player.sourceCursor!.sourceMs).toBeCloseTo(continued, 8)
    player.resume()
    await clock.advance(1)
    expect(player.sourceCursor!.sourceMs).toBeCloseTo(continued, 8)
  })

  it('commits half-packet source time, freezes it through pause, and reenters under tightened limits', async () => {
    const { player, clock, transport, config } = setup()
    player.setAdjust({ speed: 100 })
    player.reveal(intent, 5000)
    await clock.advance(1000)
    const packet = transport.moves.at(-1)!
    const before = player.sourceCursor!.sourceMs
    await clock.advance(packet.durationMs * 0.371)
    player.pause()
    const half = player.sourceCursor!.sourceMs
    expect(half).toBeGreaterThan(before)
    expect(half).not.toBe(Math.round(half))
    const remaining = player.remainingMs()
    player.configure({ ...config, minPosition: 30, maxPosition: 60, maxSpeed: 100 })
    player.setAdjust({ bounds: [35, 55], speed: 80 })
    expect(player.sourceCursor!.sourceMs).toBeCloseTo(half, 8)
    await clock.advance(10000)
    expect(player.remainingMs()).toBe(remaining)
    const count = transport.moves.length
    player.resume()
    await flush()
    expect(transport.moves[count]!.position).toBeGreaterThanOrEqual(35)
    expect(transport.moves[count]!.position).toBeLessThanOrEqual(55)
    expect(player.sourceCursor!.sourceMs).toBeCloseTo(half, 8)
  })

  it('uses the post-consume cursor for adjustments made while move Promise is pending; stale completion cannot send', async () => {
    const { player, clock, transport } = setup(library(), true)
    player.reveal(intent, 5000)
    await flush()
    transport.delay = false
    transport.release!()
    await clock.advance(1000)
    transport.delay = true
    // 下一包进入等待，之后做连续快调。
    await clock.advance(1000)
    const before = player.sourceCursor!.sourceMs
    player.setAdjust({ speed: 75 })
    player.setAdjust({ speed: 60 })
    await clock.advance(200)
    transport.delay = false
    transport.release!()
    await clock.advance(1000)
    expect(player.sourceCursor!.sourceMs).toBeGreaterThan(before)
    transport.delay = true
    await clock.advance(2000)
    player.stop('user')
    const count = transport.moves.length
    transport.release?.()
    await clock.advance(10000)
    expect(transport.moves).toHaveLength(count)
    expect(player.intent).toBeNull()
  })

  it('preserves loop pass and tail-loop source position during remap', () => {
    const config = legacyMotion()
    const clip = defaultActionLibrary().library.clips.find(c => c.name === '渐快')!
    const active = new PresetPlayback(intent, config, clip, {})
    while (active.cursor().pass < 2) { const p = active.next()!; active.consume(p, p.durationMs) }
    const p = active.next()!
    active.consume(p, p.durationMs / 3)
    const cursor = active.cursor()
    const next = new PresetPlayback({ ...intent, tier: 'medium' }, config, clip, {}, { speed: 100 }, cursor)
    expect(next.cursor()).toEqual(cursor)
    expect(next.cursor().sourceMs).toBeGreaterThanOrEqual(clip.loopFromMs!)
    const entry = next.next()!
    next.consume(entry, entry.durationMs)
    expect(next.cursor()).toEqual(cursor)
    while (next.cursor().pass === cursor.pass) { const p = next.next()!; next.consume(p, p.durationMs) }
    expect(next.cursor().sourceMs).toBe(clip.loopFromMs)
  })

  it('does not revive a completed selection through any inheritance; explicit other action and stop can start', async () => {
    const { player, clock, transport, stopped } = setup()
    player.reveal(intent, undefined)
    await clock.advance(200000)
    expect(stopped).toEqual(['complete'])
    const count = transport.moves.length
    for (const choice of [undefined, intent, { ...intent, tier: 'high' as const }, { ...intent, action: 'auto' }]) {
      player.reveal(choice, 5000)
      player.reveal(undefined, undefined)
      player.pause(); player.resume()
      player.setAdjust({ speed: 50 })
      await clock.advance(5000)
    }
    expect(transport.moves).toHaveLength(count)
    expect(player.remainingMs()).toBeUndefined()
    player.reveal({ ...intent, action: '稳定节奏', tier: 'medium' }, 5000)
    await clock.advance(1)
    expect(player.presetName).toBe('稳定节奏')
    expect(player.sourceCursor!.pass).toBe(0)
    player.reveal(null, 5000)
    player.reveal(intent, 5000)
    await clock.advance(1)
    expect(player.sourceCursor!.sourceMs).toBe(0)
  })

  it('keeps the existing missed-bubble budget and halts immediately when configure tightens limits', async () => {
    const { player, clock, transport, config, stopped } = setup()
    player.setAdjust({ speed: 50 })
    player.reveal(intent, 5000)
    await clock.advance(1500)
    const remaining = player.remainingMs()
    player.configure({ ...config, minPosition: 40, maxPosition: 60, maxSpeed: 80 })
    expect(transport.stops).toBe(1)
    const source = player.sourceCursor!.sourceMs
    await flush()
    expect(player.sourceCursor!.sourceMs).toBe(source)
    expect(player.remainingMs()).toBe(remaining)
    expect(transport.moves.at(-1)!.limits.maxSpeed).toBeLessThanOrEqual(80)
    await clock.advance(8500)
    expect(stopped).toEqual(['timeout'])
    expect(player.completed).toBe(false)
    expect(player.intent).toBeNull()
  })

  it('stops with an error instead of throwing when a tighter config makes the active tier unavailable', async () => {
    const { player, clock, config, stopped } = setup()
    player.reveal(intent, 5000)
    await clock.advance(1234)
    expect(() => player.configure({ ...config, maxSpeed: 2 })).not.toThrow()
    expect(stopped).toContain('error')
    expect(player.intent).toBeNull()
  })
})
