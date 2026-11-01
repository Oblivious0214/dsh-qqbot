import { HARD_LIMITS, speedBands, tierBudget, type MotionConfig } from './config.ts'

export interface SafetyWords {
  readonly enabled: boolean
  readonly words: readonly string[]
}
export const DEFAULT_SAFETY_WORDS: SafetyWords = Object.freeze({ enabled: false, words: Object.freeze(['慢一点', '太快了', '轻一点', '受不了了']) })
export const MAX_SAFETY_WORDS = 20
export const MAX_SAFETY_WORD_LENGTH = 40

export function parseSafetyWords(value: unknown): SafetyWords {
  if (!value || typeof value !== 'object') throw new Error('安全词设置无效')
  const { enabled, words } = value as SafetyWords
  if (typeof enabled !== 'boolean' || !Array.isArray(words) || words.length > MAX_SAFETY_WORDS) throw new Error(`安全词最多 ${MAX_SAFETY_WORDS} 个`)
  if (words.some(word => typeof word !== 'string' || !word.trim() || word.trim().length > MAX_SAFETY_WORD_LENGTH)) throw new Error(`每个安全词须为 1–${MAX_SAFETY_WORD_LENGTH} 字`)
  return { enabled, words: [...new Set(words.map(word => word.trim()))] }
}

/** 高→中、中→低；低档内再降 20%，始终不高于当前速度。 */
export function slowerSpeed(speed: number, config: MotionConfig): number {
  const bands = speedBands(config)
  const tier = speed >= bands.high ? 'medium' : speed >= bands.low ? 'low' : undefined
  let target = speed * 0.8
  if (tier !== undefined) {
    try { target = tierBudget(config, tier).nominal } catch { /* 极低上限下继续按比例降低。 */ }
  }
  return Math.max(HARD_LIMITS.minSpeed, Math.min(Math.floor(speed), Math.floor(target)))
}
