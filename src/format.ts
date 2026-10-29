/**
 * 格式规则：分段（`qqbot:format-segment`）和表情（`qqbot:format-meme`）。
 * 文本都是固定的，只随角色的表情频率和 dsh-meme 是否在场变化，平时不影响前缀缓存。
 */

import { MEME_FREQUENCIES, type MemeFrequency } from './library-types.ts'
import { SEGMENT_PROMPT } from './vendor/dialogue-timing/protocol.js'

/** 分段规则：[qq] 块的格式由 dialogue-timing 协议定义，解析和显示在 dsh-qqbot 的浏览器端。 */
export const SEGMENT_RULE: string = SEGMENT_PROMPT

/** dsh-meme 注册的发图工具。它的提示词段在 qqbot 会话里被 complete section 去掉，用法由这里补上。 */
export const MEME_TOOL = 'send_meme'

export { DEFAULT_MEME_FREQUENCY, MEME_FREQUENCIES, type MemeFrequency } from './library-types.ts'

const FREQUENCY_TEXT: Record<MemeFrequency, string> = {
  low: '表情频率：低。偶尔使用，不要连续几轮都发。',
  medium: '表情频率：适中。气氛合适时使用。',
  high: '表情频率：高。闲聊时积极使用贴合情绪的表情。',
  off: '表情频率：不主动发。只在用户明确要求时发。',
}

export function isMemeFrequency(value: unknown): value is MemeFrequency {
  return typeof value === 'string' && (MEME_FREQUENCIES as readonly string[]).includes(value)
}

/**
 * 表情规则。发送方式（Web 写标记还是走 IM 渠道、纯文字模式）以 send_meme 工具说明和结果为准，这里不重复，
 * 免得和 dsh-meme 的设置冲突；这里只管什么时候发、发多少。
 */
export function memeRule(frequency: MemeFrequency): string {
  return [
    `表情包：用 ${MEME_TOOL} 按情绪或关键词找候选，挑贴合的一张，按工具说明的方式发出。`,
    '一次回复最多一张；用户在说正事时不发。',
    FREQUENCY_TEXT[frequency],
  ].join('\n')
}
