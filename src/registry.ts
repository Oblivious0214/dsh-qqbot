/**
 * host 层 qqbot 登记服务。只保存外部插件登记的条目，自己不注册提示词；
 * 预设内的 dsh-qqbot/prompt 读取这些条目，组装成 qqbot 会话的 section 和 context。
 */

import type { MotionAction, MotionRange, RoleProactivity, RoleProactivityTexts } from './library-types.ts'
import type { DynamicsPublic } from './role-dynamics/api-types.ts'

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

/** 会话当前角色里给外部插件用的部分。 */
export interface QqbotRoleInfo {
  /** 0.23.0 起有。角色的内部键，改名不变，供外部插件做按角色存储的键；不要显示给用户。 */
  readonly id: string
  readonly name: string
  /** 角色卡写的设备主动性上限；没写时为空，表示不限。 */
  readonly proactivity?: RoleProactivity
  readonly proactivityTexts?: RoleProactivityTexts
  /** 角色卡写的偏好动作和范围；没写时为空。 */
  readonly motionActions?: readonly MotionAction[]
  readonly motionRanges?: readonly MotionRange[]
}

/** 外部插件通过 `ctx.inject(['qqbot'], ...)` 可选接入的接口。 */
export interface QqbotRegistry {
  readonly dynamics: DynamicsPublic
  /** 在外部槽位登记一段规则，返回 disposer。 */
  extension(entry: QqbotExtensionEntry): () => void
  /** 写入运行时状态，进入 `qqbot:runtime` context，返回 disposer。 */
  runtime(name: string, text: QqbotText): () => void
  /** 会话当前的角色；没有角色时为空。每次现读，换角色、改角色卡后立即反映。 */
  role(session: QqbotSession): QqbotRoleInfo | undefined
}

/** 登记来源：登记它的插件名，供提示词查看器显示。取不到时为空。 */
export interface QqbotSource {
  readonly source?: string
}

export interface QqbotRegistrySnapshot {
  readonly extensions: readonly (QqbotExtensionEntry & QqbotSource)[]
  readonly runtime: readonly ({ readonly name: string; readonly text: QqbotText } & QqbotSource)[]
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** 登记部分；`role()` 由 QqbotService 按角色库实现。 */
export class QqbotRegistryStore implements Omit<QqbotRegistry, 'role' | 'dynamics'> {
  private readonly extensions = new Map<string, QqbotExtensionEntry & QqbotSource>()
  // 值包一层对象，旧 disposer 才不会误删同名同文本的新登记。
  private readonly runtimes = new Map<string, { readonly text: QqbotText } & QqbotSource>()
  private readonly listeners = new Set<() => void>()

  extension(entry: QqbotExtensionEntry, source?: string): () => void {
    return this.add(this.extensions, entry.name, { name: entry.name, text: entry.text, ...withSource(source) })
  }

  runtime(name: string, text: QqbotText, source?: string): () => void {
    return this.add(this.runtimes, name, { text, ...withSource(source) })
  }

  /** 名称排序后的条目，供 dsh-qqbot/prompt 和提示词查看器读取。 */
  snapshot(): QqbotRegistrySnapshot {
    const byName = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return {
      extensions: byName(this.extensions).map(([, entry]) => entry),
      runtime: byName(this.runtimes).map(([name, value]) => ({ name, ...value })),
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

function withSource(source: string | undefined): QqbotSource {
  return source === undefined ? {} : { source }
}

/** 按会话求值条目文本。 */
export function resolveText(text: QqbotText, session: QqbotSession): string {
  return typeof text === 'function' ? text(session) : text
}
