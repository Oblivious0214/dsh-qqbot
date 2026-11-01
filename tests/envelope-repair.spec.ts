import { describe, expect, it } from 'vitest'
import { decodeReply } from '../src/client/decode.ts'
import { parseTimedReply, parseTimedStream } from '../src/vendor/dialogue-timing/protocol.js'
import { reduceIntent } from '../src/toy/core/intent.ts'

describe('missing outer envelope brackets', () => {
  const stages = [
    { text: '语音和表情\n[表情: 害羞]', voice: true },
    { text: '慢', motion: { range: 'lower_half', tier: 'low', action: 'steady' } },
    { text: '中', motion: { range: 'lower_half', tier: 'medium', action: 'accelerate' } },
    { text: '快', motion: { range: 'full', tier: 'high', action: 'steady' } },
  ]
  const json = JSON.stringify({ version: 1, stages })

  it.each([1, 2])('retains all stages and final motion when missing %i outer brackets', count => {
    const source = `[qq]${json.slice(0, -count)}  [/qq]`
    const head = parseTimedStream(`[qq]${json.slice(0, json.indexOf(',{"text":"快"'))}`)!
    expect(head.stages).toHaveLength(3)
    const result = decodeReply(source, false, head)
    expect(result).toEqual({ stream: { stages, complete: true }, error: '' })
    expect(reduceIntent(null, result.stream!.stages[3]!.motion)).toEqual(stages[3]!.motion)
    expect(parseTimedReply(source)).toEqual({ version: 1, stages })
    // An explicit closing marker may arrive before the request finishes.
    expect(decodeReply(source, true, head)).toEqual(result)
  })

  it('keeps live incomplete envelopes incomplete until the closing marker arrives', () => {
    expect(parseTimedStream(`[qq]${json.slice(0, -2)}`)).toEqual({ stages, complete: false })
  })

  // 未闭合的段落、motion 或字符串不替模型补；整块没有段落时报错。
  it.each([
    '{"version":1,"stages":[{"text":"a","motion":{"range":"full","tier":"high","action":"steady"',
    '{"version":1,"stages":[{"text":"a","motion":{"stop":true}',
    '{"version":1,"stages":[{"text":"unfinished',
    '{"version":1,"stages":[{"text":""}',
    '{"version":1,"stages":[',
  ])('rejects incomplete contents or invalid structure: %s', body => {
    expect(() => parseTimedReply(`[qq]${body}[/qq]`)).toThrow()
  })

  // flash 常见的小错：尾逗号、未转义引号、直接换行、版本号不对、多余键。
  it.each([
    ['{"version":1,"stages":[{"text":"a"},', 'a'],
    ['{"version":1,"stages":[{"text":"bad"quote"}', 'bad"quote'],
    ['{"version":1,"stages":[{"text":"raw\nnewline"}', 'raw\nnewline'],
    ['{"version":2,"stages":[{"text":"a"}', 'a'],
    ['{"version":1,"extra":true,"stages":[{"text":"a"}', 'a'],
  ])('accepts common slips: %s', (body, text) => {
    expect(parseTimedReply(`[qq]${body}[/qq]`)).toEqual({ version: 1, stages: [{ text }] })
  })

  it('still rejects invalid motion through the device validator', () => {
    const result = parseTimedReply('[qq]{"version":1,"stages":[{"text":"a","motion":{"range":"unknown","tier":"high","action":"steady"}}[/qq]')!
    expect(() => reduceIntent(null, result.stages[0]!.motion)).toThrow()
  })
})
