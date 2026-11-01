/**
 * 动作意图：AI 只选范围、速度档和动作名，程序换算成实际坐标和速度。
 * 迁移自 dsh-serveu 的 definition-protocol.js（reduceIntent、describeIntent），去掉了 protocol 标记字段。
 * 动作全部来自动作库；名称不在该档动作池里时由播放器按 auto 处理。
 */

import { rangeCoordinates, RANGES, TIERS, type MotionConfig, type RangeName, type Tier } from './config.ts'

/** 由程序从该档动作池抽取。 */
export const AUTO_ACTION = 'auto'

/** 一个完整的动作选择。 */
export interface Intent {
  readonly range: RangeName
  readonly tier: Tier
  /** 动作库里的名称（已做 NFKC 和去空格），或 auto。 */
  readonly action: string
}

/** 段落里的 motion 字段：三项，或 `{ "stop": true }`。提示词只教写全，只写变化项也接受。 */
export type MotionCommand = Partial<Intent> | { readonly stop: true }

export const RANGE_LABELS: Record<RangeName, string> = {
  full: '全程', lower_half: '偏根部半程', upper_half: '偏龟头半程', lower: '根部', middle: '中段', upper: '龟头',
}
export const TIER_LABELS: Record<Tier, string> = { low: '慢', medium: '中', high: '快' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 规整动作名：去空格、NFKC；auto 不分大小写。不合法时返回 undefined。 */
export function actionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.normalize('NFKC').trim()
  if (!text || text.length > 60 || /[\u0000-\u001f\u007f]/u.test(text)) return undefined
  return text.toLowerCase() === AUTO_ACTION ? AUTO_ACTION : text
}

/**
 * 在上一个选择上应用一条 motion，返回新的选择；`stop` 返回 null。
 * 字段相同时返回 previous 本身，调用方据此判断"没有变化，不重启节奏"。
 * 首次启动或停止之后必须三项齐全，否则抛出。
 */
export function reduceIntent(previous: Intent | null, command: unknown): Intent | null {
  if (!isRecord(command)) throw new Error('motion 须为对象')
  if (command['stop'] === true && Object.keys(command).length === 1) return null
  const keys = Object.keys(command)
  if (keys.some(key => key !== 'range' && key !== 'tier' && key !== 'action')) {
    throw new Error('motion 只接受 range、tier、action 或 stop')
  }
  const pick = <T extends string>(key: string, choices: readonly T[], fallback: T | undefined): T | undefined => {
    if (!Object.hasOwn(command, key)) return fallback
    const value = command[key]
    if (!choices.includes(value as T)) throw new Error(`motion.${key} 无效`)
    return value as T
  }
  const range = pick('range', RANGES, previous?.range)
  const tier = pick('tier', TIERS, previous?.tier)
  let action = previous?.action
  if (Object.hasOwn(command, 'action')) {
    action = actionName(command['action'])
    if (action === undefined) throw new Error('motion.action 无效')
  }
  if (range === undefined || tier === undefined || action === undefined) {
    throw new Error('首次启动或停止后，motion 须写全 range、tier、action')
  }
  if (previous !== null && previous.range === range && previous.tier === tier && previous.action === action) return previous
  return { range, tier, action }
}

/** 实际坐标区间（小数），已含高速小行程的缩短。 */
export function intentPosition(intent: Intent, config: MotionConfig): readonly [number, number] {
  let position = rangeCoordinates(config)[intent.range]
  const high = config.tiers.high
  if (intent.tier === 'high' && high.rangePreference === 'local') {
    const center = (position[0] + position[1]) / 2
    const half = (position[1] - position[0]) * (100 - high.localShrinkPercent) / 100 / 2
    position = [center - half, center + half]
  }
  return position
}

export function sameIntent(a: Intent | null, b: Intent | null): boolean {
  return a === b || (a !== null && b !== null && a.range === b.range && a.tier === b.tier && a.action === b.action)
}
