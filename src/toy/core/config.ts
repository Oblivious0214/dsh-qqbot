/**
 * 运动配置：用户设定的行程、速度上限、快慢分界、行程分界和高速范围偏好。
 * host 和浏览器共用，纯函数，不碰存储和设备。
 *
 * 换算规则迁移自 dsh-serveu 的 definition-config.js 和 preview.js（speedBands），字段改为 camelCase，
 * 不读旧的 localStorage 记录（旧插件没有发布过，见 CLAUDE.md）。
 */

/** 程序层的绝对上限，任何配置都不能越过。 */
export const HARD_LIMITS = { minPosition: 0, maxPosition: 100, minSpeed: 2, maxSpeed: 500 } as const

export const TIERS = ['low', 'medium', 'high'] as const
export type Tier = (typeof TIERS)[number]

export const RANGES = ['full', 'lower_half', 'upper_half', 'lower', 'middle', 'upper'] as const
export type RangeName = (typeof RANGES)[number]

export interface HighTierPreference {
  /** large：大行程高速；local：小行程高频，选中的范围再围绕中点缩短。 */
  readonly rangePreference: 'large' | 'local'
  /** 只在 local 时生效，0–90。 */
  readonly localShrinkPercent: number
}

export interface MotionConfig {
  /** 自动停止秒数；0 表示不自动停止，缺省 30。 */
  readonly autoStopSeconds?: number
  readonly standby?: { readonly preset: string; readonly minPosition: number; readonly maxPosition: number; readonly maxSpeed: number }
  readonly minPosition: number
  readonly maxPosition: number
  /** unit/s，2–500。 */
  readonly maxSpeed: number
  /** 低/中、中/高的分界，unit/s。 */
  readonly speedBreakpoints: readonly [number, number]
  /** 下端/中间、中间/上端的分界，相对于允许行程的百分比，1–99。 */
  readonly rangeBreakpoints: readonly [number, number]
  readonly tiers: {
    readonly high: HighTierPreference
  }
}

export function defaultMotion(): MotionConfig {
  return {
    autoStopSeconds: 30,
    minPosition: 0,
    maxPosition: 100,
    maxSpeed: 500,
    speedBreakpoints: [150, 300],
    rangeBreakpoints: [30, 70],
    tiers: {
      high: { rangePreference: 'large', localShrinkPercent: 0 },
    },
  }
}

