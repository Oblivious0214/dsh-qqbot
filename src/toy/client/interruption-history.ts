/** 当前标签页的原因缓存：只存会话键与提示，不存聊天或动作参数，不参与控制。 */
const KEY = 'dsh-qqbot:toy-interruptions'
const MAX_ENTRIES = 200
const MAX_REASON = 2000

export function readInterruptionHistory(): Map<string, string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(value)) return new Map()
    return new Map(value.slice(-MAX_ENTRIES).filter((row): row is [string, string] =>
      Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && row[0].length > 0 && row[0].length <= 512
      && typeof row[1] === 'string' && row[1].length > 0 && row[1].length <= MAX_REASON))
  } catch { return new Map() }
}

export function writeInterruptionHistory(history: ReadonlyMap<string, string>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...history].slice(-MAX_ENTRIES).map(([session, reason]) => [session, reason.slice(0, MAX_REASON)])))
  } catch { /* 禁用浏览器存储或空间不足时仍保留本页内存提示，不能影响停止。 */ }
}
