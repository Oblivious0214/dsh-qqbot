import { describe, expect, it } from 'vitest'
import { bluetoothQuantize, decodedSpeed, decodeDeviceInfo, speedCode } from '../../src/toy/core/bluetooth-codec.ts'
import { defaultMotion, parseMotion, RANGES, speedBands, TIERS, type MotionConfig } from '../../src/toy/core/config.ts'
import { reduceIntent, type Intent } from '../../src/toy/core/intent.ts'
import { MIN_INTERVAL_MS, outputBounds, RAMP_UP, type MotionProfile, type Packet } from '../../src/toy/core/motion.ts'
import { parseStream, resolveStageIntents } from '../../src/toy/core/replies.ts'
import { DEFAULT_BEHAVIOR, DEFAULT_PROACTIVITY_TEXTS, deviceRules, preferenceLine } from '../../src/toy/core/rules.ts'
import { legacyMotion } from './fakes.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { PresetPlayback } from '../../src/toy/motion-library/playback.ts'

const full: Intent = { range: 'full', tier: 'low', action: '稳定节奏' }
const library = defaultActionLibrary()
const clip = (name: string) => library.library.clips.find(c => c.name === name)!

function withConfig(patch: Partial<MotionConfig>): MotionConfig {
  return parseMotion({ ...defaultMotion(), ...patch })
}

/** 像播放器一样取包：每包按上一包速度和时长升速。 */
function packets(intent: Intent, config: MotionConfig, profile: MotionProfile = {}, limit = 300): Packet[] {
  const playback = new PresetPlayback(intent, config, clip(intent.action), profile)
  const out: Packet[] = []
  let speed: number | undefined
  let duration = 0
  for (let packet = playback.next(speed, duration); packet !== undefined && out.length < limit; packet = playback.next(speed, duration)) {
    out.push(packet)
    playback.consume(packet, packet.durationMs)
    if (!packet.hold) speed = packet.speed
    duration = packet.durationMs
  }
  return out
}

describe('motion config', () => {
  it('round-trips the defaults and drops unknown fields', () => {
    expect(parseMotion({ ...defaultMotion(), extra: 1 })).toEqual(defaultMotion())
    // 已删除的三档波形不再读取。
    expect(parseMotion({ ...defaultMotion(), tiers: { low: { waveform: 'sine' }, high: defaultMotion().tiers.high } })).toEqual(defaultMotion())
  })

  it('rejects out-of-range values', () => {
    for (const patch of [
      { minPosition: 60, maxPosition: 40 }, { maxPosition: 101 }, { maxSpeed: 501 }, { maxSpeed: 1 },
      { speedBreakpoints: [300, 200] }, { rangeBreakpoints: [0, 70] }, { rangeBreakpoints: [30, 30] },
    ]) {
      expect(() => parseMotion({ ...defaultMotion(), ...patch })).toThrow()
    }
    expect(() => parseMotion({ ...defaultMotion(), tiers: { high: { rangePreference: 'local', localShrinkPercent: 91 } } })).toThrow('0–90')
  })

  it('squeezes speed bands under a low cap', () => {
    expect(speedBands(defaultMotion())).toEqual({ low: 150, high: 300, cap: 500 })
    const bands = speedBands({ maxSpeed: 100, speedBreakpoints: [200, 350] })
    expect(bands.low).toBeLessThan(bands.high)
    expect(bands.high).toBeLessThan(bands.cap)
  })
})

describe('intent', () => {
  it('requires a full first selection, merges later changes and keeps identity when unchanged', () => {
    expect(() => reduceIntent(null, { tier: 'low' })).toThrow('写全')
    const first = reduceIntent(null, full)!
    expect(reduceIntent(first, { action: ' 稳定节奏 ' })).toBe(first)
    expect(reduceIntent(first, { tier: 'high' })).toEqual({ ...full, tier: 'high' })
    expect(reduceIntent(first, { stop: true })).toBeNull()
  })

  it('takes any action name or auto, without a separate basic-action list', () => {
    expect(reduceIntent(null, { range: 'full', tier: 'low', action: 'AUTO' })!.action).toBe('auto')
    expect(reduceIntent(null, { range: 'full', tier: 'low', action: '自己导入的' })!.action).toBe('自己导入的')
    for (const action of ['', ' ', 1, 'x'.repeat(61), 'a\nb']) {
      expect(() => reduceIntent(null, { range: 'full', tier: 'low', action })).toThrow('action')
    }
  })

  it('rejects unknown fields, including the old protocol marker, preset and position/speed', () => {
    for (const command of [{ ...full, protocol: 'intent-v1' }, { preset: 'auto' }, { position: [0, 100] }, { stop: true, tier: 'low' }, { range: 'top' }, 'full', null]) {
      expect(() => reduceIntent(full, command)).toThrow()
    }
  })
})

