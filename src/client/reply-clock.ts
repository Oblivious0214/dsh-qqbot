/**
 * [qq] 分段回复的显示时钟。每条实时回复一行，自己按计时器逐段推进，组件只读"现在显示几段"。
 * 计时不依赖组件是否挂载：切走会话或滚动后，段落仍按时出现，外部插件（设备）仍按时收到通知。
 *
 * - 流式输出时第一段一闭合就显示，之后每段在上一段显示后过 holdMs 出现；到点了下一段还没生成出来，就等它生成出来再显示。
 * - holdMs 先问外部插件（SegmentHooks.durations，例如设备按 cycles 算出的时长），没有时用界面设置的间隔。
 * - 暂停（pause）时这个会话里的回复停在当前段，恢复后从剩余时间接着走。
 * - 用户发了新消息（interrupt）时没出现的段落不再出现。
 * - 历史回复（不是实时的）直接全部显示，不计时，也不通知外部插件。
 *
 * 每行的通知顺序固定：revealed 若干次，最后一次 ended。
 */

/** 交给外部插件的段落：文字和协议扩展字段，原样来自 [qq] 块。 */
export interface SegmentStage {
  readonly text: string
  readonly cycles?: number
  readonly motion?: unknown
  /** 回复的 JSON 坏了，这一段是尽量抽出来的文字，没有 cycles 和 motion。设备插件应停止本条回复的动作。 */
  readonly salvaged?: true
}

export type SegmentEndReason =
  /** 所有段落都已显示，回复已经完整。 */
  | 'complete'
  /** 用户发了新消息，剩下的段落不再出现。 */
  | 'interrupted'
  /** 回复格式无效、生成中断没写完，或同一位置换成了另一条回复。已显示的段落保留。 */
  | 'failed'
  /** dsh-qqbot 停用或页面关闭。 */
  | 'closed'

/** 外部插件的回调。都是可选的；抛出的错误只记日志，不影响文字显示。 */
export interface SegmentHooks {
  /**
   * 第 index 段显示后到下一段要停多久（毫秒）。返回 undefined 时用 qqbot 自己的间隔。
   * stages 是目前已经生成出来的段落（流式时可能还有后续），至少包含第 index 段。
   * 多个插件都返回数字时取第一个。结果限制在 0 到 120000。
   */
  durations?(session: string, reply: string, stages: readonly SegmentStage[], index: number): number | undefined
  /**
   * 第 index 段刚显示。holdMs 是到下一段预定的间隔；回复已经完整且这是最后一段时为 undefined。
   * 流式时下一段可能晚于 holdMs 才出现，那时会再收到一次 revealed。
   */
  revealed?(session: string, reply: string, index: number, stage: SegmentStage, holdMs: number | undefined): void
  /** 这条回复不会再有新段落。每条实时回复恰好一次，在最后一次 revealed 之后。 */
  ended?(session: string, reply: string, reason: SegmentEndReason): void
}

