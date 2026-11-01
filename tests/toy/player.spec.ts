import { describe, expect, it } from 'vitest'
import { MotionPlayer, type StopCause } from '../../src/toy/client/player.ts'
import { type MotionConfig } from '../../src/toy/core/config.ts'
import type { Intent } from '../../src/toy/core/intent.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { PresetPlayback } from '../../src/toy/motion-library/playback.ts'
import { LAST_STAGE_STOP_MS, STAGE_GRACE_MS } from '../../src/toy/core/safety.ts'
import { FakeClock, flush, MockTransport, legacyMotion } from './fakes.ts'

const full: Intent = { range: 'full', tier: 'low', action: '稳定节奏' }
const upper: Intent = { range: 'upper', tier: 'medium', action: '稳定节奏' }
const library = defaultActionLibrary()

function setup(config: MotionConfig = legacyMotion()) {
  const clock = new FakeClock()
  const transport = new MockTransport(clock)
  const stops: { cause: StopCause; error?: Error }[] = []
  const player = new MotionPlayer(transport, { onStop: (cause, error) => { stops.push({ cause, ...error === undefined ? {} : { error } }) } }, clock)
  player.configure(config)
  player.configureLibrary(library)
  return { clock, transport, player, stops }
}

/** 轨迹给出的、会真正发出去的前 n 个位置。 */
function expected(intent: Intent, n: number, config = legacyMotion()) {
  const clip = library.library.clips.find(c => c.name === intent.action)!
  const playback = new PresetPlayback(intent, config, clip, {})
  const out: number[] = []
  let speed: number | undefined
  let duration = 0
  for (let packet = playback.next(speed, duration); packet !== undefined && out.length < n; packet = playback.next(speed, duration)) {
    if (!packet.hold) { out.push(packet.position); speed = packet.speed }
    playback.consume(packet, packet.durationMs)
    duration = packet.durationMs
  }
  return out
}

/** 第 i 包的实际速度：与上一包目标的距离 ÷ 本包时长。 */
function rateAt(moves: readonly { position: number; durationMs: number }[], i: number): number {
  return Math.abs(moves[i]!.position - moves[i - 1]!.position) * 1000 / moves[i]!.durationMs
}

