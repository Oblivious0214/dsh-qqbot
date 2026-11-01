/**
 * 会话和角色的绑定：`<数据目录>/sessions.json`。
 *
 * 一个会话有三种状态：没有记录（还没开始，或从没用过角色库）、绑定了某个角色、主动选了"不用角色"（null）。
 * 没有记录的会话第一次真实组装时取新会话默认角色并写下来，之后改默认角色不影响已有会话。
 * 不按时间清理记录：长期使用的会话不能丢角色，每条记录只有几十字节。
 *
 * 每个会话还记着各轮用的角色（`turns`），只在换人时追加一条，供界面按消息显示头像。不进提示词。
 * `memory` 是各角色在本会话第一次出场时的记忆快照，整个会话都用它，重新打开旧会话也不变（docs/architecture.md 第 6 节）。
 */

import { join } from 'node:path'
import { isRecord, readJson, writeJson, type Warn } from './storage.ts'

/** 会话主动选了不用角色。和"没有记录"不同：默认角色不能接管它。 */
export const NO_ROLE = null

export type RoleChoice = string | typeof NO_ROLE

/** 从 turn 这一轮起用 role，直到下一条。role 是当时组装用的角色 id，没有角色时为 null。 */
export interface TurnRole {
  readonly turn: number
  readonly role: string | null
}

/** 每个会话最多记多少次换人。超出时丢最早的，那几轮的头像按最早留下的一条显示。 */
const TURN_HISTORY_LIMIT = 200

interface SessionEntry {
  readonly role: RoleChoice
  readonly at: string
  readonly turns?: readonly TurnRole[]
  /** 角色 id → 记忆快照。空串也记：表示出场时没有记忆，之后整理出的记忆不进本会话。 */
  readonly memory?: Readonly<Record<string, string>>
}

interface BindingFile {
  readonly version: 1
  /** 新 qqbot 会话的默认角色；为空表示新会话不带角色。 */
  readonly defaultRole?: string
  readonly sessions: Readonly<Record<string, SessionEntry>>
}

export class SessionBindings {
  private state: BindingFile

  constructor(private readonly file: string | undefined, private readonly warn: Warn, private readonly now = () => new Date()) {
    this.state = file === undefined ? { version: 1, sessions: {} } : this.load(file)
  }

  /** 从磁盘重新读取；清理后不保留旧会话绑定。 */
  reload(): void { this.state = this.file === undefined ? { version: 1, sessions: {} } : this.load(this.file) }

  static at(dir: string, warn: Warn): SessionBindings {
    return new SessionBindings(join(dir, 'sessions.json'), warn)
  }

  /** 会话的选择；没有记录时为 undefined。 */
  get(sessionId: string): RoleChoice | undefined {
    return this.state.sessions[sessionId]?.role
  }

  /** 记下会话的选择；值没变时不写盘。 */
  set(sessionId: string, role: RoleChoice): void {
    const entry = this.state.sessions[sessionId]
    if (entry?.role === role) return
    this.commitSession(sessionId, { ...entry, role, at: this.now().toISOString() })
  }

  /** 会话各轮用的角色，按轮次升序；没有记录时为空。 */
  turnsOf(sessionId: string): readonly TurnRole[] {
    return this.state.sessions[sessionId]?.turns ?? []
  }

  /**
   * 记下第 turn 轮用的角色。和上一条相同时不写盘，所以每轮调用也只在换人时写。
   * 比 turn 晚的记录是撤回或重新生成前的旧轮次，一起去掉。会话还没有选择记录时不记。
   */
  recordTurn(sessionId: string, turn: number, role: string | null): void {
    const entry = this.state.sessions[sessionId]
    if (entry === undefined || !Number.isSafeInteger(turn) || turn < 0) return
    const current = entry.turns ?? []
    const kept = current.filter(item => item.turn < turn)
    const turns = (kept.at(-1)?.role === role ? kept : [...kept, { turn, role }]).slice(-TURN_HISTORY_LIMIT)
    // 同一轮的后续步骤（工具调用之后）算出来和现有记录一样。
    if (turns.length === current.length && turns.every((item, i) => item.turn === current[i]!.turn && item.role === current[i]!.role)) return
    this.commitSession(sessionId, { ...entry, turns })
  }

  /** 会话里这个角色的记忆快照；还没取过时为 undefined。 */
  memorySnapshot(sessionId: string, roleId: string): string | undefined {
    return this.state.sessions[sessionId]?.memory?.[roleId]
  }

  /** 记下快照。已经有了不覆盖；会话还没有选择记录时不记。 */
  setMemorySnapshot(sessionId: string, roleId: string, text: string): void {
    const entry = this.state.sessions[sessionId]
    if (entry === undefined || entry.memory?.[roleId] !== undefined) return
    this.commitSession(sessionId, { ...entry, memory: { ...entry.memory, [roleId]: text } })
  }

  /** 有记录的全部会话 id。 */
  sessionIds(): readonly string[] {
    return Object.keys(this.state.sessions)
  }

  /** 把新版记忆应用到这个会话时覆盖快照。会话还没有选择记录或内容相同时不写。 */
  replaceMemorySnapshot(sessionId: string, roleId: string, text: string): void {
    const entry = this.state.sessions[sessionId]
    if (entry === undefined || entry.memory?.[roleId] === text) return
    this.commitSession(sessionId, { ...entry, memory: { ...entry.memory, [roleId]: text } })
  }

  get defaultRole(): string | undefined {
    return this.state.defaultRole
  }

  setDefaultRole(role: string | undefined): void {
    if (this.state.defaultRole === role) return
    const { defaultRole: _previous, ...rest } = this.state
    this.commit(role === undefined ? rest : { ...rest, defaultRole: role })
  }

  private commitSession(sessionId: string, entry: SessionEntry): void {
    this.commit({ ...this.state, sessions: { ...this.state.sessions, [sessionId]: entry } })
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
    const sessions: Record<string, SessionEntry> = {}
    if (isRecord(raw['sessions'])) {
      for (const [id, entry] of Object.entries(raw['sessions'])) {
        if (!isRecord(entry)) continue
        const role = entry['role']
        if (role !== NO_ROLE && (typeof role !== 'string' || role === '')) continue
        const turns = loadTurns(entry['turns'])
        const memory = loadMemory(entry['memory'])
        sessions[id] = {
          role, at: typeof entry['at'] === 'string' ? entry['at'] : '',
          ...turns.length === 0 ? {} : { turns },
          ...memory === undefined ? {} : { memory },
        }
      }
    }
    const defaultRole = raw['defaultRole']
    return typeof defaultRole === 'string' && defaultRole !== ''
      ? { version: 1, defaultRole, sessions }
      : { version: 1, sessions }
  }
}

/** 读各轮角色：去掉格式不对的条目，按轮次升序，同一轮只留最后一条。 */
function loadTurns(value: unknown): TurnRole[] {
  if (!Array.isArray(value)) return []
  const byTurn = new Map<number, string | null>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const { turn, role } = item
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) continue
    if (role !== null && (typeof role !== 'string' || role === '')) continue
    byTurn.set(turn, role)
  }
  return [...byTurn].sort((a, b) => a[0] - b[0]).map(([turn, role]) => ({ turn, role })).slice(-TURN_HISTORY_LIMIT)
}

/** 读记忆快照：只留字符串值。 */
function loadMemory(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}
