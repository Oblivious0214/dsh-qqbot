/** 语音按段落选择；标记只留在浏览器的显示投影里，打断冻结时和文字一起保留，不写宿主会话。 */
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TimedStage } from '../vendor/dialogue-timing/protocol.js'
import { speechText } from '../voice-types.ts'
import type { VoiceMode } from '../voice-types.ts'
import type { VoiceBubble } from './voice-cards.tsx'
import type { VoiceState } from './voice-state.ts'

/** qqbotSpeech：去掉表演标记前的原文；qqbotTone：段落的语气描述。两者只给 TTS 用。 */
export type DisplayBlock = AssistantBlock & { readonly qqbotVoice?: true; readonly qqbotSpeech?: string; readonly qqbotTone?: string }

export function stageBlock(stage: TimedStage): DisplayBlock {
  if (stage.salvaged === true) return { kind: 'text', text: stage.text }
  return {
    kind: 'text', text: stage.text,
    ...stage.voice === true ? { qqbotVoice: true as const } : {},
    ...stage.tone === undefined ? {} : { qqbotTone: stage.tone },
  }
}

/**
 * Fish 表演标记，如 [委屈]、[轻声安慰]、[soft tone]。不含冒号（[表情: …]）、
 * 不是纯数字（脚注），后面不接 `(`（Markdown 链接），最多 12 个字。
 */
const PERFORMANCE_CUE = /[ \t]*\[(?![\d\s]*\])[^\[\]:：\n]{1,12}\](?!\()[ \t]*/g

export function stripPerformanceCues(text: string): string {
  return text.replace(PERFORMANCE_CUE, (match, offset: number, whole: string) => {
    // 两侧都是拉丁字母或数字时留一个空格，避免单词粘连。
    const before = whole[offset - 1] ?? ''
    const after = whole[offset + match.length] ?? ''
    return /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after) ? ' ' : ''
  }).trim()
}

/** 显示时去掉表演标记，原文留给 TTS。全是标记的气泡保留原文，不让气泡变空。 */
export function hidePerformanceCues(blocks: readonly DisplayBlock[]): readonly DisplayBlock[] {
  let changed = false
  const next = blocks.map((block) => {
    if (block.kind !== 'text') return block
    const text = stripPerformanceCues(block.text)
    if (text === '' || text === block.text) return block
    changed = true
    return { ...block, text, qqbotSpeech: block.qqbotSpeech ?? block.text }
  })
  return changed ? next : blocks
}

/** 保持与正文气泡一一对应；普通文字、无可朗读内容、失效的音色都不生成 clip。 */
export function voiceBubbles(blocks: readonly DisplayBlock[], playable: ReturnType<VoiceState['playable']>, owner: string, mode: VoiceMode): readonly VoiceBubble[] {
  if (playable === undefined) return []
  return blocks.flatMap((block, index) => {
    if (block.kind !== 'text') return []
    const text = mode === 'all' || block.qqbotVoice === true ? speechText(block.qqbotSpeech ?? block.text) : ''
    return [{
      bubble: `${owner}:${index}`,
      clip: text === '' ? undefined : block.qqbotTone === undefined
        ? { key: `${playable.revision}\n${text}`, voice: playable.voice, text }
        : { key: `${playable.revision}\n${block.qqbotTone}\n${text}`, voice: playable.voice, text, tone: block.qqbotTone },
    }]
  })
}
