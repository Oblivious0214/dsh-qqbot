/** QQ 表情的共享检索与显示协议；只在已经限定的图库中匹配。 */
export const MEME_SCOPE_PATH = '/api/qqbot/memes'
export interface ScopedMeme {
  readonly pack: string
  readonly path: string
  readonly caption: string
  readonly tag: string
  readonly keywords: string
  readonly url: string
}
export interface MemeScopeView {
  readonly memes: readonly ScopedMeme[]
  readonly message?: string
  readonly origin?: string
}
const fold = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase().replace(/[“”‘’]/g, '"').replace(/\s+/g, ' ')

/** 标签和关键词只缩小当前角色候选，不跨图库回退。 */
export function searchMemes(rows: readonly ScopedMeme[], tag = '', query = '', limit = 3): ScopedMeme[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const candidates = rows.filter(row => (!tag || fold(row.tag) === fold(tag))
    && words.every(word => fold(`${row.caption} ${row.keywords} ${row.path}`).includes(word)))
  // 随机起点让同一情绪有不同图片；范围已经在服务端取过交集。
  const start = Math.floor(Math.random() * candidates.length)
  return Array.from({ length: Math.min(candidates.length, Math.max(1, Math.min(10, Math.floor(limit) || 3))) },
    (_, i) => candidates[(start + i) % candidates.length]!)
}

/** 候选自带图库和路径身份，描述同名也不会串图。标识只用于消息协议，界面不显示。 */
export function memeKey(row: ScopedMeme): string {
  return `qqbot:${encodeURIComponent(row.pack)}:${encodeURIComponent(row.path)}`
}
export function memeMarker(row: ScopedMeme): string { return `[表情: ${memeKey(row)}]` }

/** 历史描述兼容只做当前范围内的精确匹配；没有匹配时保留描述。 */
export function findMeme(text: string, rows: readonly ScopedMeme[]): ScopedMeme | undefined {
  const key = text.trim()
  if (key.startsWith('qqbot:')) return rows.find(row => memeKey(row) === key)
  return rows.find(row => fold(row.caption) === fold(key))
}

export function memeDescription(text: string): string {
  return text.trim().startsWith('qqbot:') ? '表情暂不可用' : text
}

/** 在交给原生 Markdown 之前消去第三方的全局配图标记，加载失败也不会跨库配图。 */
export function projectMemes(text: string, rows: readonly ScopedMeme[], base?: string): string {
  const plain = (value: string) => value.replace(/[\\`*_{}\[\]()<>!#|]/g, '\\$&')
  const imageUrl = (row: ScopedMeme) => base ? new URL(row.url, base).href : row.url
  const tokens = /(^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[^\n]*(?=\n|$)|(?![\s\S]))|^[ \t]*~~~[^\n]*\n[\s\S]*?(?:^[ \t]*~~~[^\n]*(?=\n|$)|(?![\s\S]))|`+[^`]*`+)|\[表情:\s*([^\]]+)\](?:\(([^\s)]+)\))?|!\[([^\]\n]*)\]\(([^\s)]+)\)/gm
  return text.replace(tokens, (raw, code: string | undefined, caption: string | undefined, _legacy: string | undefined, alt: string | undefined, url: string | undefined) => {
    if (code !== undefined) return raw
    if (caption !== undefined) {
      const hit = findMeme(caption, rows)
      return hit ? `![${plain(hit.caption)}](<${imageUrl(hit)}>)` : plain(memeDescription(caption))
    }
    // 旧消息里的直链仍须落在当前角色允许的图库；其他普通图片保持原样。
    if (url && /(?:^|\/)dsh-memes\//.test(url)) return rows.some(row => row.url === url || imageUrl(row) === url) ? raw : plain(alt ?? '表情暂不可用')
    return raw
  })
}
