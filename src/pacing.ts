/** 分段显示的计时；数值不进入提示词。 */

/** 字数：中文按字，纯英文每词折合 2 字。 */
export function textUnits(text: string): number {
  return /^[\x00-\x7f]*$/.test(text)
    ? text.trim().split(/\s+/).filter(Boolean).length * 2
    : (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

/** 普通聊天的打字速度：对方“想一下”的停顿 + 打下一段每个字的耗时，限制在上限内。 */
export const TYPING_SPEEDS = ['fast', 'normal', 'slow'] as const
export type TypingSpeed = typeof TYPING_SPEEDS[number]

export const TYPING_SPEED_LABELS: Record<TypingSpeed, string> = { fast: '快', normal: '中', slow: '慢' }

const TYPING: Record<TypingSpeed, { readonly think: number; readonly perUnit: number; readonly max: number }> = {
  fast: { think: 200, perUnit: 56, max: 2800 },
  normal: { think: 320, perUnit: 88, max: 4000 },
  slow: { think: 480, perUnit: 128, max: 5600 },
}

/** 随机波动 ±25%，避免每段间隔像机器一样整齐。 */
const JITTER = 0.25
const TYPING_MIN_MS = 300

/**
 * 下一段出现前的等待：按下一段的字数估算打字时间。
 * @param random 0–1 的随机数，测试时传固定值。
 */
export function typingDelay(next: string, speed: TypingSpeed, random: () => number = Math.random): number {
  const { think, perUnit, max } = TYPING[speed]
  const base = think + textUnits(next) * perUnit
  const jitter = 1 + (random() * 2 - 1) * JITTER
  return Math.round(Math.min(max, Math.max(TYPING_MIN_MS, base * jitter)))
}

/** 读完一段大约要多久（毫秒），按每秒 6 字。 */
export function readingMs(text: string): number {
  return Math.round(textUnits(text) / 6 * 1000)
}
