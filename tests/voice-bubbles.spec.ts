import { describe, expect, it } from 'vitest'
import { stageBlock, voiceBubbles } from '../src/client/voice-bubbles.ts'
import { parseTimedReply, parseTimedStream, salvageTimedReply } from '../src/vendor/dialogue-timing/protocol.js'

const playable = { voice: 'v-00000001', revision: 'test' }
const wrap = (stages: unknown[]) => `[qq]${JSON.stringify({ version: 1, stages })}[/qq]`

describe('selective voice', () => {
  it('preserves explicit boolean markers in complete and streaming stages only', () => {
    const stages = [{ text: '文字' }, { text: '语音', voice: true, cycles: 2, motion: { stop: true } },
      ...[false, 'true', 1, {}, null].map(voice => ({ text: '文字', voice }))]
    const expected = [{ text: '文字' }, { text: '语音', voice: true, cycles: 2, motion: { stop: true } },
      ...Array.from({ length: 5 }, () => ({ text: '文字' }))]
    expect(parseTimedReply(wrap(stages))?.stages).toEqual(expected)
    expect(parseTimedStream(wrap(stages).replace(']}[/qq]', ',{"text":"未闭合'))?.stages).toEqual(expected)
  })

  it('keeps mixed bubbles aligned and generates clips only for marked speech', () => {
    const stages = parseTimedReply(wrap([{ text: '文字' }, { text: '**晚安**（挥手）', voice: true },
      { text: '另一句文字' }, { text: '（微笑）', voice: true }, { text: '好梦', voice: true }]))!.stages
    const blocks = stages.map(stageBlock)
    const items = voiceBubbles(blocks, playable, 'reply', 'selective')
    expect(items.map(item => item.bubble)).toEqual(['reply:0', 'reply:1', 'reply:2', 'reply:3', 'reply:4'])
    expect(items.map(item => item.clip?.text)).toEqual([undefined, '晚安', undefined, undefined, '好梦'])
    // 流式显示只传已出现的段落，冻结投影后继续保持原有选择。
    expect(voiceBubbles(blocks.slice(0, 2), playable, 'reply', 'selective').map(item => item.clip?.text)).toEqual([undefined, '晚安'])
    expect(voiceBubbles([...blocks], playable, 'reply', 'selective')).toEqual(items)
    expect(voiceBubbles(blocks, undefined, 'reply', 'selective')).toEqual([])
  })

  it('leaves plain replies and unmarked history as text while retaining the all mode', () => {
    const blocks = [{ kind: 'text' as const, text: '普通回复' }, stageBlock({ text: '旧的未标记段落' })]
    expect(voiceBubbles(blocks, playable, 'r', 'selective').every(item => item.clip === undefined)).toBe(true)
    expect(voiceBubbles(blocks, playable, 'r', 'all').map(item => item.clip?.text)).toEqual(['普通回复', '旧的未标记段落'])
    const marked = [stageBlock({ text: '语音', voice: true })]
    expect(voiceBubbles(marked, playable, 'r', 'selective')[0]?.clip?.text).toBe('语音')
  })

  it('does not infer a voice choice from malformed JSON', () => {
    const result = salvageTimedReply('[qq]{"version":1,"stages":[{"text":"他说"晚安"。","voice":true}]}[/qq]')!
    expect(result.stages).toEqual([{ text: '他说"晚安"。', salvaged: true }])
    expect(voiceBubbles(result.stages.map(stageBlock), playable, 'r', 'selective')[0]?.clip).toBeUndefined()
    expect(stageBlock({ text: '文字', voice: true, salvaged: true })).not.toHaveProperty('qqbotVoice')
  })
})
