import { describe, expect, it } from 'vitest'
import { hidePerformanceCues, stageBlock, stripPerformanceCues, voiceBubbles } from '../src/client/voice-bubbles.ts'
import { parseTimedReply, parseTimedStream, salvageTimedReply } from '../src/vendor/dialogue-timing/protocol.js'

const playable = { voice: 'v-00000001', revision: 'test' }
const wrap = (stages: unknown[]) => `[qq]${JSON.stringify({ version: 1, stages })}[/qq]`

describe('selective voice', () => {
  it('preserves explicit boolean markers in complete and streaming stages only', () => {
    const stages = [{ text: '文字' }, { text: '语音', voice: true, seconds: 20, motion: { stop: true } },
      ...[false, 'true', 1, {}, null].map(voice => ({ text: '文字', voice }))]
    // 字符串 "true" 也算明确选择语音（flash 常这样写），其余值仍按文字。
    const expected = [{ text: '文字' }, { text: '语音', voice: true, motion: { stop: true } },
      { text: '文字' }, { text: '文字', voice: true }, ...Array.from({ length: 3 }, () => ({ text: '文字' }))]
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

  it('hides Fish performance cues from bubbles but keeps them for speech', () => {
    expect(stripPerformanceCues('[委屈]所以人家就趴在这儿')).toBe('所以人家就趴在这儿')
    expect(stripPerformanceCues('等一下[喘]太突然了 [soft tone]好')).toBe('等一下太突然了好')
    expect(stripPerformanceCues('say [whispering] hi')).toBe('say hi')
    // 表情、链接、脚注和长方括号内容不动。
    const kept = '[表情: 猫猫] [官网](https://a.b) 见[1] [这是一段很长的方括号说明文字超过十二字]'
    expect(stripPerformanceCues(kept)).toBe(kept)

    const blocks = hidePerformanceCues([stageBlock({ text: '[委屈]文字段' }), stageBlock({ text: '[轻声安慰]我在。[短暂停顿]慢慢说。', voice: true }),
      stageBlock({ text: '[叹气]' }), { kind: 'text', text: '没有标记' }])
    expect(blocks.map(block => block.kind === 'text' ? block.text : '')).toEqual(['文字段', '我在。慢慢说。', '[叹气]', '没有标记'])
    expect(voiceBubbles(blocks, playable, 'r', 'selective').map(item => item.clip?.text))
      .toEqual([undefined, '[轻声安慰]我在。[短暂停顿]慢慢说。', undefined, undefined])
    const plain = [stageBlock({ text: '无标记' })]
    expect(hidePerformanceCues(plain)).toBe(plain)
  })

  it('carries a cleaned tone from the stage to the clip and keys audio by it', () => {
    const stages = parseTimedReply('[qq]{"version":1,"stages":[{"voice":true,"tone":"  轻声[安慰]\\n语速稍慢 ","text":"我在"},{"voice":true,"tone":"开心","text":"我在"},{"voice":true,"tone":7,"text":"我在"}]}[/qq]')!.stages
    expect(stages.map(stage => stage.tone)).toEqual(['轻声 安慰 语速稍慢', '开心', undefined])
    const clips = voiceBubbles(stages.map(stageBlock), playable, 'r', 'selective').map(item => item.clip!)
    expect(clips.map(clip => clip.tone)).toEqual(['轻声 安慰 语速稍慢', '开心', undefined])
    expect(new Set(clips.map(clip => clip.key)).size).toBe(3)
    expect(stageBlock({ text: '抢救', tone: '开心', salvaged: true })).toEqual({ kind: 'text', text: '抢救' })
  })

  it('does not infer a voice choice from malformed JSON', () => {
    // 未转义引号能修复，voice 照常保留；修复不了时只抢救文字。
    expect(parseTimedReply('[qq]{"version":1,"stages":[{"text":"他说"晚安"。","voice":true}]}[/qq]')!.stages)
      .toEqual([{ text: '他说"晚安"。', voice: true }])
    const result = salvageTimedReply('[qq]{"version":1,"stages":[{"text":"他说"晚安"。","voice":true}{"text":"x"}]}[/qq]')!
    expect(result.stages[1]).toEqual({ text: 'x', salvaged: true })
    result.stages.length = 1
    expect(result.stages).toEqual([{ text: '他说"晚安"。', salvaged: true }])
    expect(voiceBubbles(result.stages.map(stageBlock), playable, 'r', 'selective')[0]?.clip).toBeUndefined()
    expect(stageBlock({ text: '文字', voice: true, salvaged: true })).not.toHaveProperty('qqbotVoice')
  })
})
