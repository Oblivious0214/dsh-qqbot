import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseActionLibrary, presetRuntime, type ActionLibrary } from '../../src/toy/motion-library/config.ts'
import { builtinLibrary, defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { TIERS } from '../../src/toy/core/config.ts'
import { reduceIntent, type Intent } from '../../src/toy/core/intent.ts'
import { MotionPlayer } from '../../src/toy/client/player.ts'
import { PresetPlayback } from '../../src/toy/motion-library/playback.ts'
import { ToyHost } from '../../src/toy/index.ts'
import { defaultSettings } from '../../src/toy/settings.ts'
import { FakeClock, MockTransport, legacyMotion } from './fakes.ts'
import { ToyController, type SegmentHooks } from '../../src/toy/client/controller.ts'

const auto: Intent = { range: 'full', tier: 'low', action: 'auto' }
const BASICS = ['稳定节奏', '温柔正弦', '渐快', '渐慢', '间歇', '快去慢回', '慢去快回', '滑动']
function setup(library = defaultActionLibrary()) {
  const clock = new FakeClock()
  const transport = new MockTransport(clock)
  const stopped: string[] = []
  const player = new MotionPlayer(transport, { onStop: cause => { stopped.push(cause) } }, clock)
  player.configure(legacyMotion())
  player.configureLibrary(library)
  return { clock, transport, player, stopped }
}
/** 慢档只有一个单次播放的温柔正弦。 */
const once = (): ActionLibrary => {
  const value = defaultActionLibrary()
  return { ...value, library: { ...value.library, clips: value.library.clips.map(c => c.name === '温柔正弦' ? { ...c, playback: 'once' } : c) },
    pools: { ...value.pools, low: [{ name: '温柔正弦', weight: 'medium' }] } }
}

describe('restored library data and persistence', () => {
  it('ships every action as a funscript, with default pools split by tier character', () => {
    const library = builtinLibrary()
    expect(library.clips).toHaveLength(29)
    expect(new Set(library.clips.map(c => c.name)).size).toBe(29)
    expect(library.clips.every(c => c.playback === 'loop' && c.points[0]!.pos === c.points.at(-1)!.pos)).toBe(true)
    for (const name of BASICS) expect(library.clips.some(c => c.name === name)).toBe(true)
    expect(library.clips.some(c => c.name === '标准往复' || c.name === '匀速全抽')).toBe(false)
    const value = parseActionLibrary(defaultActionLibrary())
    // 爆发和温存默认借用高速、低速池，所以低速池偏舒缓、高速池偏激烈。
    const high = (t: typeof TIERS[number]) => value.pools[t].filter(e => e.weight === 'high').map(e => e.name)
    expect(TIERS.map(high)).toEqual([['温柔正弦', '呼吸起伏'], ['稳定节奏'], ['稳定节奏', '强拍律动']])
    expect(TIERS.map(t => value.pools[t].length)).toEqual([8, 9, 8])
    expect(value.pools.low.map(e => e.name)).not.toContain('极限冲刺')
    expect(value.pools.high.map(e => e.name)).toEqual(expect.arrayContaining(['极限冲刺', '中幅爆发']))
    expect(value.pools.high.map(e => e.name)).not.toContain('温柔正弦')
    for (const name of BASICS) expect(TIERS.some(t => value.pools[t].some(e => e.name === name))).toBe(true)
  })

  it('persists separately, rejects stale writes, keeps a backup, and resets with cleanup', () => {
    const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'action-library-'))
    const host = new ToyHost(dir, () => {})
    const original = host.view(undefined).actionLibrary!
    const low = original.pools.low.map((e, i) => i === 0 ? { ...e, weight: 'low' as const } : e)
    host.apply({ action: 'library.save', library: { ...original, pools: { ...original.pools, low } } })
    expect(new ToyHost(dir, () => {}).view(undefined).actionLibrary!.pools.low[0]!.weight).toBe('low')
    expect(() => host.apply({ action: 'library.save', library: original })).toThrow('其他页面')
    host.apply({ action: 'library.save', library: host.view(undefined).actionLibrary })
    expect(JSON.parse(readFileSync(join(dir, 'motion-library.json.bak'), 'utf8')).pools.low[0].weight).toBe('low')
    host.reset()
    expect(host.view(undefined).actionLibrary!.pools.low[0]!.weight).toBe('high')
  })

  it('keeps the action list in runtime and only the selection rule in attached qqbot rules', () => {
    const host = new ToyHost(mkdtempSync(join(process.env['DSH_HOME']!, 'preset-prompt-')), () => {})
    let runtime: (session: { id: string }) => string = () => ''
    host.register({ extension: () => () => {}, runtime: (_name, text) => { runtime = typeof text === 'function' ? text : () => text; return () => {} } })
    host.apply({ action: 'module.enable', enabled: true })
    host.apply({ action: 'settings.save', settings: { ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true } })
    host.apply({ action: 'session.attach', session: 'qq', status: 'ready' })
    const rules = host.view('qq').session!.rules
    expect(rules).toContain('"action":"……"')
    expect(rules).toContain('标了“仅”的只在所列档使用；拿不准时写 auto，由程序从该档动作池选择')
    expect(rules).not.toMatch(/seconds|cycles/)
    expect(rules).not.toMatch(/"preset"|温柔正弦|渐快/)
    const text = runtime({ id: 'qq' })
    expect(text).toContain('可选动作')
    for (const name of BASICS) expect(text).toContain(name)
    expect(text).toContain('向龟头快速推进，回根部时放慢')
    expect(runtime({ id: 'other' })).toBe('')
    expect(presetRuntime(host.view(undefined).actionLibrary!)).not.toContain('motion-')
    expect(host.view('other').session!.rules).toBe('')
  })

  it('lists each action once and marks the tiers of actions not in every pool', () => {
    const value = defaultActionLibrary()
    const entry = (name: string) => ({ name, weight: 'medium' as const })
    // 低速池超出 40 项的名称在该档视为不可用。
    const filler = value.library.clips.map(c => c.name).filter(name => !['滑动', '渐快'].includes(name))
    const low = [...Array.from({ length: 40 }, (_, i) => entry(filler[i % filler.length]!)), entry('渐快')]
    const text = presetRuntime({ ...value, pools: { low, medium: [entry('滑动'), entry('渐快')], high: [entry('滑动'), entry('稳定节奏')] } })
    const line = (name: string) => text.split('\n').filter(l => l.startsWith(`${name}：`))
    expect(line('滑动')).toHaveLength(1)
    expect(line('滑动')[0]).toMatch(/（仅 medium、high）$/)
    expect(line('渐快')[0]).toMatch(/（仅 medium）$/)
    expect(text).not.toMatch(/可用：/)
    expect(text.split('\n')).toHaveLength(new Set([...filler.slice(0, 40), '滑动', '渐快', '稳定节奏']).size)
  })

  it('takes names and auto through action, inherits them, and validates pools', () => {
    const first = reduceIntent(null, auto)!
    expect(first.action).toBe('auto')
    expect(reduceIntent(first, { tier: 'medium' })!.action).toBe('auto')
    expect(reduceIntent(first, { action: '滑动' })!.action).toBe('滑动')
    expect(() => reduceIntent(first, { preset: 'auto' })).toThrow()
    expect(reduceIntent(first, { action: 'Auto' })).toBe(first)
    const value = defaultActionLibrary()
    expect(() => parseActionLibrary({ ...value, pools: { ...value.pools, low: [{ name: 'missing', weight: 'low' }] } })).toThrow('不在动作库')
    expect(() => parseActionLibrary({ ...value, pools: { ...value.pools, low: [] } })).toThrow('至少')
    expect(() => parseActionLibrary({ ...value, pools: { ...value.pools, low: [{ name: '滑动', weight: 'low' }, { name: '滑动', weight: 'high' }] } })).toThrow('重复')
    expect(() => parseActionLibrary({ ...value, pools: { ...value.pools, low: [{ name: '滑动', weight: 'huge' }] } })).toThrow('权重')
    const clips = value.library.clips.map((c, i) => i === 5 ? { ...c, name: 'AUTO' } : c)
    expect(() => parseActionLibrary({ ...value, library: { ...value.library, clips } })).toThrow('auto')
  })
})

