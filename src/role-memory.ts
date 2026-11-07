/**
 * 跨会话的角色记忆：每个角色一份，存在 `<数据目录>/memories/<角色 id>.json`，不写进角色卡，
 * 编辑器保存角色时不会覆盖它。格式见 memory-format.ts，设计见 docs/architecture.md 第 6 节。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { normalizeMemory } from './memory-format.ts'
import { ROLE_ID_PATTERN } from './roles.ts'
import { isRecord, readJson, renameWithRetry, writeJson, type Warn } from './storage.ts'


/** 每个角色记多少个会话的整理进度。超出时丢最早的；被丢掉的会话下次按"从没整理过"算。 */
const SESSION_MARK_LIMIT = 50

interface MemoryFile {
  readonly version: 1
  readonly text: string
  /** 每次内容变化加一。整理开始时记下，写回时不同就说明期间被改过。 */
  readonly revision: number
  /** 会话 id → 已整理到第几轮（含）。 */
  readonly sessions: Readonly<Record<string, number>>
}

const EMPTY: MemoryFile = { version: 1, text: '', revision: 0, sessions: {} }

/**
 * 角色记忆的读写。每次现读文件：读的地方只有取快照、编辑器和整理，次数很少，
 * 用户直接改了文件也能马上生效。dir 为空时只存在内存里（测试用）。
 */
export class MemoryStore {
  private readonly memory = new Map<string, MemoryFile>()
  /** 已经警告过的坏文件内容，同样的内容不重复警告。 */
  private readonly warned = new Set<string>()

  constructor(readonly dir: string | undefined, private readonly warn: Warn) {}

  /** 释放旧资料副本，后续现读磁盘。 */
  clearCache(): void { this.memory.clear(); this.warned.clear() }
  /** 仅供同 stamp 数据事务登记关联文件。 */
  filePath(roleId: string): string | undefined { return this.dir === undefined ? undefined : this.file(roleId) }

  static at(dataDir: string, warn: Warn): MemoryStore {
    return new MemoryStore(join(dataDir, 'memories'), warn)
  }

  /** 角色记忆的当前文本；没有记忆时为空串。 */
  text(roleId: string): string {
    return this.load(roleId).text
  }

  revision(roleId: string): number {
    return this.load(roleId).revision
  }

  /** 会话已整理到第几轮；没整理过时为 undefined。 */
  consolidatedTurn(roleId: string, sessionId: string): number | undefined {
    return this.load(roleId).sessions[sessionId]
  }

  /** 用户手动修改。格式不对抛 MemoryFormatError；内容没变时不写盘。返回规范化后的文本。 */
  save(roleId: string, text: string): string {
    const normalized = normalizeMemory(text)
    const current = this.load(roleId)
    if (current.text !== normalized) this.commit(roleId, { ...current, text: normalized, revision: current.revision + 1 })
    return normalized
  }

  /**
   * 写回一次整理的结果，并记下会话整理到的轮次。revision 和整理开始时不同（期间用户改过或另一次整理写过）时
   * 不写，返回 false。text 为 undefined 表示这次没有可用结果（超长等），只推进轮次，避免同一段内容反复整理。
   */
  commitConsolidation(roleId: string, expectedRevision: number, sessionId: string, turn: number, text: string | undefined): boolean {
    const current = this.load(roleId)
    if (current.revision !== expectedRevision) return false
    const sessions = Object.entries({ ...current.sessions, [sessionId]: turn }).slice(-SESSION_MARK_LIMIT)
    const changed = text !== undefined && text !== current.text
    this.commit(roleId, {
      ...current,
      ...changed ? { text, revision: current.revision + 1 } : {},
      sessions: Object.fromEntries(sessions),
    })
    return true
  }

  /** 删角色时把记忆一起移进回收站，和角色卡用同一个时间戳。 */
  trash(roleId: string, trashDir: string, stamp: string): void {
    this.memory.delete(roleId)
    if (this.dir === undefined) return
    const file = this.file(roleId)
    if (!existsSync(file)) return
    mkdirSync(trashDir, { recursive: true })
    renameWithRetry(file, join(trashDir, `${stamp}-${basename(file, '.json')}.memory.json`))
  }

  /** 手写角色卡的 id 可能含路径字符，这时文件名用 id 的散列。 */
  private file(roleId: string): string {
    const name = ROLE_ID_PATTERN.test(roleId) ? roleId : `x-${createHash('sha256').update(roleId).digest('hex').slice(0, 16)}`
    return join(this.dir!, `${name}.json`)
  }

  private load(roleId: string): MemoryFile {
    if (this.dir === undefined) return this.memory.get(roleId) ?? EMPTY
    const raw = readJson(this.file(roleId), this.warn)
    if (!isRecord(raw)) return EMPTY
    const sessions: Record<string, number> = {}
    if (isRecord(raw['sessions'])) {
      for (const [id, turn] of Object.entries(raw['sessions'])) {
        if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) sessions[id] = turn
      }
    }
    const revision = typeof raw['revision'] === 'number' && Number.isSafeInteger(raw['revision']) ? raw['revision'] : 0
    let text = ''
    if (typeof raw['text'] === 'string') {
      // 用户直接改了文件：按同样的规则规范化；改坏了警告并当作没有记忆，文件留给用户修。
      try { text = normalizeMemory(raw['text'], true) } catch (error) {
        const key = `${roleId}\n${raw['text']}`
        if (!this.warned.has(key)) {
          this.warned.add(key)
          this.warn(`qqbot: 角色记忆 ${this.file(roleId)} 无效，按没有记忆处理：${String(error)}`)
        }
      }
    }
    return { version: 1, text, revision, sessions }
  }

  private commit(roleId: string, next: MemoryFile): void {
    if (this.dir === undefined) this.memory.set(roleId, next)
    else writeJson(this.file(roleId), next)
  }
}