describe('action playback safety', () => {
  const configs: [string, MotionConfig][] = [
    ['default', defaultMotion()],
    ['narrow and slow', withConfig({ minPosition: 20, maxPosition: 60, maxSpeed: 150 })],
    ['local shrink', parseMotion({ ...defaultMotion(), tiers: { high: { rangePreference: 'local', localShrinkPercent: 50 } } })],
  ]
  const profiles: [string, MotionProfile][] = [['buttplug', {}], ['bluetooth', { quantize: bluetoothQuantize }]]

  it('every builtin action stays inside limits and never moves faster than the packet speed', () => {
    const failures: string[] = []
    for (const [label, config] of configs) for (const [, profile] of profiles) {
      for (const range of RANGES) for (const tier of TIERS) for (const { name } of library.library.clips) {
        const intent = { range, tier, action: name }
        let bounds: readonly [number, number]
        let list: Packet[]
        try { bounds = outputBounds(intent, config); list = packets(intent, config, profile, 120) } catch { continue }
        const quantize = profile.quantize ?? ((s: number) => s)
        let previous: number | undefined
        list.forEach((packet, count) => {
          const fail = (what: string) => { failures.push(`${label}/${range}/${tier}/${name}#${count}: ${what}`) }
          if (!Number.isInteger(packet.position)) fail('position not integer')
          if (packet.position < Math.max(config.minPosition, bounds[0]) || packet.position > Math.min(config.maxPosition, bounds[1])) fail(`position ${packet.position}`)
          if (!Number.isInteger(packet.durationMs) || packet.durationMs < MIN_INTERVAL_MS) fail(`duration ${packet.durationMs}`)
          if (packet.speed > config.maxSpeed) fail(`speed ${packet.speed}`)
          if ((packet.entry === true) !== (count === 0)) fail('entry flag')
          if (previous !== undefined && !packet.hold) {
            const rate = Math.abs(packet.position - previous) * 1000 / packet.durationMs
            if (rate > packet.speed + 1e-9) fail(`rate ${rate} > ${packet.speed}`)
            if (quantize(Math.min(packet.speed, Math.max(2, rate))) > config.maxSpeed) fail('quantized speed')
          }
          previous = packet.position
        })
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
  })

  it('enters from an unknown position at the worst-case distance', () => {
    // upper 起点由轨迹首点 0 映射到 70，离 0 最远 70。慢档中值 100 unit/s。
    expect(packets({ range: 'upper', tier: 'low', action: '稳定节奏' }, legacyMotion(), {}, 1)[0]).toMatchObject({ entry: true, position: 70, durationMs: 700 })
  })

  it('ramps up from the slow tier when there is no previous speed, entry included', () => {
    const list = packets({ ...full, tier: 'high' }, legacyMotion(), {}, 200)
    expect(list[0]).toMatchObject({ entry: true, speed: 100 })
    // 每包速度不超过上一包速度加上 RAMP_UP × 上一包时长（进入包也算）。
    let previous = list[0]!
    for (const packet of list.slice(1)) {
      if (packet.hold) continue
      expect(packet.speed).toBeLessThanOrEqual(previous.speed + RAMP_UP * previous.durationMs / 1000)
      previous = packet
    }
    expect(list.at(-1)!.speed).toBeGreaterThan(300)
  })

  it('repeats a single clip from the start after repeat() and keeps loop clips looping', () => {
    const single = { ...clip('稳定节奏'), playback: 'once' as const }
    const play = (repeat: boolean) => {
      const source = new PresetPlayback(full, legacyMotion(), single, {})
      if (repeat) source.repeat()
      let count = 0
      for (let packet = source.next(); packet !== undefined && count < 2000; packet = source.next(packet.speed, packet.durationMs)) {
        source.consume(packet, packet.durationMs)
        count++
      }
      return count
    }
    expect(play(false)).toBeLessThan(200)
    expect(play(true)).toBe(2000)
  })
})

describe('replies', () => {
  const motion = { range: 'full', tier: 'low', action: '稳定节奏' }

  it('reads closed stages while streaming, ignoring escaped quotes and braces', () => {
    const text = `前言[qq]{"version":1,"stages":[{"text":"a\\"}{[","motion":${JSON.stringify(motion)}},{"text":"b`
    expect(parseStream(text, false)).toEqual({ stages: [{ text: 'a"}{[', motion }], complete: false })
    expect(parseStream('[qq]{"stages":[', false)).toBeNull()
    // 结束时缺 [/qq]：已闭合的段落按完整处理，未闭合的那段不补。
    expect(parseStream(text, true)).toEqual({ stages: [{ text: 'a"}{[', motion }], complete: true })
    expect(() => parseStream('[qq]{"stages":[{"text":"b', true)).toThrow('没有可用段落')
    expect(parseStream('普通回复', true)).toBeNull()
    expect(parseStream('[qq]{"version":1,"stages":[{"text":"a"}]}[/qq]', true)).toEqual({ stages: [{ text: 'a' }], complete: true })
  })

  it('resolves each stage to start, change, stop or keep', () => {
    const stages = [{ text: '1', motion }, { text: '2' }, { text: '3', motion: { tier: 'high' } }, { text: '4', motion: { stop: true } }]
    expect(resolveStageIntents(stages, null)).toEqual([full, undefined, { ...full, tier: 'high' }, null])
    const previous: Intent = { range: 'upper', tier: 'medium', action: '渐快' }
    expect(resolveStageIntents([{ text: '1' }, { text: '2' }], previous)).toEqual([previous, undefined])
    expect(resolveStageIntents([{ text: '1', motion: { action: '稳定节奏' } }], previous)).toEqual([{ ...previous, action: '稳定节奏' }])
    expect(resolveStageIntents([{ text: '1', motion: { stop: true } }, { text: '2', motion: { tier: 'low' } }, { text: '3', motion: full }], previous)).toEqual([null, null, full])
  })

})

describe('rules', () => {
  const base = { motion: defaultMotion(), behavior: DEFAULT_BEHAVIOR, role: { name: '阿黄' } }

  it('omits the proactivity paragraph without a role, including rewritten texts', () => {
    for (const proactivity of [0, 1, 2] as const) {
      const text = deviceRules({ motion: base.motion, behavior: base.behavior, proactivity,
        proactivityTexts: { follow: '自定义跟随', situational: '自定义情境', high: '自定义高自主性' } })
      expect(text).toContain('设备联动')
      expect(text).toContain('补充互动规则')
      expect(text).not.toMatch(/自主性：|自定义跟随|自定义情境|自定义高自主性/)
      expect(text).toContain('"motion":{"stop":true}，等用户要求再继续')
    }
  })

  it('does not change when limits change, so the prompt prefix stays cached', () => {
    const moved = withConfig({ minPosition: 10, maxPosition: 40, maxSpeed: 120, speedBreakpoints: [50, 90], rangeBreakpoints: [20, 80] })
    expect(deviceRules({ ...base, motion: moved, proactivity: 0 })).toBe(deviceRules({ ...base, proactivity: 0 }))
  })

  it('has one fixed paragraph per proactivity level', () => {
    const [zero, one, two] = ([0, 1, 2] as const).map(level => deviceRules({ ...base, proactivity: level }))
    expect(zero).toContain('自主性：低自主性')
    expect(one).toContain('自主性：中自主性')
    expect(two).toContain('自主性：高自主性')
    expect(zero).toContain(DEFAULT_PROACTIVITY_TEXTS.follow)
    expect(one).toContain(DEFAULT_PROACTIVITY_TEXTS.situational)
    expect(two).toContain(DEFAULT_PROACTIVITY_TEXTS.high)
    // 只有 0、1 档要求第一段写停止。
    expect(DEFAULT_PROACTIVITY_TEXTS.high).not.toContain('stop')
    for (const text of [zero, one, two]) expect(text).not.toMatch(/程序已经立即暂停|安全词/)
    expect(deviceRules({ ...base, behavior: '  ', proactivity: 0 })).not.toContain('补充互动规则')
  })

  it('teaches only full motions and leaves out what the program does on its own', () => {
    const text = deviceRules({ ...base, proactivity: 0 })
    expect(text).toContain('每处 motion 都写全三项')
    expect(text).not.toMatch(/只写变化项|30 秒|先写 version|移到起点|相邻档|从 low 开始/)
    expect(text).toContain('默认逐步变化')
    // 方向用身体部位说明，不用坐标；动作只引用运行时的“可选动作”，规则里不列。
    expect(text).toContain('lower=根部，middle=中段，upper=龟头')
    expect(text).toContain('填运行时“可选动作”里的动作名称，标了“仅”的只在所列档使用；拿不准时写 auto')
    expect(text).toContain('由设备执行：用户要求这类动作，就是要求设备开始或改变动作')
    expect(text).not.toMatch(/seconds|cycles|"action":"稳定节奏"/)
    expect(text).not.toMatch(/高坐标|基础动作|快去慢回|slide|steady/)
    // 提示词不教，程序仍接受只写变化项。
    expect(reduceIntent(full, { tier: 'high' })).toEqual({ ...full, tier: 'high' })
  })

  it('adds one preference line after the level paragraph, only when the role card has preferences', () => {
    expect(preferenceLine(undefined)).toBe('')
    expect(preferenceLine({ name: '阿黄' })).toBe('')
    expect(preferenceLine({ name: '阿黄', actions: ['稳定节奏', '滑动'] })).toBe('阿黄偏好动作 稳定节奏、滑动；用户没有提出时优先从中选。')
    expect(preferenceLine({ name: '阿黄', actions: ['滑动'], ranges: ['full', 'upper'] }))
      .toBe('阿黄偏好动作 滑动，范围 full、upper；用户没有提出时优先从中选。')
    const plain = deviceRules({ ...base, proactivity: 0 })
    expect(deviceRules({ ...base, proactivity: 0, role: { name: '阿黄' } })).toBe(plain)
    const preferred = deviceRules({ ...base, proactivity: 0, role: { name: '阿黄', ranges: ['upper'] } })
    expect(preferred).toBe(plain.replace(
      `${DEFAULT_PROACTIVITY_TEXTS.follow}\n`,
      `${DEFAULT_PROACTIVITY_TEXTS.follow}\n阿黄偏好范围 upper；用户没有提出时优先从中选。\n`,
    ))
  })

  it('uses the rewritten text of a level and keeps the level name when the text is cleared', () => {
    const texts = { situational: '自定义情境说明。', high: '' }
    expect(deviceRules({ ...base, proactivity: 0, proactivityTexts: texts })).toBe(deviceRules({ ...base, proactivity: 0 }))
    expect(deviceRules({ ...base, proactivity: 1, proactivityTexts: texts })).toContain('自主性：中自主性。\n自定义情境说明。')
    const cleared = deviceRules({ ...base, proactivity: 2, proactivityTexts: texts })
    expect(cleared).toContain('自主性：高自主性。')
    expect(cleared).not.toContain(DEFAULT_PROACTIVITY_TEXTS.high)
  })
})

describe('bluetooth codec', () => {
  it('decodes 11 and 12 byte D0 replies, rounding travel inward', () => {
    for (const length of [11, 12]) {
      const view = new DataView(new ArrayBuffer(length))
      view.setUint8(0, 83)
      view.setUint16(5, 7999)
      view.setUint16(7, 2001)
      view.setUint16(9, 900)
      expect(decodeDeviceInfo(view)).toMatchObject({ minPosition: 21, maxPosition: 79, maxSpeed: 500 })
    }
    expect(() => decodeDeviceInfo(new DataView(new ArrayBuffer(10)))).toThrow()
  })

  it('never encodes a speed above the requested one', () => {
    for (let speed = 2; speed <= 500; speed++) expect(decodedSpeed(speedCode(speed))).toBeLessThanOrEqual(speed)
  })
})
