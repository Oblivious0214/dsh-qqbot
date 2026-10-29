/**
 * 会话和角色的绑定：`<数据目录>/sessions.json`。
 *
 * 一个会话有三种状态：没有记录（还没开始，或从没用过角色库）、绑定了某个角色、主动选了"不用角色"（null）。
 * 没有记录的会话第一次真实组装时取新会话默认角色并写下来，之后改默认角色不影响已有会话。
 * 旧插件按 180 天清理记录，长期使用的会话会因此丢角色，这里不清理；每条记录只有几十字节。
 */

import { join } from 'node:path'
import { isRecord, readJson, writeJson, type Warn } from './storage.ts'

/** 会话主动选了不用角色。和"没有记录"不同：默认角色不能接管它。 */
export const NO_ROLE = null

export type RoleChoice = string | typeof NO_ROLE

interface BindingFile {
  readonly version: 1
  /** 新 qqbot 会话的默认角色；为空表示新会话不带角色。 */
  readonly defaultRole?: string
  readonly sessions: Readonly<Record<string, { readonly role: RoleChoice; readonly at: string }>>
}

export class SessionBindings {
  private state: BindingFile

  constructor(private readonly file: string | undefined, private readonly warn: Warn, private readonly now = () => new Date()) {
    this.state = file === undefined ? { version: 1, sessions: {} } : this.load(file)
  }

  static at(dir: string, warn: Warn): SessionBindings {
    return new SessionBindings(join(dir, 'sessions.json'), warn)
  }

  /** 会话的选择；没有记录时为 undefined。 */
  get(sessionId: string): RoleChoice | undefined {
    return this.state.sessions[sessionId]?.role
  }

  /** 记下会话的选择；值没变时不写盘。 */
  set(sessionId: string, role: RoleChoice): void {
    if (this.state.sessions[sessionId]?.role === role) return
    this.commit({ ...this.state, sessions: { ...this.state.sessions, [sessionId]: { role, at: this.now().toISOString() } } })
  }

  get defaultRole(): string | undefined {
    return this.state.defaultRole
  }

  setDefaultRole(role: string | undefined): void {
    if (this.state.defaultRole === role) return
    const { defaultRole: _previous, ...rest } = this.state
    this.commit(role === undefined ? rest : { ...rest, defaultRole: role })
  }

  private commit(next: BindingFile): void {
    if (this.file !== undefined) writeJson(this.file, next)
    this.state = next
  }

  private load(file: string): BindingFile {
    const raw = readJson(file, this.warn)
    if (!isRecord(raw)) {
      if (raw !== undefined) this.warn(`qqbot: ${file} 格式无效，会话绑定从空开始`)
      return { version: 1, sessions: {} }
    }
    const sessions: Record<string, { role: RoleChoice; at: string }> = {}
    if (isRecord(raw['sessions'])) {
      for (const [id, entry] of Object.entries(raw['sessions'])) {
        if (!isRecord(entry)) continue
        const role = entry['role']
        if (role !== NO_ROLE && (typeof role !== 'string' || role === '')) continue
        sessions[id] = { role, at: typeof entry['at'] === 'string' ? entry['at'] : '' }
      }
    }
    const defaultRole = raw['defaultRole']
    return typeof defaultRole === 'string' && defaultRole !== ''
      ? { version: 1, defaultRole, sessions }
      : { version: 1, sessions }
  }
}