export interface ClockTimers {
  now(): number
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: ClockTimers = {
  now: () => performance.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export const MAX_HOLD_MS = 120000

interface Row {
  readonly session: string
  readonly reply: string
  /** 历史回复：全部显示，不计时，不通知。 */
  readonly passive: boolean
  stages: readonly SegmentStage[]
  complete: boolean
  shown: number
  /** 下一段最早什么时候出现（timers.now 的时间）。 */
  due: number
  /** 暂停时还剩多久。 */
  left: number | undefined
  timer: unknown
  ended: boolean
}

export interface ReplyClockOptions {
  /** 外部插件没给停留时间时的间隔，来自界面设置。 */
  readonly delay: (text: string) => number
  /** 显示的段数变了。 */
  readonly onChange: () => void
  readonly onError: (error: unknown) => void
  readonly timers?: ClockTimers
}

const MAX_ROWS = 500
export class ReplyClock {
  private readonly rows = new Map<string, Row>()
  private readonly hooks = new Set<SegmentHooks>()
  /** 每个会话的暂停持有数。 */
  private readonly pauses = new Map<string, number>()
  private readonly timers: ClockTimers

  constructor(private readonly options: ReplyClockOptions) {
    this.timers = options.timers ?? realTimers
  }

  register(hooks: SegmentHooks): () => void {
    const entry = { ...hooks }
    this.hooks.add(entry)
    return () => { this.hooks.delete(entry) }
  }

  /**
   * 收到一条回复目前的段落。live 只在第一次见到这条回复时起作用：实时的逐段显示，否则全部显示。
   * 同一位置的段落和已显示的不一致时（重新生成），旧的一行以 failed 结束，从头开始。
   */
  feed(session: string, reply: string, stages: readonly SegmentStage[], complete: boolean, live: boolean): void {
    const key = keyOf(session, reply)
    let row = this.rows.get(key)
    if (row !== undefined && !row.passive && stages.slice(0, row.shown).some((stage, i) => stage.text !== row!.stages[i]?.text)) {
      this.end(row, 'failed')
      this.rows.delete(key)
      row = undefined
    }
    if (row === undefined) {
      row = { session, reply, passive: !live, stages, complete, shown: 0, due: this.timers.now(), left: undefined, timer: undefined, ended: !live }
      this.rows.set(key, row)
      this.trim()
      if (live) this.kick(row)
      return
    }
    if (row.passive) { row.stages = stages; return }
    if (row.ended) return
    row.stages = stages
    row.complete = complete
    if (row.shown < stages.length) this.kick(row)
    else if (complete) this.finish(row)
  }

  /** 回复已经结束但不能显示（格式无效、没写完）：已显示的段落保留，不再推进。 */
  fail(session: string, reply: string): void {
    const row = this.rows.get(keyOf(session, reply))
    if (row !== undefined) this.end(row, 'failed')
  }

  /** 现在该显示几段。没见过的回复返回 undefined。 */
  count(session: string, reply: string): number | undefined {
    const row = this.rows.get(keyOf(session, reply))
    if (row === undefined) return undefined
    return row.passive ? row.stages.length : row.shown
  }

  /** 用户发了新消息：这个会话里还在推进的回复都停在当前段。 */
  interrupt(session: string): void {
    for (const row of this.rows.values()) if (row.session === session) this.end(row, 'interrupted')
  }

  /** 暂停这个会话的逐段显示，返回恢复函数。多处同时暂停时，全部恢复后才继续。 */
  pause(session: string): () => void {
    const held = this.pauses.get(session) ?? 0
    this.pauses.set(session, held + 1)
    if (held === 0) {
      const now = this.timers.now()
      for (const row of this.active(session)) {
        row.left = Math.max(0, row.due - now)
        this.clearTimer(row)
      }
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const rest = (this.pauses.get(session) ?? 1) - 1
      if (rest > 0) { this.pauses.set(session, rest); return }
      this.pauses.delete(session)
      const now = this.timers.now()
      for (const row of this.active(session)) {
        if (row.left !== undefined) row.due = now + row.left
        row.left = undefined
        if (row.shown < row.stages.length) this.kick(row)
        else if (row.complete) this.finish(row)
      }
    }
  }

  paused(session: string): boolean {
    return this.pauses.has(session)
  }

  dispose(): void {
    for (const row of this.rows.values()) this.end(row, 'closed')
    this.rows.clear()
    this.hooks.clear()
    this.pauses.clear()
  }

  private *active(session: string): Iterable<Row> {
    for (const row of this.rows.values()) if (row.session === session && !row.ended) yield row
  }

  /** 有下一段可显示时排上计时器；暂停时什么也不做，恢复时再排。 */
  private kick(row: Row): void {
    if (row.ended || row.timer !== undefined || this.paused(row.session) || row.shown >= row.stages.length) return
    row.timer = this.timers.set(() => { this.advance(row) }, Math.max(0, row.due - this.timers.now()))
  }

  private advance(row: Row): void {
    row.timer = undefined
    if (row.ended || this.paused(row.session) || row.shown >= row.stages.length) return
    const index = row.shown++
    const stage = row.stages[index]!
    const hold = this.hold(row, index)
    row.due = this.timers.now() + hold
    const last = row.complete && row.shown === row.stages.length
    this.options.onChange()
    this.emit(hooks => hooks.revealed?.(row.session, row.reply, index, stage, last ? undefined : hold))
    if (last) this.end(row, 'complete')
    else this.kick(row)
  }

  /** 回复刚变成完整，而最后一段早已显示：补一次 revealed（holdMs 为 undefined）再结束。 */
  private finish(row: Row): void {
    if (row.ended || this.paused(row.session)) return
    this.clearTimer(row)
    const index = row.shown - 1
    if (index >= 0) this.emit(hooks => hooks.revealed?.(row.session, row.reply, index, row.stages[index]!, undefined))
    this.end(row, 'complete')
  }

  private hold(row: Row, index: number): number {
    const stage = row.stages[index]!
    let value: number | undefined
    for (const hooks of this.hooks) {
      if (hooks.durations === undefined) continue
      try {
        const result = hooks.durations(row.session, row.reply, row.stages, index)
        if (typeof result === 'number' && Number.isFinite(result)) { value = result; break }
      } catch (error) {
        this.options.onError(error)
      }
    }
    if (value === undefined) {
      try { value = this.options.delay(stage.text) } catch (error) { this.options.onError(error) }
    }
    return Math.min(MAX_HOLD_MS, Math.max(0, value ?? 0))
  }

  private end(row: Row, reason: SegmentEndReason): void {
    if (row.ended) return
    row.ended = true
    this.clearTimer(row)
    this.emit(hooks => hooks.ended?.(row.session, row.reply, reason))
  }

  private clearTimer(row: Row): void {
    if (row.timer !== undefined) this.timers.clear(row.timer)
    row.timer = undefined
  }

  private emit(call: (hooks: SegmentHooks) => void): void {
    for (const hooks of [...this.hooks]) {
      try { call(hooks) } catch (error) { this.options.onError(error) }
    }
  }

  /** 只淘汰已经结束的行；还在推进的回复不会被挤掉。 */
  private trim(): void {
    if (this.rows.size <= MAX_ROWS) return
    for (const [key, row] of this.rows) {
      if (this.rows.size <= MAX_ROWS) break
      if (row.ended) this.rows.delete(key)
    }
  }
}

const keyOf = (session: string, reply: string) => `${session}\u0000${reply}`
