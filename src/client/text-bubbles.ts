/** 只改 QQbot 的显示投影；换行和表情各自成气泡，普通空格、原始回复和动作时钟不变。 */
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

export function textBubbles(source: string): string[] {
  const result: string[] = []
  let pending = ''
  const flush = () => {
    const text = pending.trim()
    if (text !== '') result.push(text)
    pending = ''
  }
  const prose = (text: string) => {
    const lines = text.split(/\r\n?|\n|\u2028|\u2029/)
    lines.forEach((line, index) => {
      if (index > 0) flush()
      pending += line
    })
  }
  // 代码内的换行、字面量标记和 Markdown 链接保持完整。表情格式与 dsh-meme 的公开标记一致。
  const tokens = /(?<meme>\[表情:\s*[^\]]+\](?:\(https?:\/\/[^\s)]+\))?)|^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[^\n]*(?=\n|$)|(?![\s\S]))|^[ \t]*~~~[^\n]*\n[\s\S]*?(?:^[ \t]*~~~[^\n]*(?=\n|$)|(?![\s\S]))|(?<ticks>`+)[^`]*?\k<ticks>|!?\[[^\]\n]*\]\([^\n]*?\)/gm
  let end = 0
  for (const match of source.matchAll(tokens)) {
    prose(source.slice(end, match.index))
    if (match.groups?.meme !== undefined) {
      flush()
      result.push(match[0])
    } else pending += match[0]
    end = match.index + match[0].length
  }
  prose(source.slice(end))
  flush()
  return result
}

/** 保留语音标记等投影字段；不重排推理、工具和图片块。 */
export function splitTextBlocks<T extends AssistantBlock>(blocks: readonly T[]): T[] {
  return blocks.flatMap(block => block.kind === 'text'
    ? textBubbles(block.text).map(text => ({ ...block, text })) : [block])
}

/** 同一动作段可显示成多个气泡；只在最后一个气泡后标注，仍引用原动作段索引。 */
export function bubbleStageIndices(stages: readonly { readonly text: string }[]): (number | undefined)[] {
  return stages.flatMap((stage, index) => {
    const parts = textBubbles(stage.text)
    return parts.map((_, part) => part === parts.length - 1 ? index : undefined)
  })
}
