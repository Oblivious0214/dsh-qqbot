/**
 * 格式规则：分段、表情和语音。语音说明固定，可用状态通过 runtime 提供。
 */

import { MEME_FREQUENCIES, type MemeFrequency } from './library-types.ts'
import type { MemePreferences } from './library-types.ts'
import { SEGMENT_PROMPT } from './vendor/dialogue-timing/protocol.js'

/** 分段规则：[qq] 块的格式由 dialogue-timing 协议定义，解析和显示在 dsh-qqbot 的浏览器端。 */
export const SEGMENT_RULE: string = SEGMENT_PROMPT

/** 合成和播放仍由界面负责；让模型知道如何回应用户的语音请求。 */
export const VOICE_RULE = `语音：可用状态见运行时 voice 行。默认发文字；语音可用且用户要求语音时，至少一个段落加 "voice":true。按人设和语境偶尔适合用声音时，也可选用语音。语音段在 [qq] 中先写 "voice":true，再写 text，text 写要说的话，不用调工具。一条回复可以文字和语音混发，只有一句语音也用 [qq] 块。例如：
[qq]{"version":1,"stages":[{"text":"我在呢。"},{"voice":true,"text":"晚安，做个好梦。"}]}[/qq]
运行时为“全部转语音”时界面自动转换，不用逐段标记。未启用或没有音色时发文字，按状态提示用户开启语音或给角色选音色。`

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
export function memeRule(frequency: MemeFrequency, preferences?: MemePreferences): string {
  // 不主动发时只留一句用法，用户要表情时仍能发；偏好和频率说明都用不上。
  if (frequency === 'off') return `表情包：只在用户明确要求时，用 ${MEME_TOOL} 找一张贴合的按工具说明发出。`
  return [
    `表情包：用 ${MEME_TOOL} 按情绪或关键词找候选，挑贴合的一张，按工具说明的方式发出。`,
    '一次回复最多一张；用户在说正事时不发。',
    FREQUENCY_TEXT[frequency],
    preferences?.memePacks?.length ? `优先图库：${preferences.memePacks.map(pack => JSON.stringify(pack.name)).join('、')}；从已启用图库中优先挑选，没有合适的可用其他图库。` : '',
    preferences?.memeTags?.length ? `偏好标签：${preferences.memeTags.map(tag => JSON.stringify(tag)).join('、')}。` : '',
    preferences?.memePrompt ? `表情补充要求：\n${preferences.memePrompt}` : '',
  ].filter(Boolean).join('\n')
}
