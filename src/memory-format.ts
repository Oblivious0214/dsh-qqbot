/**
 * 角色记忆的格式：固定栏目、解析、规范化输出。不依赖 node，浏览器端的编辑器也用它。
 * 模型的整理结果和用户的手动修改都先解析成栏目，再按固定顺序重新输出，
 * 同样的内容生成的文本逐字节相同，会话快照因此能共用前缀缓存。长度和每栏条数由程序检查。
 */

/** 栏目顺序固定。list 栏每条一行；paragraph 栏只有一段。 */
export const MEMORY_SECTIONS = [
  { key: 'identity', title: '称呼与身份', kind: 'list', limit: 6 },
  { key: 'relation', title: '关系', kind: 'paragraph', limit: 1 },
  { key: 'preferences', title: '偏好与禁忌', kind: 'list', limit: 10 },
  { key: 'promises', title: '约定与待办', kind: 'list', limit: 5 },
  { key: 'events', title: '重要经历', kind: 'list', limit: 5 },
] as const

export type MemorySectionKey = typeof MEMORY_SECTIONS[number]['key']
export type Memory = Readonly<Partial<Record<MemorySectionKey, readonly string[]>>>

/** 渲染后的总长度上限（字符）。 */
export const MEMORY_LIMIT = 1500

/** `qqbot:role-memory` 段落：没有记忆时为空，整段不出现。只由快照决定，所以会话内不变。 */
export function memoryRule(memory: string): string {
  return memory === '' ? '' : `你记得的关于对方的事（以前聊天时记下的，自然地用上，不要复述这份记录）：

${memory}`
}

/** 解析出错的原因，可以直接展示给用户。 */
export class MemoryFormatError extends TypeError {}

/**
 * 解析记忆文本。`## 栏目名` 开头，list 栏每行一条（可带 `- `），paragraph 栏多行合成一段。
 * lenient 用于模型输出：去掉代码围栏，忽略第一个栏目前的文字；用户输入时这些都算错误。
 */
export function parseMemory(text: string, lenient = false): Memory {
  let source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (lenient) source = source.replace(/^\s*```[^\n]*\n/, '').replace(/\n```\s*$/, '')
  const result: Partial<Record<MemorySectionKey, string[]>> = {}
  let current: typeof MEMORY_SECTIONS[number] | undefined
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const heading = /^#{1,6}\s*(.+?)\s*#*$/.exec(line)
    if (heading !== null) {
      const title = heading[1]!
      const section = MEMORY_SECTIONS.find(s => s.title === title)
      if (section === undefined) throw new MemoryFormatError(`不认识的栏目“${title}”，只能用：${MEMORY_SECTIONS.map(s => s.title).join('、')}`)
      if (result[section.key] !== undefined) throw new MemoryFormatError(`栏目“${title}”写了两次`)
      result[section.key] = []
      current = section
      continue
    }
    if (current === undefined) {
      if (lenient) continue
      throw new MemoryFormatError(`内容要写在栏目下面，先写一行“## ${MEMORY_SECTIONS[0].title}”这样的栏目名`)
    }
    const item = line.replace(/^(?:[-*•·]|\d+[.、)])\s*/, '').trim()
    if (item === '') continue
    const items = result[current.key]!
    if (current.kind === 'paragraph') items[0] = items[0] === undefined ? item : `${items[0]}${item}`
    else items.push(item)
  }
  for (const section of MEMORY_SECTIONS) {
    const items = result[section.key]
    if (items === undefined) continue
    if (items.length === 0) delete result[section.key]
    else if (items.length > section.limit) throw new MemoryFormatError(`“${section.title}”最多 ${section.limit} 条，现在有 ${items.length} 条`)
  }
  return result
}

/** 按固定栏目顺序输出；空记忆为空串。 */
export function renderMemory(memory: Memory): string {
  return MEMORY_SECTIONS
    .filter(section => (memory[section.key]?.length ?? 0) > 0)
    .map((section) => {
      const items = memory[section.key]!
      const body = section.kind === 'paragraph' ? items.join('') : items.map(item => `- ${item}`).join('\n')
      return `## ${section.title}\n${body}`
    })
    .join('\n\n')
}

/** 解析并检查长度，返回规范化的文本。超长时抛 MemoryFormatError。 */
export function normalizeMemory(text: string, lenient = false): string {
  const rendered = renderMemory(parseMemory(text, lenient))
  if (rendered.length > MEMORY_LIMIT) throw new MemoryFormatError(`记忆最多 ${MEMORY_LIMIT} 个字，现在有 ${rendered.length} 个`)
  return rendered
}
