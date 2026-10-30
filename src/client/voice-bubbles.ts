/** 语音按段落选择；标记只留在浏览器的显示投影里，打断冻结时和文字一起保留，不写宿主会话。 */
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TimedStage } from '../vendor/dialogue-timing/protocol.js'
import { speechText } from '../voice-types.ts'
import type { VoiceMode } from '../voice-types.ts'
import type { VoiceBubble } from './voice-cards.tsx'
import type { VoiceState } from './voice-state.ts'

export type DisplayBlock = AssistantBlock & { readonly qqbotVoice?: true }

export function stageBlock(stage: TimedStage): DisplayBlock {
  return { kind: 'text', text: stage.text, ...stage.voice === true && stage.salvaged !== true ? { qqbotVoice: true as const } : {} }
}

/** 保持与正文气泡一一对应；普通文字、无可朗读内容、失效的音色都不生成 clip。 */
export function voiceBubbles(blocks: readonly DisplayBlock[], playable: ReturnType<VoiceState['playable']>, owner: string, mode: VoiceMode): readonly VoiceBubble[] {
  if (playable === undefined) return []
  return blocks.flatMap((block, index) => {
    if (block.kind !== 'text') return []
    const text = mode === 'all' || block.qqbotVoice === true ? speechText(block.text) : ''
    return [{
      bubble: `${owner}:${index}`,
      clip: text === '' ? undefined : { key: `${playable.revision}\n${text}`, voice: playable.voice, text },
    }]
  })
}
