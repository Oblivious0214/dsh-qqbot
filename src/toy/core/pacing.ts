/**
 * 设备在动时的段落停留时间。只改显示节奏，不进提示词。
 * 这一段换了新动作：停满“节奏”秒数，让用户感受完整个动作；
 * 动作没变的接续段：只停到读完（至少 CONTINUE_MIN_MS），不超过节奏秒数。
 * 设备停着或普通聊天时不用这里，仍按 qqbot 的打字节奏。
 */

import { readingMs } from '../../pacing.ts'

export interface MotionPacing {
  /** 新动作段落停留的秒数。 */
  readonly seconds: number
}

export const DEFAULT_PACING: MotionPacing = Object.freeze({ seconds: 5 })
export const PACING_SECONDS = { min: 1, max: 120 } as const
const CONTINUE_MIN_MS = 2000

/** 旧版本保存的 min/max/speed 没有 seconds，按默认处理。 */
export function parsePacing(value: unknown): MotionPacing {
  if (!value || typeof value !== 'object') throw new Error('设备运动时段落间隔设置无效')
  const { seconds = DEFAULT_PACING.seconds } = value as Partial<MotionPacing>
  if (!Number.isInteger(seconds) || seconds < PACING_SECONDS.min || seconds > PACING_SECONDS.max) {
    throw new Error(`设备运动时段落间隔须为 ${PACING_SECONDS.min}–${PACING_SECONDS.max} 的整数秒`)
  }
  return { seconds }
}

/** 等待毫秒数。fresh：这一段写了新动作。 */
export function pacingHold(text: string, fresh: boolean, pacing: MotionPacing): number {
  const full = pacing.seconds * 1000
  if (fresh) return full
  return Math.min(full, Math.max(CONTINUE_MIN_MS, readingMs(text)))
}
