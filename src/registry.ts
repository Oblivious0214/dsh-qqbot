/**
 * host 层 qqbot 登记服务。只保存外部插件登记的条目，自己不注册提示词；
 * 预设内的 dsh-qqbot/prompt 读取这些条目，组装成 qqbot 会话的 section 和 context。
 */

/** 组装提示词时所属的 qqbot 会话。 */
export interface QqbotSession {
  readonly id: string
}

/**
 * 条目文本。函数形式在每次组装时按会话求值，返回空串表示该会话不出现这段内容，
 * 例如设备只在某个会话里授权时。
 */
export type QqbotText = string | ((session: QqbotSession) => string)

export interface QqbotExtensionEntry {
  /** 小写字母、数字和连字符，例如 `toy`；最终 section 名为 `qqbot:ext:<name>`。 */
  readonly name: string
  /** 应尽量稳定：每次变化都会在会话历史里多出一个 system 节点。 */
  readonly text: QqbotText
}

/** 外部插件通过 `ctx.inject(['qqbot'], ...)` 可选接入的接口。 */
export interface QqbotRegistry {
  /** 在外部槽位登记一段规则，返回 disposer。 */
  extension(entry: QqbotExtensionEntry): () => void
  /** 写入运行时状态，进入 `qqbot:runtime` context，返回 disposer。 */
  runtime(name: string, text: QqbotText): () => void
}

export interface QqbotRegistrySnapshot {
  readonly extensions: readonly QqbotExtensionEntry[]
  readonly runtime: readonly { readonly name: string; readonly text: QqbotText }[]
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export class QqbotRegistryStore implements QqbotRegistry {
  private readonly extensions = new Map<string, QqbotExtensionEntry>()
  // 值包一层对象，旧 disposer 才不会误删同名同文本的新登记。
  private readonly runtimes = new Map<string, { readonly text: QqbotText }>()
  private readonly listeners = new Set<() => void>()

  extension(entry: QqbotExtensionEntry): () => void {
    return this.add(this.extensions, entry.name, { name: entry.name, text: entry.text })
  }

  runtime(name: string, text: QqbotText): () => void {
    return this.add(this.runtimes, name, { text })
  }

  /** 名称排序后的条目，供 dsh-qqbot/prompt 和提示词查看器读取。 */
  snapshot(): QqbotRegistrySnapshot {
    const byName = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return {
      extensions: byName(this.extensions).map(([, entry]) => entry),
      runtime: byName(this.runtimes).map(([name, { text }]) => ({ name, text })),
    }
  }

  /** 条目增删时通知；返回取消订阅。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private add<T>(map: Map<string, T>, name: string, value: T): () => void {
    if (!NAME_PATTERN.test(name)) throw new TypeError(`qqbot: invalid registration name "${name}"`)
    if (map.has(name)) throw new Error(`qqbot: duplicate registration "${name}"`)
    map.set(name, value)
    this.notify()
    return () => {
      if (map.get(name) !== value) return
      map.delete(name)
      this.notify()
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** 按会话求值条目文本。 */
export function resolveText(text: QqbotText, session: QqbotSession): string {
  return typeof text === 'function' ? text(session) : text
}
