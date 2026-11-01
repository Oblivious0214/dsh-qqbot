/**
 * 程序直接驱动的位移包：手动定位，以及动作轨迹共用的限位、快调和包间隔规则。纯函数，不碰设备和计时器。
 * AI 选的动作全部来自动作库，由 motion-library/playback.ts 播放。
 *
 * 规则迁移自 dsh-serveu 的 definition-output.js（packetizeLeg、outputRange）：
 * - 每一程切成至少 100 ms 一包，同一程的包等长；取整或蓝牙速度量化只会让它变慢，不会变快。
 * - 升速有上限：每秒最多加 RAMP_UP。降速和停止不受限制。
 */

import { HARD_LIMITS, tierBudget, type MotionConfig } from './config.ts'
import { intentPosition, type Intent } from './intent.ts'

/** 两包之间的最短间隔。 */
export const MIN_INTERVAL_MS = 100
/** 升速上限（unit/s²）。默认配置下慢档到快档约 5.5 秒。 */
export const RAMP_UP = 60

export interface Packet {
  /** 目标位置，0–100 的整数。 */
  readonly position: number
  readonly durationMs: number
  /** 本包允许的速度上限（unit/s，整数）。hold 包不发送，这个值没有意义。 */
  readonly speed: number
  /** 位置不变，只等待，不发送。 */
  readonly hold: boolean
  /** 第一包：从未知位置移到起点。 */
  readonly entry?: true
  /** 一次往返的最后一包。 */
  readonly cycleEnd?: true
}

/** 传输方式对速度的量化：给定想要的速度，返回设备实际会用的速度（不大于输入）。Buttplug 不量化。 */
export interface MotionProfile {
  readonly quantize?: (speed: number) => number
}

/**
 * 右栏的本场实际参数，只存在内存里；未指定的项跟随 AI。
 * 最终仍按总设置的行程和速度上限截断。
 */
export interface LiveAdjust {
  readonly bounds?: readonly [number, number]
  readonly speed?: number
}
export const NO_ADJUST: LiveAdjust = {}

export interface LiveMotion {
  readonly bounds: readonly [number, number]
  /** 目标速度（unit/s），实际轨迹仍受进入限速、升速及设备精度约束。 */
  readonly speed: number
}

/** 用户选定的实际窗口按总行程截断，至少留一格；未手动选择时使用 AI 范围。 */
export function adjustBounds(bounds: readonly [number, number], config: MotionConfig, adjust: LiveAdjust = NO_ADJUST): readonly [number, number] {
  if (adjust.bounds === undefined) return bounds
  const low = Math.max(config.minPosition, Math.min(config.maxPosition - 1, Math.round(adjust.bounds[0])))
  const high = Math.max(low + 1, Math.min(config.maxPosition, Math.round(adjust.bounds[1])))
  return [low, high]
}

/** 界面与执行共用的实际参数；停止时以全行程／慢档为初值，读取不发包。 */
export function liveMotion(intent: Intent | null, config: MotionConfig, adjust: LiveAdjust = NO_ADJUST): LiveMotion {
  let speed: number
  try { speed = tierBudget(config, intent?.tier ?? 'low').nominal }
  catch { speed = HARD_LIMITS.minSpeed }
  return {
    bounds: adjustBounds(intent === null || adjust.bounds !== undefined ? [config.minPosition, config.maxPosition] : outputBounds(intent, config), config, adjust),
    speed: Math.max(HARD_LIMITS.minSpeed, Math.min(config.maxSpeed, Math.round(adjust.speed ?? speed))),
  }
}

/** 实际坐标向内取整，不扩大 AI 选的范围。 */
export function outputBounds(intent: Intent, config: MotionConfig): readonly [number, number] {
  const [a, b] = intentPosition(intent, config)
  // `+ 0` 把 Math.ceil(-1e-9) 得到的 -0 规整成 0。
  const bounds = [Math.ceil(a - 1e-9) + 0, Math.floor(b + 1e-9) + 0] as const
  if (bounds[1] <= bounds[0]) throw new Error('设备精度无法表达此行程，不会自动扩大范围')
  return bounds
}

/** 手动定位的慢速：慢档下限附近，不超过总设置的速度上限。 */
export function gentleSpeed(config: MotionConfig): number {
  let speed: number
  try {
    const low = tierBudget(config, 'low')
    speed = low.min + (low.max - low.min) / 4
  } catch {
    speed = HARD_LIMITS.minSpeed * 5
  }
  return Math.max(HARD_LIMITS.minSpeed, Math.floor(Math.min(speed, config.maxSpeed)))
}

/** 手动定位：0–100 映射到总设置的行程内。 */
export function manualPosition(value: number, config: MotionConfig): number {
  const clamped = Math.max(0, Math.min(100, value))
  return Math.round(config.minPosition + (config.maxPosition - config.minPosition) * clamped / 100)
}

/**
 * 手动定位：以慢速移到 target 后停住（之后只有等待包）。from 是上一包已走完的位置；未知时按 0–100 全程最坏距离限速。
 */
export function* manualPackets(target: number, config: MotionConfig, profile: MotionProfile = {}, from?: number): Generator<Packet, never, undefined> {
  const quantize = profile.quantize ?? ((speed: number) => speed)
  const position = Math.max(config.minPosition, Math.min(config.maxPosition, Math.round(target)))
  const speed = gentleSpeed(config)
  const actual = quantize(speed)
  if (actual < HARD_LIMITS.minSpeed) throw new Error('该动作速度低于设备可表达范围')
  const distance = from === undefined
    ? Math.max(position - HARD_LIMITS.minPosition, HARD_LIMITS.maxPosition - position)
    : Math.abs(position - from)
  yield {
    position, speed, hold: from !== undefined && distance === 0,
    durationMs: Math.max(MIN_INTERVAL_MS, Math.ceil(distance * 1000 / actual)),
    ...from === undefined ? { entry: true as const } : {},
  }
  while (true) yield { position, speed, hold: true, durationMs: 200 }
}
