/**
 * dsh-qqbot 自己的提示词内容：破限预设和角色正文。
 * 数据来自角色库、会话绑定和破限预设存储；`createDefaultContent()` 是不读写文件的内置默认，供测试和缺省使用。
 */

import { NO_ROLE, SessionBindings, type RoleChoice } from './bindings.ts'
import { DEFAULT_MEME_FREQUENCY, type MemeFrequency } from './library-types.ts'
import type { MemePreferences } from './library-types.ts'
import { DEFAULT_JAILBREAK, JailbreakStore, type JailbreakPreset } from './presets.ts'
import type { QqbotSession } from './registry.ts'
import { MemoryStore } from './role-memory.ts'
import { RoleLibrary, type Role } from './roles.ts'
import type { Warn } from './storage.ts'

export { DEFAULT_JAILBREAK, type JailbreakPreset } from './presets.ts'

export interface QqbotContent {
  jailbreakFor(_session: QqbotSession): JailbreakPreset
  /** 当前会话绑定的角色正文；没有角色时返回空串。 */
  personaFor(session: QqbotSession): string
  /** 当前会话的角色 id；没有角色时为空。供 `qqbot:runtime` 和查看器使用。 */
  roleIdFor(session: QqbotSession): string | undefined
  /** 当前角色的表情频率；没有角色或角色卡没写时用默认档。 */
  memeFrequencyFor(session: QqbotSession): MemeFrequency
  memePreferencesFor(session: QqbotSession): MemePreferences | undefined
  /** 当前角色在本会话的记忆快照；还没取快照时（只读路径）是记忆的当前版本。没有角色或没有记忆时为空串。 */
  roleMemoryFor(session: QqbotSession): string
  /**
   * 真实组装前调用：没有记录的会话把当前默认角色写下来，之后改默认角色不会让进行中的会话换人。
   * 只读路径（提示词查看器）不调用它。
   */
  settle(session: QqbotSession): void
  /** 记下这一轮用的角色，供界面按消息显示头像。真实组装的每一步调用，只在换人时写盘。 */
  recordTurn(session: QqbotSession, turn: number): void
}

export function createDefaultContent(): QqbotContent {
  return {
    jailbreakFor: () => DEFAULT_JAILBREAK,
    personaFor: () => '',
    roleIdFor: () => undefined,
    memeFrequencyFor: () => DEFAULT_MEME_FREQUENCY,
    memePreferencesFor: () => undefined,
    roleMemoryFor: () => '',
    settle: () => {},
    recordTurn: () => {},
  }
}

/** 角色库、会话绑定、破限预设、角色记忆合起来的内容来源。 */
export class QqbotData implements QqbotContent {
  constructor(
    readonly roles: RoleLibrary,
    readonly bindings: SessionBindings,
    readonly presets: JailbreakStore,
    private readonly warn: Warn,
    readonly memories: MemoryStore = new MemoryStore(undefined, warn),
  ) {}

  /** 会话的选择：有记录用记录，没有记录时用新会话默认角色（不写盘）。 */
  choiceFor(session: QqbotSession): RoleChoice {
    // 不能用 ??：NO_ROLE 是 null，会被当成"没有记录"而让默认角色接管。
    const choice = this.bindings.get(session.id)
    return choice !== undefined ? choice : this.bindings.defaultRole ?? NO_ROLE
  }

  /** 会话当前在用的角色。绑定的角色已从角色库删掉时为空，会话按无角色运行，绑定保留。 */
  roleFor(session: QqbotSession): Role | undefined {
    const choice = this.choiceFor(session)
    return choice === NO_ROLE ? undefined : this.roles.get(choice)
  }

  jailbreakFor(_session: QqbotSession): JailbreakPreset {
    return this.presets.current()
  }

  personaFor(session: QqbotSession): string {
    return this.roleFor(session)?.persona ?? ''
  }

  roleIdFor(session: QqbotSession): string | undefined {
    return this.roleFor(session)?.id
  }

  memeFrequencyFor(session: QqbotSession): MemeFrequency {
    return this.roleFor(session)?.memeFrequency ?? DEFAULT_MEME_FREQUENCY
  }

  memePreferencesFor(session: QqbotSession): MemePreferences | undefined {
    return this.roleFor(session)
  }

  roleMemoryFor(session: QqbotSession): string {
    const role = this.roleFor(session)
    if (role === undefined) return ''
    return this.bindings.memorySnapshot(session.id, role.id) ?? this.memories.text(role.id)
  }

  settle(session: QqbotSession): void {
    if (this.bindings.get(session.id) === undefined) {
      try {
        this.bindings.set(session.id, this.choiceFor(session))
      } catch (error) {
        // 写不了盘时本轮照常组装（用的就是默认角色），下一轮再试。
        this.warn(`qqbot: 记不下会话 ${session.id} 的角色：${String(error)}`)
        return
      }
    }
    // 角色在本会话第一次出场时取记忆快照，之后整个会话都用它（换过角色时每个角色各取一次）。
    const role = this.roleFor(session)
    if (role === undefined || this.bindings.memorySnapshot(session.id, role.id) !== undefined) return
    try {
      this.bindings.setMemorySnapshot(session.id, role.id, this.memories.text(role.id))
    } catch (error) {
      // 写不了盘时本轮用记忆的当前版本，下一轮再试。
      this.warn(`qqbot: 记不下会话 ${session.id} 的记忆快照：${String(error)}`)
    }
  }

  /**
   * 会话当前角色的记忆快照是否落后于记忆的当前版本。会话还没开始、没有角色、
   * 或角色还没在本会话出场时为 undefined：下一次组装自然取新版本，不需要应用。
   */
  memoryState(sessionId: string): { readonly role: string; readonly stale: boolean } | undefined {
    if (this.bindings.get(sessionId) === undefined) return undefined
    const role = this.roleFor({ id: sessionId })
    if (role === undefined) return undefined
    const snapshot = this.bindings.memorySnapshot(sessionId, role.id)
    if (snapshot === undefined) return undefined
    return { role: role.id, stale: snapshot !== this.memories.text(role.id) }
  }

  /** 把角色记忆的当前版本应用到会话：下一轮组装起本会话使用新版。会话当前不是这个角色或已是新版时不动。 */
  applyMemory(sessionId: string, roleId: string): void {
    if (this.memoryState(sessionId)?.stale !== true || this.memoryState(sessionId)?.role !== roleId) return
    this.bindings.replaceMemorySnapshot(sessionId, roleId, this.memories.text(roleId))
  }

  /** 用户手动改了记忆：所有当前用这个角色、快照落后的会话都换上新版。 */
  applyMemoryToRole(roleId: string): void {
    for (const sessionId of this.bindings.sessionIds()) this.applyMemory(sessionId, roleId)
  }

  recordTurn(session: QqbotSession, turn: number): void {
    try {
      this.bindings.recordTurn(session.id, turn, this.roleIdFor(session) ?? null)
    } catch (error) {
      this.warn(`qqbot: 记不下会话 ${session.id} 第 ${turn} 轮的角色：${String(error)}`)
    }
  }
}
