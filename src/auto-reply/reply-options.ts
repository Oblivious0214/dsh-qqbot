/** Browser-safe metadata envelope, separate from the existing [qq] stages protocol. */
export const OPTIONS_OPEN = '[qq-replies]'
export const OPTIONS_CLOSE = '[/qq-replies]'

export function parseReplyOptions(raw: string): readonly string[] {
  if (raw.length > 3000) return []
  let value: unknown
  // 模型偶尔在对象后多写括号或换行（如 `{...}]\n`）：只截到最后一个 }，不补任何内容。
  const trimmed = raw.trim()
  try { value = JSON.parse(trimmed) } catch {
    try { value = JSON.parse(trimmed.slice(0, trimmed.lastIndexOf('}') + 1)) } catch { return [] }
  }
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('replies' in value)
    || !Array.isArray(value.replies) || value.replies.length !== 3) return []
  if (value.replies.some(text => typeof text !== 'string' || !text.trim() || Array.from(text).length > 120
    || /[\r\n]|\[\/?(?:qq(?:-replies)?|dsh)\]|```/.test(text))) return []
  const replies = (value.replies as string[]).map(text => text.trim())
  return new Set(replies).size === 3 ? replies : []
}

export interface SplitReplyOptions { body: string; replies: readonly string[] }
/** Reserve a standalone suffix before rendering/voice/timing, including partial or invalid
 * metadata. Code fences and quoted examples stay ordinary content. Never edit durable history. */
export function splitReplyOptions(source: string, running: boolean): SplitReplyOptions {
  let offset = 0
  let fence: string | undefined
  for (const line of source.split('\n')) {
    const text = line.trimStart()
    const delimiter = /^(`{3,}|~{3,})/.exec(text)?.[1]
    if (delimiter) {
      if (!fence) fence = delimiter
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined
    } else if (!fence && (text.startsWith(OPTIONS_OPEN)
      || (text.length >= (running ? 2 : 4) && OPTIONS_OPEN.startsWith(text) && offset + line.length === source.length))) {
      const cut = offset + line.length - text.length
      const suffix = source.slice(cut)
      const end = suffix.indexOf(OPTIONS_CLOSE, OPTIONS_OPEN.length)
      const replies = !running && suffix.startsWith(OPTIONS_OPEN) && end !== -1
        && suffix.slice(end + OPTIONS_CLOSE.length).trim() === ''
        ? parseReplyOptions(suffix.slice(OPTIONS_OPEN.length, end)) : []
      return { body: source.slice(0, cut), replies }
    }
    offset += line.length + 1
  }
  return { body: source, replies: [] }
}

/** Trim only the text suffix while preserving the native order of other blocks. */
export function projectReplyOptions<T extends { kind: string; text?: string }>(blocks: readonly T[], running: boolean): {
  blocks: readonly T[]; replies: readonly string[]
} {
  const source = blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('')
  const split = splitReplyOptions(source, running)
  if (split.body === source) return { blocks, replies: split.replies }
  let left = split.body.length
  const visible = blocks.flatMap(block => {
    if (block.kind !== 'text') return [block]
    const text = (block.text ?? '').slice(0, left)
    left -= text.length
    return text ? [{ ...block, text }] : []
  })
  return { blocks: visible, replies: split.replies }
}
