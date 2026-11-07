import { HARD_LIMITS } from '../core/config.ts'
import { finite, integer, parsePoints, SCRIPT_LIMITS, type MotionScript } from './script.ts'

export interface PreviewOptions {
  /** 必须由调用者提供用户限制与机内限制的交集，不能来自模型。 */
  readonly minPosition: number
  readonly maxPosition: number
  readonly maxSpeed: number
  readonly startSpeed?: number
  readonly window?: readonly [number, number]
  readonly speedScale?: number
  readonly positionJitter?: number
  readonly timingJitter?: number
  readonly seed?: number
  readonly maxDurationMs?: number
  readonly closedLoop?: boolean
}

export interface PreviewLeg {
  readonly kind: 'entry' | 'move' | 'hold'
  readonly target: number
  readonly durationMs: number
  readonly endsAtMs: number
  readonly sourceAtMs: number
}

export interface MotionPreview {
  readonly kind: 'motion-preview'
  readonly executable: false
  readonly sourceDurationMs: number
  readonly durationMs: number
  readonly retimedLegs: number
  readonly timeStretch: number
  readonly seed: number
  readonly bounds: readonly [number, number]
  readonly legs: readonly PreviewLeg[]
}

/** 固定种子的局部 PRNG，便于复现；不读时间、不改全局随机状态。 */
function random(seed: number): () => number {
  let state = integer(seed, 0, 0xffff_ffff, '随机种子')
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function bounds(low: number, high: number): readonly [number, number] {
  finite(low, 0, 100, '行程下限')
  finite(high, 0, 100, '行程上限')
  const pair = [Math.ceil(low), Math.floor(high)] as const
  if (pair[0] >= pair[1]) throw new Error('行程没有可表达的整数区间')
  return pair
}

/** 有限的可视化轨迹，不能作为播放器 Packet 使用；不实现调度、授权或传输。 */
export function previewScript(script: MotionScript, options: PreviewOptions): MotionPreview {
  const points = parsePoints(script.points)
  const sourceDurationMs = points[points.length - 1]!.at
  if (points[0]!.at !== 0 || sourceDurationMs > SCRIPT_LIMITS.clipDurationMs) throw new Error('请先截取从零开始、不超过 600 秒的片段')
  if (options.closedLoop !== undefined && typeof options.closedLoop !== 'boolean') throw new Error('循环标记无效')
  if (options.closedLoop && Math.abs(points[0]!.pos - points[points.length - 1]!.pos) > 1e-6) throw new Error('循环首尾不闭合')
  let [low, high] = bounds(options.minPosition, options.maxPosition)
  if (options.window !== undefined) {
    if (!Array.isArray(options.window) || options.window.length !== 2) throw new Error('预览窗口须为两个数')
    const [a, b] = bounds(options.window[0], options.window[1])
    ;[low, high] = bounds(Math.max(low, a), Math.min(high, b))
  }
  const speed = finite(options.maxSpeed, HARD_LIMITS.minSpeed, HARD_LIMITS.maxSpeed, '速度上限')
  const startSpeed = Math.min(speed, finite(options.startSpeed ?? Math.min(20, speed), HARD_LIMITS.minSpeed, HARD_LIMITS.maxSpeed, '进入速度'))
  const scale = finite(options.speedScale ?? 1, 0.25, 4, '速度倍率')
  const jitter = finite(options.positionJitter ?? 0, 0, 10, '位置变化幅度')
  const timing = finite(options.timingJitter ?? 0, 0, 0.25, '时长变化比例')
  const budget = integer(options.maxDurationMs ?? 30_000, 100, SCRIPT_LIMITS.previewDurationMs, '预览总时长上限')
  const seed = options.seed ?? 0
  const rng = random(seed)
  let anchor: number | undefined
  const map = (pos: number) => {
    const atSeam = options.closedLoop && Math.abs(pos - points[0]!.pos) <= 1e-6
    if (atSeam && anchor !== undefined) return anchor
    const target = Math.max(low, Math.min(high, Math.round(low + (high - low) * pos / 100 + (rng() * 2 - 1) * jitter)))
    if (atSeam) anchor = target
    return target
  }
  const legs: PreviewLeg[] = []
  let durationMs = 0
  let retimedLegs = 0
  let previous = map(points[0]!.pos)
  const push = (kind: PreviewLeg['kind'], target: number, duration: number, sourceAtMs: number) => {
    durationMs += duration
    if (durationMs > budget) throw new Error('限速后的预览超过时长上限，请缩短片段或减少变化')
    legs.push({ kind, target, durationMs: duration, endsAtMs: durationMs, sourceAtMs })
  }
  // 位置未知时，以设备 0–100 全程内到目标的最坏距离估算进入用时。
  push('entry', previous, Math.max(100, Math.ceil(Math.max(previous, 100 - previous) / startSpeed * 1000)), 0)
  const requestedLegs: { target: number; requested: number; sourceAtMs: number }[] = []
  let timeStretch = 1
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!
    const before = points[i - 1]!
    // 原脚本的停留不因位置抖动变成运动。
    const target = point.pos === before.pos ? previous : map(point.pos)
    const requested = (point.at - before.at) / scale * (1 + (rng() * 2 - 1) * timing)
    timeStretch = Math.max(timeStretch, 100 / requested, Math.abs(target - previous) / speed * 1000 / requested)
    requestedLegs.push({ target, requested, sourceAtMs: point.at })
    previous = target
  }
  previous = legs[0]!.target
  for (const leg of requestedLegs) {
    const duration = Math.ceil(leg.requested * timeStretch)
    if (duration > Math.ceil(leg.requested)) retimedLegs++
    push(leg.target === previous ? 'hold' : 'move', leg.target, duration, leg.sourceAtMs)
    previous = leg.target
  }
  return { kind: 'motion-preview', executable: false, sourceDurationMs, durationMs, retimedLegs, timeStretch, seed, bounds: [low, high], legs }
}

export interface StandbySampleOptions {
  readonly cycles: number
  readonly highRange: readonly [number, number]
  readonly speedRange: readonly [number, number]
  readonly seed: number
}

/** 仅生成有限的往返样本，不监听空闲、不启动待机。位置是片段的相对坐标。 */
export function createStandbySample(options: StandbySampleOptions): MotionScript {
  const cycles = integer(options.cycles, 1, 20, '样本往返数')
  if (!Array.isArray(options.highRange) || options.highRange.length !== 2
    || !Array.isArray(options.speedRange) || options.speedRange.length !== 2) throw new Error('样本范围须为两个数')
  const [lo, hi] = options.highRange
  finite(lo, 1, 100, '样本高点下限')
  finite(hi, lo, 100, '样本高点上限')
  const [slow, fast] = options.speedRange
  finite(slow, HARD_LIMITS.minSpeed, HARD_LIMITS.maxSpeed, '样本速度下限')
  finite(fast, slow, HARD_LIMITS.maxSpeed, '样本速度上限')
  const rng = random(options.seed)
  const points = [{ at: 0, pos: 0 }]
  let at = 0
  for (let i = 0; i < cycles; i++) {
    const high = lo + (hi - lo) * rng()
    for (const pos of [high, 0]) {
      const speed = slow + (fast - slow) * rng()
      at += Math.max(100, Math.ceil(high / speed * 1000))
      if (at > SCRIPT_LIMITS.clipDurationMs) throw new Error('待机样本超过 600 秒，请减少往返数')
      points.push({ at, pos })
    }
  }
  return { points }
}
