import { describe, expect, it } from 'vitest'

import { decodeReply } from '../src/client/decode.ts'
import {
  hasTimedBlock, normalizeTags, parseFinishedReply, parseTimedReply, parseTimedStream, salvageTimedReply, stripTimedReply,
} from '../src/vendor/dialogue-timing/protocol.js'
import { parseStream } from '../src/toy/core/replies.ts'

const body = '{"version":1,"stages":[{"text":"呜啊——！"},{"text":"再、再深一点点……"}]}'
const two = [{ text: '呜啊——！' }, { text: '再、再深一点点……' }]
const expected = { stages: two, complete: true }

describe('drifted qq tags', () => {
  it('reads <qq>, 【qq】, full-width and odd-case tags like [qq]', () => {
    for (const [open, close] of [['<qq>', '</qq>'], ['【qq】', '【/qq】'], ['［QQ］', '［/QQ］'], ['[ qq ]', '[/ qq]'], ['<qq>', '[/qq]']]) {
      expect(parseTimedStream(`${open}${body}${close} `)).toEqual(expected)
    }
    expect(parseTimedStream('<qq>{"version":1,"stages":[{"text":"a"},{"text":"b')).toEqual({ stages: [{ text: 'a' }], complete: false })
  })

  it('leaves other tags and emoticons alone and hides unfinished tags while streaming', () => {
    expect(normalizeTags('[qq-replies]{"replies":[]}[/qq-replies] <qqq>')).toBe('[qq-replies]{"replies":[]}[/qq-replies] <qqq>')
    expect(stripTimedReply('前言<qq>{"version":1')).toBe('前言')
    expect(stripTimedReply('前言<q')).toBe('前言')
    expect(stripTimedReply('前言【')).toBe('前言')
    expect(hasTimedBlock('好吧>_<')).toBe(false)
    expect(stripTimedReply('好吧>_<')).toBe('好吧>_<')
  })
})

describe('wrappers', () => {
  it('unwraps a block or bare JSON inside a code fence, inline code or a quote', () => {
    expect(parseTimedStream('```\n[qq]' + body + '[/qq]\n```')).toEqual(expected)
    expect(parseTimedStream('```json\n' + body + '\n```')).toEqual(expected)
    expect(parseTimedStream('`[qq]' + body + '[/qq]`')).toEqual(expected)
    expect(parseTimedStream('> [qq]' + body + '[/qq]')).toEqual(expected)
    expect(parseTimedStream(body)).toEqual(expected)
    // 光秃 JSON 流式时按已闭合段落读，结束后补齐。
    expect(parseTimedStream('{"version":1,"stages":[{"text":"a"},{"te')).toEqual({ stages: [{ text: 'a' }], complete: false })
    expect(hasTimedBlock('{"vers')).toBe(true)
    // 块外已有正常块时，代码块里的示例不读。
    expect(parseTimedStream('[qq]{"stages":["a"]}[/qq]\n```\n[qq]{"stages":["b"]}[/qq]\n```')).toEqual({ stages: [{ text: 'a' }], complete: true })
    expect(parseTimedStream('普通回复，带 `代码`')).toBeNull()
  })

  it('treats a finished reply without [/qq] as complete', () => {
    expect(parseFinishedReply('[qq]' + body)).toEqual(expected)
    expect(parseFinishedReply('[qq]{"version":1,"stages":[{"text":"a"},{"text":"b')).toEqual({ stages: [{ text: 'a' }], complete: true })
    expect(parseFinishedReply('[qq]就一句话')).toEqual({ stages: [{ text: '就一句话' }], complete: true })
    expect(parseStream('[qq]' + body, true)).toEqual(expected)
    expect(decodeReply('[qq]' + body, false, null)).toEqual({ stream: expected, error: '' })
    expect(parseFinishedReply('```json\n' + body.slice(0, -2))).toEqual(expected)
  })
})

describe('envelope and stages', () => {
  it('accepts missing or odd version, extra keys, a bare array, a single stage and string stages', () => {
    for (const block of [
      '{"stages":[{"text":"呜啊——！"},{"text":"再、再深一点点……"}]}',
      '{"version":"1","stages":[{"text":"呜啊——！"},{"text":"再、再深一点点……"}],"mood":"shy"}',
      '[{"text":"呜啊——！"},"再、再深一点点……"]',
      '{"version":1,"stages":[{"content":"呜啊——！"},{"message":"再、再深一点点……"}]}',
    ]) expect(parseTimedReply(`[qq]${block}[/qq]`)).toEqual({ version: 1, stages: two })
    expect(parseTimedReply('[qq]{"text":"一句"}[/qq]')).toEqual({ version: 1, stages: [{ text: '一句' }] })
    expect(parseTimedReply('[qq]就是一句话[/qq]')).toEqual({ version: 1, stages: [{ text: '就是一句话' }] })
  })

  it('merges blocks, cuts at 20, drops empty stages and stray tags, reads voice "true"', () => {
    expect(parseTimedReply('[qq]{"stages":["a"]}[/qq]中间[qq]{"stages":["b"]}[/qq]')!.stages).toEqual([{ text: 'a' }, { text: 'b' }])
    const many = JSON.stringify({ version: 1, stages: Array.from({ length: 25 }, (_, i) => ({ text: String(i) })) })
    expect(parseTimedReply(`[qq]${many}[/qq]`)!.stages).toHaveLength(20)
    expect(parseTimedReply('[qq]{"stages":[{"text":""},{"text":"a[dsh]b"},{"text":"c","voice":"true"}]}[/qq]')!.stages)
      .toEqual([{ text: 'ab' }, { text: 'c', voice: true }])
    // 带 motion 却没有正文的段落不丢（可能是停止），整条按格式错误处理。
    expect(() => parseTimedReply('[qq]{"stages":[{"text":"","motion":{"stop":true}}]}[/qq]')).toThrow()
    expect(() => parseTimedReply('[qq]{"stages":[]}[/qq]')).toThrow()
  })
})

describe('JSON repair', () => {
  it('repairs raw newlines, unescaped quotes, bad backslashes and trailing commas', () => {
    const broken = '[qq]{"version":1,"stages":[{"text":"他说"你好"，然后\n走了"},{"text":"路径C:\\q","motion":{"stop":true},},]}[/qq]'
    expect(parseTimedReply(broken)!.stages).toEqual([
      { text: '他说"你好"，然后\n走了' }, { text: '路径C:\\q', motion: { stop: true } },
    ])
    // 流式时同样切段，不提前闭合正在写的字符串。
    expect(parseTimedStream('[qq]{"stages":[{"text":"他说"你好"。"},{"text":"他说"')!.stages).toEqual([{ text: '他说"你好"。' }])
  })

  it('keeps motion intact and salvages only what repair cannot read', () => {
    const motion = { range: 'full', tier: 'high', action: 'auto' }
    expect(parseTimedReply(`[qq]{"stages":[{"text":"a","motion":${JSON.stringify(motion)}}]}[/qq]`)!.stages).toEqual([{ text: 'a', motion }])
    expect(salvageTimedReply('[qq]' + body + '[/qq]')).toBeNull()
    expect(salvageTimedReply('[qq]{"stages":[{"text":"a"}{"text":"b"}]}[/qq]')).toEqual({ version: 1, stages: [
      { text: 'a', salvaged: true }, { text: 'b', salvaged: true },
    ] })
  })
})
