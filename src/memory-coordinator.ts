/**
 * 角色记忆整理的调度，在 host 层 `ctx.qqbot.memory`。
 *
 * 每个 qqbot 会话由预设内的 memory-agent 登记进来（它能拿到本会话的 agent 和 llm）。这里负责：
 * 判断新增内容够不够（消息数门槛）、同一会话不重复整理、同一角色的整理排队、写回时检查期间有没有被改过。
 * 触发时机（空闲、压缩、开新会话、手动）见 docs/architecture.md 第 6 节。
 */

import type { QqbotData } from './content.ts'
import type { ConsolidationInput, ConsolidationResult } from './memory-consolidate.ts'
import type { Warn } from './storage.ts'

/** 距上次整理至少新增多少轮（每条用户消息一轮），自动触发才整理。手动不受限。实测后再调。 */
export const MIN_NEW_TURNS = 10
/** AI 最后一次回复后多久没有新消息算空闲。DeepSeek 的前缀缓存一般能保留到这时。 */
export const IDLE_MS = 20 * 60 * 1000

/** 一个还开着的 qqbot 会话，由 memory-agent 登记。 */
export interface LiveMemorySession {
  readonly id: string
  /** 会话的最新轮次（0 表示还没聊过）。 */
  latestTurn(): number
  /** 最近一次有动静的时间，手动整理时用来挑最近的会话。 */
  lastActive(): number
  /** 同步取下当前的请求前缀；还没发过请求时为 undefined。 */
  capture(): ConsolidationInput | undefined
  /** 用取下的前缀发整理请求。 */
  run(input: ConsolidationInput, roleName: string, previous: string): Promise<ConsolidationResult>
}

export type ConsolidationOutcome =
  | { readonly kind: 'done'; readonly changed: boolean }
  /** 新内容不够、没有角色、没有可回放的请求，或这个会话正在整理。 */
  | { readonly kind: 'skipped'; readonly reason: 'no-role' | 'too-few' | 'no-request' | 'busy' }
  /** 整理期间记忆被改过，这次结果丢弃。 */
  | { readonly kind: 'stale' }
  /** 两次输出都超长或格式不对，保留旧版。 */
  | { readonly kind: 'rejected'; readonly problem: string }
  | { readonly kind: 'failed'; readonly error: string }

export class MemoryCoordinator {
  private readonly live = new Map<string, LiveMemorySession>()
  private readonly running = new Map<string, Promise<ConsolidationOutcome>>()
  /** 角色 id → 这个角色上一个整理任务；新任务接在后面。 */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly content: QqbotData, private readonly warn: Warn) {}

  /** 登记会话，返回注销函数。 */
  register(session: LiveMemorySession): () => void {
    this.live.set(session.id, session)
    return () => { if (this.live.get(session.id) === session) this.live.delete(session.id) }
  }

  /**
   * 会话里还没整理过的轮次范围：从上次整理之后、或当前角色这一段开始（取较晚的）到最新一轮。
   * 换过角色时只算当前角色这一段。
   */
  pendingTurns(sessionId: string, roleId: string, latestTurn: number): number {
    const done = this.content.memories.consolidatedTurn(roleId, sessionId) ?? 0
    const turns = this.content.bindings.turnsOf(sessionId)
    const since = turns.findLast(item => item.role === roleId)?.turn ?? 1
    // 角色这一段从 since 开始（含），所以起点之前算 since - 1 轮已"整理过"。
    return Math.max(0, latestTurn - Math.max(done, since - 1))
  }

  /** 整理一个会话。force 时不看门槛（手动），但至少要有一轮新内容。 */
  consolidate(sessionId: string, force = false): Promise<ConsolidationOutcome> {
    const existing = this.running.get(sessionId)
    if (existing !== undefined) return force ? existing : Promise.resolve({ kind: 'skipped', reason: 'busy' })
    const session = this.live.get(sessionId)
    const role = this.content.roleFor({ id: sessionId })
    if (session === undefined || role === undefined) return Promise.resolve({ kind: 'skipped', reason: 'no-role' })
    const latest = session.latestTurn()
    const pending = this.pendingTurns(sessionId, role.id, latest)
    if (pending < (force ? 1 : MIN_NEW_TURNS)) return Promise.resolve({ kind: 'skipped', reason: 'too-few' })
    // 在触发时取下前缀：压缩触发时，之后旧历史会被摘要换掉。
    const input = session.capture()
    if (input === undefined) return Promise.resolve({ kind: 'skipped', reason: 'no-request' })

    const previousTask = this.queues.get(role.id) ?? Promise.resolve()
    const task = previousTask.then(async (): Promise<ConsolidationOutcome> => {
      // 排在前面的任务可能刚写过，所以在轮到时才读旧记忆和版本号。
      const revision = this.content.memories.revision(role.id)
      const previous = this.content.memories.text(role.id)
      let result: ConsolidationResult
      try {
        result = await session.run(input, role.name, previous)
      } catch (error) {
        // 请求失败不推进进度，下次触发时重试。
        return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
      if (!this.content.memories.commitConsolidation(role.id, revision, sessionId, latest, result.text)) return { kind: 'stale' }
      if (result.text === undefined) {
        this.warn(`qqbot: 角色“${role.name}”的记忆整理结果不合格，保留旧版：${result.problem ?? ''}`)
        return { kind: 'rejected', problem: result.problem ?? '' }
      }
      return { kind: 'done', changed: result.text !== previous }
    })
    const settled = task.catch((error: unknown): ConsolidationOutcome => ({ kind: 'failed', error: String(error) }))
    this.queues.set(role.id, settled)
    this.running.set(sessionId, settled)
    void settled.then(() => {
      if (this.running.get(sessionId) === settled) this.running.delete(sessionId)
      if (this.queues.get(role.id) === settled) this.queues.delete(role.id)
    })
    return settled
  }

  /** 开新会话：同一角色其他还开着的会话有足够的新内容，就在后台整理。不等待。 */
  consolidateOthers(newSessionId: string, roleId: string): void {
    for (const session of this.live.values()) {
      if (session.id === newSessionId || this.content.roleFor({ id: session.id })?.id !== roleId) continue
      void this.consolidate(session.id).then((outcome) => {
        if (outcome.kind === 'failed') this.warn(`qqbot: 记忆整理失败：${outcome.error}`)
      })
    }
  }

  /** 手动整理：用这个角色最近有动静的、还开着的会话。找不到时抛出可以直接展示的错误。 */
  async consolidateRole(roleId: string): Promise<ConsolidationOutcome> {
    const candidates = [...this.live.values()]
      .filter(session => this.content.roleFor({ id: session.id })?.id === roleId)
      .sort((a, b) => b.lastActive() - a.lastActive())
    const session = candidates[0]
    if (session === undefined) throw new Error('没有正在用这个角色的会话。先打开和它的聊天，再整理记忆')
    return this.consolidate(session.id, true)
  }
}

/** 手动整理结果给用户看的说明；成功时为 undefined。 */
export function outcomeMessage(outcome: ConsolidationOutcome): string | undefined {
  switch (outcome.kind) {
    case 'done':
      return undefined
    case 'skipped':
      return outcome.reason === 'too-few' ? '上次整理之后还没有新的聊天内容'
        : outcome.reason === 'no-request' ? '这个会话还没有聊过，没有可整理的内容'
          : '这个会话已经不用这个角色了'
    case 'stale':
      return '整理期间记忆被修改过，这次结果没有保存，请再试一次'
    case 'rejected':
      return `整理结果太长，保留了原来的记忆：${outcome.problem}`
    case 'failed':
      return `整理请求失败：${outcome.error}`
  }
}