const isInt = (value: unknown): value is number => Number.isInteger(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function pair(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label}须为两个递增的整数`)
  const [a, b] = value as unknown[]
  if (!isInt(a) || !isInt(b) || a >= b) throw new Error(`${label}须为两个递增的整数`)
  return [a, b]
}

/** 校验来自请求或文件的配置，返回只含已知字段的新对象。不合法时抛出中文错误。 */
export function parseMotion(value: unknown): MotionConfig {
  if (!isRecord(value)) throw new Error('运动配置格式无效')
  const autoStopSeconds = value['autoStopSeconds'] ?? 30
  if (!Number.isInteger(autoStopSeconds) || (autoStopSeconds as number) < 0 || (autoStopSeconds as number) > 86400) throw new Error('自动停止须为 0–86400 的整数秒')
  const { minPosition, maxPosition, maxSpeed } = value
  if (!isInt(minPosition) || !isInt(maxPosition) || minPosition < HARD_LIMITS.minPosition
    || maxPosition > HARD_LIMITS.maxPosition || minPosition >= maxPosition) {
    throw new Error('行程须为 0–100 的整数，且下限小于上限')
  }
  if (!isInt(maxSpeed) || maxSpeed < HARD_LIMITS.minSpeed || maxSpeed > HARD_LIMITS.maxSpeed) {
    throw new Error('速度上限须为 2–500 的整数（unit/s）')
  }
  const speedBreakpoints = pair(value['speedBreakpoints'], '快慢分界')
  const rangeBreakpoints = pair(value['rangeBreakpoints'], '行程分界')
  if (rangeBreakpoints[0] < 1 || rangeBreakpoints[1] > 99) throw new Error('行程分界须在 1–99 之间')
  const tiers = value['tiers']
  if (!isRecord(tiers)) throw new Error('高速偏好格式无效')
  const high = tiers['high']
  if (!isRecord(high) || (high['rangePreference'] !== 'large' && high['rangePreference'] !== 'local')) {
    throw new Error('高速范围偏好无效')
  }
  const shrink = high['localShrinkPercent']
  if (!isInt(shrink) || shrink < 0 || shrink > 90) throw new Error('额外行程缩短须为 0–90 的整数百分比')
  let standby: MotionConfig['standby']
  if (value['standby'] !== undefined) {
    const raw = value['standby']
    if (!isRecord(raw) || typeof raw['preset'] !== 'string' || !raw['preset'].trim()) throw new Error('请选择待机动作')
    const lo = raw['minPosition'], hi = raw['maxPosition'], speed = raw['maxSpeed']
    if (!isInt(lo) || !isInt(hi) || lo < minPosition || hi > maxPosition || lo >= hi) throw new Error('待机行程须在总行程内，且下限小于上限')
    if (!isInt(speed) || speed < 2 || speed > maxSpeed) throw new Error('待机速度须在 2 与总速度上限之间')
    if (autoStopSeconds === 0) throw new Error('待机等待时间须大于 0 秒')
    standby = { preset: raw['preset'], minPosition: lo, maxPosition: hi, maxSpeed: speed }
  }
  const config: MotionConfig = {
    autoStopSeconds: autoStopSeconds as number,
    ...standby === undefined ? {} : { standby },
    minPosition, maxPosition, maxSpeed, speedBreakpoints, rangeBreakpoints,
    tiers: {
      high: { rangePreference: high['rangePreference'], localShrinkPercent: shrink },
    },
  }
  speedBands(config)
  return config
}

export interface SpeedBands {
  /** 低速 < low ≤ 中速 < high ≤ 高速 ≤ cap。 */
  readonly low: number
  readonly high: number
  readonly cap: number
}

/**
 * 按速度上限压缩快慢分界：上限变低时分界跟着收拢，三档之间尽量留 10 unit/s 的间隔。
 * 算法照搬旧插件 preview.js 的 speedBands。
 */
export function speedBands(config: Pick<MotionConfig, 'maxSpeed' | 'speedBreakpoints'>): SpeedBands {
  const cap = config.maxSpeed
  const [preferredLow, preferredHigh] = config.speedBreakpoints
  if (!isInt(cap) || cap < HARD_LIMITS.minSpeed || cap > HARD_LIMITS.maxSpeed) throw new Error('速度上限须为 2–500 的整数（unit/s）')
  const lowerBound = cap === 2 ? 0 : 1
  if (preferredLow < lowerBound || preferredHigh >= HARD_LIMITS.maxSpeed || preferredLow >= preferredHigh) {
    throw new Error('两个速度分界点必须递增')
  }
  const gap = Math.max(1, Math.min(10, Math.floor(cap / 3)))
  const high = Math.max(lowerBound + 1, Math.min(Math.round(preferredHigh), cap - gap))
  const low = Math.max(lowerBound, Math.min(Math.round(preferredLow), high - (high < preferredHigh ? gap : 1)))
  return { low, high, cap }
}

export interface TierBudget {
  readonly min: number
  readonly max: number
  readonly nominal: number
}

/** 一个速度档在当前上限下可用的速度区间。上限太低、该档不存在时抛出。 */
export function tierBudget(config: MotionConfig, tier: Tier): TierBudget {
  const bands = speedBands(config)
  const intervals: Record<Tier, [number, number]> = {
    low: [1, bands.low - 1],
    medium: [Math.max(1, bands.low), bands.high - 1],
    high: [Math.max(1, bands.high), bands.cap],
  }
  const [min, max] = intervals[tier]
  if (min > max) throw new Error('当前速度上限下该速度档不可用')
  return { min, max, nominal: (min + max) / 2 }
}

/**
 * 高潮刺激用哪一档：选档时取该档，不可用就往低档找，再往高档找；
 * 自己填速度时取速度所在的档（超过上限按最高可用档）。动作池未单独保存时沿用这一档的池。
 */
export function burstTier(config: MotionConfig, speed: 'medium' | 'high' | number): Tier | undefined {
  const usable = (t: Tier) => { try { tierBudget(config, t); return true } catch { return false } }
  if (typeof speed === 'number') {
    const hit = TIERS.find(t => { try { const b = tierBudget(config, t); return speed >= b.min && speed <= b.max } catch { return false } })
    return hit ?? [...TIERS].reverse().find(usable)
  }
  const order: readonly Tier[] = speed === 'high' ? ['high', 'medium', 'low'] : ['medium', 'low', 'high']
  return order.find(usable)
}

/** 六个范围在允许行程里的实际坐标（可以是小数，输出时再向内取整）。 */
export function rangeCoordinates(config: MotionConfig): Record<RangeName, readonly [number, number]> {
  const { minPosition: min, maxPosition: max } = config
  const [a, b] = config.rangeBreakpoints.map(cut => min + (max - min) * cut / 100) as [number, number]
  const mid = (min + max) / 2
  return { full: [min, max], lower_half: [min, mid], upper_half: [mid, max], lower: [min, a], middle: [a, b], upper: [b, max] }
}

/** 设备报告的机内限制（蓝牙 D0）。 */
export interface HardwareLimits {
  readonly minPosition: number
  readonly maxPosition: number
  readonly maxSpeed: number
}