describe('every action plays through the same device player', () => {
  it('integrates host settings, model fields, annotations, bubble inheritance and interruption', async () => {
    const host = new ToyHost(mkdtempSync(join(process.env['DSH_HOME']!, 'preset-controller-')), () => {})
    host.settings.save({ ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true })
    const clock = new FakeClock()
    const transport = new MockTransport(clock)
    const controller = new ToyController({ kind: 'buttplug', clock, transport: () => transport, api: {
      async get(session) { return host.view(session) }, async post(action) { return host.view(host.apply(action)) }, beacon() {},
    } })
    let hooks!: SegmentHooks
    controller.connectSegments({ register(value) { hooks = value; return () => {} }, pause: () => () => {} })
    await controller.load()
    await controller.attach('q')
    hooks.revealed!('q', 'r', 0, { text: 'a', motion: { range: 'full', tier: 'low', action: '温柔正弦' } }, 1000)
    await clock.advance(1200)
    expect(controller.livePlayback('q')!.action).toContain('温柔正弦')
    expect(controller.stageAction('q', 'r', 0)).toContain('温柔正弦')
    expect(controller.getSnapshot().moving).toBe(true)
    const stops = transport.stops
    hooks.revealed!('q', 'r', 1, { text: 'b' }, undefined)
    await clock.advance(500)
    expect(transport.stops).toBe(stops)
    // 新消息只打断剩余段落，当前动作仍受自动停止倒计时约束。
    hooks.ended!('q', 'r', 'interrupted')
    await clock.advance(1000)
    expect(controller.getSnapshot().moving).toBe(true)
    await clock.advance(30000)
    expect(controller.getSnapshot().moving).toBe(false)
    controller.dispose()
  })

  it('actually sends packets and keeps the same draw across bubbles', async () => {
    const { clock, player, transport } = setup()
    player.reveal(auto, 10000)
    await clock.advance(1500)
    const name = player.presetName
    expect(name).toBeTruthy()
    expect(transport.moves.length).toBeGreaterThan(1)
    const before = transport.moves.length
    player.reveal({ ...auto }, 10000)
    await clock.advance(1000)
    expect(player.presetName).toBe(name)
    expect(transport.stops).toBe(0)
    expect(transport.moves.length).toBeGreaterThan(before)
  })

  it('plays named actions, and falls back to an auto draw for names outside the pool', async () => {
    const pool = defaultActionLibrary().pools.low.map(e => e.name)
    for (const action of ['渐慢', '慢去快回', '间歇']) {
      const { clock, player, transport } = setup()
      player.reveal({ ...auto, action }, 10000)
      await clock.advance(1500)
      expect(player.presetName).toBe(action)
      expect(transport.moves.length).toBeGreaterThan(1)
    }
    for (const action of ['missing', '深浅跌宕']) {
      const { clock, player, transport } = setup()
      player.reveal({ ...auto, action }, 10000)
      await clock.advance(1500)
      expect(pool).toContain(player.presetName)
      expect(transport.moves.length).toBeGreaterThan(1)
    }
  })

  it('accelerates and decelerates once, then keeps repeating the last round trip', () => {
    const clips = builtinLibrary().clips
    for (const name of ['渐快', '渐慢']) {
      const clip = clips.find(c => c.name === name)!
      expect(clip.loopFromMs).toBe(clip.points.at(-3)!.at)
      for (const tier of TIERS) {
        const source = new PresetPlayback({ ...auto, tier, range: 'full', action: name }, legacyMotion(), clip, {})
        const ends: number[] = []
        let last: number | undefined, lastDuration = 0, elapsed = 0, packet
        while (elapsed < source.passMs + source.loopPassMs * 4 && (packet = source.next(last, lastDuration)) !== undefined) {
          source.consume(packet, packet.durationMs)
          if (!packet.entry) { elapsed += packet.durationMs; if (packet.position === 0 || packet.position === 100) ends.push(elapsed) }
          last = packet.speed; lastDuration = packet.durationMs
        }
        expect(source.loopPassMs).toBeLessThan(source.passMs / 3)
        // 第二遍起只有最后一个往返：两个端点、时长等于 loopPassMs，不再回到起始节奏。
        const after = ends.filter(at => at > source.passMs + 1)
        const legs = after.slice(1).map((at, i) => at - after[i]!)
        const pairs = legs.slice(0, -1).map((ms, i) => ms + legs[i + 1]!).filter((_, i) => i % 2 === 0)
        for (const ms of pairs.slice(1)) expect(Math.abs(ms - source.loopPassMs)).toBeLessThanOrEqual(2)
      }
    }
  })

  it('rejects a loop start that is not an inner point at the end position', () => {
    const value = defaultActionLibrary()
    const clip = value.library.clips.find(c => c.name === '渐快')!
    for (const loopFromMs of [0, 123, clip.points.at(-2)!.at, clip.points.at(-4)!.at]) {
      const clips = value.library.clips.map(c => c.id === clip.id ? { ...c, loopFromMs } : c)
      expect(() => parseActionLibrary({ ...value, library: { ...value.library, clips } })).toThrow('循环起点')
    }
  })

  it('freezes progress on pause, re-enters at the interrupted position, and preserves the watchdog', async () => {
    const { clock, player, transport } = setup(once())
    player.reveal(auto, 20000)
    await clock.advance(1200)
    const name = player.presetName
    player.pause()
    const remaining = player.remainingMs()
    const count = transport.moves.length
    await clock.advance(90000)
    expect(transport.moves).toHaveLength(count)
    expect(player.remainingMs()).toBe(remaining)
    player.resume()
    await clock.advance(1)
    expect(player.presetName).toBe(name)
    expect(transport.moves.at(-1)!.position).not.toBe(10)
    // 单次动作一直重复，到段落间隔加保护余量才由看门狗停下。
    await clock.advance(remaining)
    expect(player.intent).toBeNull()
  })

  it('repeats an AI single clip until the watchdog, and a text-only bubble does not restart it', async () => {
    const { clock, player, stopped, transport } = setup(once())
    player.reveal(auto, undefined)
    expect(player.remainingMs()).toBe(30000)
    await clock.advance(29000)
    expect(stopped).toEqual([])
    await clock.advance(1001)
    expect(stopped).toContain('timeout')
    const count = transport.moves.length
    player.reveal(undefined, undefined)
    await clock.advance(5000)
    expect(transport.moves).toHaveLength(count)
  })

  it('keeps repeating a single clip across stages and after a new selection, named or auto', async () => {
    for (const action of ['温柔正弦', 'auto']) {
      const timed = setup(once())
      timed.player.reveal({ ...auto, action }, 40000)
      await timed.clock.advance(35000)
      timed.player.reveal(undefined, 40000)
      await timed.clock.advance(35000)
      timed.player.reveal({ ...auto, range: 'upper', action }, 40000)
      await timed.clock.advance(35000)
      expect(timed.stopped).toEqual([])
      expect(timed.player.intent).not.toBeNull()
    }
  })

  it('has no whole-selection cap: bubbles keep it going, a missing next stage stops it', async () => {
    const { clock, player, stopped } = setup()
    player.reveal({ ...auto, action: '温柔正弦' }, 10000)
    for (let i = 0; i < 10; i++) { await clock.advance(5000); player.reveal(undefined, 10000) }
    expect(player.intent).not.toBeNull()
    await clock.advance(16000)
    expect(stopped).toContain('timeout')
    expect(player.intent).toBeNull()
  })

  it('stops on library changes and rebuilds the same draw under new limits', async () => {
    const changed = setup()
    changed.player.reveal(auto, 10000)
    await changed.clock.advance(1500)
    changed.player.configureLibrary({ ...defaultActionLibrary(), revision: 1 })
    const count = changed.transport.moves.length
    changed.player.resume()
    await changed.clock.advance(1000)
    expect(changed.transport.moves).toHaveLength(count)
    expect(changed.player.intent).toBeNull()

    const limited = setup()
    limited.player.reveal(auto, 10000)
    await limited.clock.advance(1500)
    const name = limited.player.presetName
    limited.player.configure({ ...legacyMotion(), maxPosition: 50 })
    const before = limited.transport.moves.length
    await limited.clock.advance(2000)
    expect(limited.player.presetName).toBe(name)
    const after = limited.transport.moves.slice(before)
    expect(after.length).toBeGreaterThan(1)
    expect(after.every(move => move.position <= 50)).toBe(true)
  })

  it('maps every builtin into the selected range with both unquantized and quantized limits', () => {
    const value = defaultActionLibrary()
    for (const clip of value.library.clips) for (const tier of TIERS) {
      const config = { ...legacyMotion(), minPosition: 11, maxPosition: 83, maxSpeed: 200 }
      for (const quantize of [undefined, (speed: number) => Math.max(2, Math.floor(speed / 2) * 2)]) {
        const source = new PresetPlayback({ ...auto, tier, range: 'middle' }, config, clip, quantize ? { quantize } : {})
        let last: number | undefined
        let lastPosition: number | undefined
        let lastDuration = 0
        for (let i = 0; i < 120; i++) {
          const packet = source.next(last, lastDuration)!
          expect(packet.position).toBeGreaterThanOrEqual(32)
          expect(packet.position).toBeLessThanOrEqual(61)
          expect(packet.speed).toBeLessThanOrEqual(200)
          expect(packet.durationMs).toBeGreaterThanOrEqual(100)
          if (lastPosition !== undefined && !packet.hold) {
            const actual = quantize ? quantize(packet.speed) : packet.speed
            expect(Math.abs(packet.position - lastPosition) * 1000 / packet.durationMs).toBeLessThanOrEqual(actual + 1e-6)
            expect(packet.speed).toBeLessThanOrEqual(Math.min(200, (last ?? packet.speed) + 60 * lastDuration / 1000) + 1e-6)
          }
          if (!packet.hold) last = packet.speed
          lastPosition = packet.position
          lastDuration = packet.durationMs
          source.consume(packet, packet.durationMs)
        }
      }
    }
  })
})
