import { describe, expect, it } from 'vitest'
import { bubbleStageIndices, splitTextBlocks, textBubbles } from '../src/client/text-bubbles.ts'
import { stageBlock, voiceBubbles } from '../src/client/voice-bubbles.ts'
import { speechText } from '../src/voice-types.ts'

describe('QQ text bubbles', () => {
  it('splits line endings, drops empty edges and preserves ordinary spaces and punctuation', () => {
    expect(textBubbles('\n\n第一句。 继续说\r\n\r\n  hello world \r下一句\n\n'))
      .toEqual(['第一句。 继续说', 'hello world', '下一句'])
    expect(textBubbles('  \r\n\t\n')).toEqual([])
    expect(textBubbles('甲\u2028乙\u2029丙')).toEqual(['甲', '乙', '丙'])
  })

  it('isolates memes without losing the following prose or reading their captions', () => {
    const marker = '[表情: 展示自己是大肥鱼，得意]'
    const body = '后面的正文应该完整保留。 hello world'
    expect(textBubbles(`${marker}\n\n${body}`)).toEqual([marker, body])
    expect(textBubbles(`前文${marker}后文`)).toEqual(['前文', marker, '后文'])
    expect(textBubbles(`前${marker}(https://example.test/a.png)后`))
      .toEqual(['前', `${marker}(https://example.test/a.png)`, '后'])
    expect(speechText(`${marker}\n\n${body}`)).toBe(body)
    expect(speechText(marker)).toBe('')
    expect(speechText(`${marker}(https://example.test/a.png)`)).toBe('')
  })

  it('preserves code, literal newline escapes, emoji and markdown links', () => {
    const code = '```txt\n第一行\n[表情: 代码里的例子]\n\n第二行\n```'
    expect(textBubbles(`前文\n${code}\n后文`)).toEqual(['前文', code, '后文'])
    expect(textBubbles('~~~txt\n甲\n乙\n~~~')).toEqual(['~~~txt\n甲\n乙\n~~~'])
    expect(textBubbles('`[表情: 例子]` 和 ``a b``')).toEqual(['`[表情: 例子]` 和 ``a b``'])
    expect(textBubbles('hello world😊\n[链接](https://example.test/a)\n![图](https://example.test/a.png)'))
      .toEqual(['hello world😊', '[链接](https://example.test/a)', '![图](https://example.test/a.png)'])
    expect(textBubbles('字面量 \\n 不拆开')).toEqual(['字面量 \\n 不拆开'])
    expect(textBubbles('```txt\n尚未闭合\n继续生成')).toEqual(['```txt\n尚未闭合\n继续生成'])
  })

  it('keeps voice selection, nontext block order and original motion indices', () => {
    const stages = [
      { text: '[表情: 开心]\n\n第一段\n下一行', voice: true, motion: { stop: true }, cycles: 3 },
      { text: '第二段', voice: true },
    ]
    const reasoning = { kind: 'reasoning' as const, text: '思考不分段\n仍保留' }
    const blocks = splitTextBlocks([reasoning, ...stages.map(stageBlock)])
    expect(blocks[0]).toBe(reasoning)
    expect(blocks.slice(1).map(block => block.kind === 'text' && block.text))
      .toEqual(['[表情: 开心]', '第一段', '下一行', '第二段'])
    const items = voiceBubbles(blocks, { voice: 'v', revision: '1' }, 'reply', 'all')
    expect(items.map(item => item.clip?.text)).toEqual([undefined, '第一段', '下一行', '第二段'])
    expect(voiceBubbles(blocks, { voice: 'v', revision: '1' }, 'reply', 'selective').map(item => item.clip?.text))
      .toEqual([undefined, '第一段', '下一行', '第二段'])
    expect(bubbleStageIndices(stages)).toEqual([undefined, undefined, 0, 1])
    expect(stages[0].cycles).toBe(3)
    expect(stages[0].text).toContain('\n\n')
  })
})