describe('motion player', () => {
  it('does not send a stale move when a frozen page resumes after the deadline', async () => {
    class DeferredClock extends FakeClock {
      readonly callbacks: (() => void)[] = []
      override set(callback: () => void): unknown { this.callbacks.push(callback); return callback }
      override clear(): void { /* 模拟已经进入页面消息队列的回调。 */ }
    }
    const clock = new DeferredClock()
    const transport = new MockTransport(clock)
    const player = new MotionPlayer(transport, {}, clock)
    player.configure(legacyMotion())
    player.configureLibrary(library)
    player.reveal(full, 1000)
    await flush()
    expect(transport.moves).toHaveLength(1)
    clock.time = 1000 + STAGE_GRACE_MS + 1
    // 运动回调先到，看门狗回调尚未被页面处理。
    clock.callbacks[1]!()
    await flush()
    expect(transport.moves).toHaveLength(1)
    expect(player.intent).toBeNull()
    expect(transport.stops).toBe(1)
    player.dispose()
  })

  it('interpolates the display between packets without sending extra moves', async () => {
    const { clock, transport, player } = setup()
    player.reveal(full, 20000)
    await clock.advance(1000)
    const packet = transport.moves.at(-1)!
    const start = player.displayPosition!
    const count = transport.moves.length
    await clock.advance(Math.floor(packet.durationMs / 2))
    expect(player.displayPosition).toBeCloseTo((start + packet.position) / 2, 0)
    expect(transport.moves).toHaveLength(count)
    player.pause()
    const stopped = player.displayPosition
    await clock.advance(100)
    expect(player.displayPosition).toBe(stopped)
    player.dispose()
  })
  it('plays the generated packets with the packet speed as the limit', async () => {
    const { clock, transport, player } = setup()
    player.reveal(full, 20000)
    await clock.advance(5000)
    expect(transport.moves[0]).toMatchObject({ position: 0, durationMs: 1000, at: 0 })
    expect(transport.moves.map(m => m.position)).toEqual(expected(full, transport.moves.length))
    expect(transport.moves.every(m => m.limits.maxSpeed <= 500 && m.limits.minPosition === 0 && m.limits.maxPosition === 100)).toBe(true)
  })

  it('keeps the rhythm when the same selection is revealed again', async () => {
    const { clock, transport, player } = setup()
    player.reveal(full, 2000)
    await clock.advance(1500)
    player.reveal({ ...full }, 2000)
    player.reveal(undefined, 2000)
    await clock.advance(3000)
    expect(transport.stops).toBe(0)
    expect(transport.moves.map(m => m.position)).toEqual(expected(full, transport.moves.length))
  })

  it('switches selection after the packet in flight and re-enters from the unknown position', async () => {
    const { clock, transport, player } = setup()
    player.reveal(full, 5000)
    await clock.advance(500)
    player.reveal(upper, 5000)
    expect(transport.moves).toHaveLength(1)
    await clock.advance(499)
    expect(transport.moves).toHaveLength(1)
    await clock.advance(1)
    // 第二包是 upper 的进入包：起点 70，按离 0 最远的 70 计算。
    expect(transport.moves[1]).toMatchObject({ position: 70, at: 1000 })
    expect(transport.stops).toBe(0)
  })

  it('stops when the next stage does not arrive in time', async () => {
    const { clock, transport, player, stops } = setup()
    player.reveal(full, 1000)
    await clock.advance(1000 + STAGE_GRACE_MS - 1)
    expect(stops).toEqual([])
    await clock.advance(1)
    expect(stops).toEqual([{ cause: 'timeout' }])
    expect(transport.stops).toBe(1)
    const count = transport.moves.length
    await clock.advance(10000)
    expect(transport.moves).toHaveLength(count)
    expect(player.intent).toBeNull()
  })

  it('stops 30 seconds after the last stage, and each reveal resets the watchdog', async () => {
    const { clock, player, stops } = setup()
    player.reveal(full, 1000)
    await clock.advance(4000)
    player.reveal(undefined, undefined)
    await clock.advance(LAST_STAGE_STOP_MS - 1)
    expect(stops).toEqual([])
    await clock.advance(1)
    expect(stops).toEqual([{ cause: 'timeout' }])
  })

  it('stops immediately on a stop stage or a program stop', async () => {
    const { clock, transport, player, stops } = setup()
    player.reveal(full, 5000)
    await clock.advance(200)
    player.reveal(null, 5000)
    expect(transport.stops).toBe(1)
    await clock.advance(10000)
    expect(transport.moves).toHaveLength(1)
    expect(stops).toEqual([])
    player.reveal(full, 5000)
    await clock.advance(10)
    player.stop('user')
    expect(stops).toEqual([{ cause: 'user' }])
    expect(player.intent).toBeNull()
  })

  it('pause freezes motion and the watchdog; resume re-enters and keeps the remaining time', async () => {
    const { clock, transport, player, stops } = setup()
    player.reveal(full, 10000)
    await clock.advance(5000)
    player.pause()
    const count = transport.moves.length
    expect(transport.stops).toBe(1)
    player.reveal(upper, 10000)
    await clock.advance(60000)
    expect(transport.moves).toHaveLength(count)
    expect(stops).toEqual([])
    player.resume()
    await flush()
    expect(transport.moves[count]).toMatchObject({ position: 70 })
    // 暂停期间的 reveal 把看门狗重设为 10000 + 余量，从恢复时开始算。
    await clock.advance(10000 + STAGE_GRACE_MS - 1)
    expect(stops).toEqual([])
    await clock.advance(1)
    expect(stops).toEqual([{ cause: 'timeout' }])
  })

  it('stops when the device disconnects or a send fails', async () => {
    const a = setup()
    a.player.reveal(full, 5000)
    await a.clock.advance(100)
    a.transport.setPhase('disconnected')
    expect(a.stops).toEqual([{ cause: 'disconnected' }])
    expect(a.player.intent).toBeNull()

    const b = setup()
    b.transport.fail = new Error('boom')
    b.player.reveal(full, 5000)
    await b.clock.advance(100)
    expect(b.stops.map(s => [s.cause, s.error?.message])).toEqual([['error', 'boom']])
    expect(b.player.intent).toBeNull()
  })

  it('re-enters under new limits when the configuration changes', async () => {
    const { clock, transport, player } = setup()
    player.reveal(full, 20000)
    await clock.advance(2500)
    const count = transport.moves.length
    player.configure({ ...legacyMotion(), minPosition: 20, maxPosition: 60 })
    expect(transport.stops).toBe(1)
    await clock.advance(1)
    expect(transport.moves[count]).toMatchObject({ position: 20, limits: { minPosition: 20, maxPosition: 60 } })
    await clock.advance(5000)
    expect(transport.moves.slice(count).every(m => m.position >= 20 && m.position <= 60)).toBe(true)
  })

  it('ramps up from the speed in use when switching to a faster selection', async () => {
    const { clock, transport, player } = setup()
    const fast: Intent = { ...full, tier: 'high' }
    player.reveal(full, 20000)
    await clock.advance(3000)
    const count = transport.moves.length
    player.reveal(fast, 20000)
    await clock.advance(1500)
    // 慢档中值 100，进入包和随后几包都不超过 100 + 升速。
    const after = transport.moves.slice(count)
    expect(after[0]?.limits.maxSpeed).toBeLessThanOrEqual(100)
    await clock.advance(10000)
    // 实际速度（距离÷时长）升到快档中值 425，上限字段不低于它。
    expect(rateAt(transport.moves, transport.moves.length - 1)).toBeGreaterThan(400)
    expect(rateAt(transport.moves, transport.moves.length - 1)).toBeLessThanOrEqual(transport.moves.at(-1)!.limits.maxSpeed)
  })

  it('slows down at once, and restarts from the slow tier after a pause', async () => {
    const { clock, transport, player } = setup()
    const fast: Intent = { ...full, tier: 'high' }
    player.reveal(fast, 20000)
    await clock.advance(10000)
    expect(rateAt(transport.moves, transport.moves.length - 1)).toBeGreaterThan(400)
    let count = transport.moves.length
    player.reveal(full, 20000)
    await clock.advance(1000)
    // 换到慢档后立即按慢档中值 100 运动，不渐降。
    for (let i = count + 2; i < transport.moves.length; i++) expect(rateAt(transport.moves, i)).toBeLessThanOrEqual(101)
    player.reveal(fast, 20000)
    await clock.advance(10000)
    player.pause()
    count = transport.moves.length
    player.resume()
    await flush()
    expect(transport.moves[count]?.limits.maxSpeed).toBeLessThanOrEqual(100)
  })

  it('reports a selection the limits cannot express and stays still', async () => {
    const { clock, transport, player, stops } = setup({ ...legacyMotion(), maxSpeed: 2, speedBreakpoints: [0, 1] })
    player.reveal({ ...full, tier: 'high' }, 5000)
    await clock.advance(100)
    expect(stops[0]?.cause).toBe('error')
    expect(transport.moves).toEqual([])
  })
})
