/**
 * 格式规则：分段、表情和语音。语音说明固定，可用状态通过 runtime 提供。
 */

import { MEME_FREQUENCIES, type MemeFrequency } from './library-types.ts'
import type { MemePreferences } from './library-types.ts'
import { SEGMENT_PROMPT } from './vendor/dialogue-timing/protocol.js'

/** 分段规则：[qq] 块的格式由 dialogue-timing 协议定义，解析和显示在 dsh-qqbot 的浏览器端。 */
export const SEGMENT_RULE: string = SEGMENT_PROMPT

/** 合成和播放仍由界面负责；让模型知道如何回应用户的语音请求。 */
export const VOICE_RULE = `语音：以运行时 voice 状态为准。默认用文字，大部分消息保持文字；已启用语音也不代表每条都发语音。仅在用户要求语音，或按人设和语境偶尔适合用声音表达时，在对应 [qq] 段落加 "voice":true，text 写要说的话；未标记的段落和块外普通回复都是文字。一条回复可混合文字与语音，只有一句语音也用 [qq] 块。例如：
[qq]{"version":1,"stages":[{"text":"我在呢。"},{"text":"晚安，做个好梦。","voice":true}]}[/qq]
界面负责把标记的段落生成语音条，点击播放，无需工具。语音已启用时，用户要求发语音就把要说的那句标记为语音，不要声称无法发语音。若运行时为“全部转语音”，界面会自动转换所有可朗读回复，无需逐段标记。未启用或未配置时保持文字，按状态提示开启语音或为当前角色选择音色；生成或播放出错会在语音条上提示。`

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
  return [
    `表情包：用 ${MEME_TOOL} 按情绪或关键词找候选，挑贴合的一张，按工具说明的方式发出。`,
    '一次回复最多一张；用户在说正事时不发。',
    FREQUENCY_TEXT[frequency],
    preferences?.memePacks?.length ? `优先图库：${preferences.memePacks.map(pack => JSON.stringify(pack.name)).join('、')}；从已启用图库中优先挑选，没有合适的可用其他图库。` : '',
    preferences?.memeTags?.length ? `偏好标签：${preferences.memeTags.map(tag => JSON.stringify(tag)).join('、')}。` : '',
    preferences?.memePrompt ? `表情补充要求：\n${preferences.memePrompt}` : '',
  ].filter(Boolean).join('\n')
}
