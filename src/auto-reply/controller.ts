import { parseOptions, type AutoReplyOptions, type AutoReplyView } from './types.ts'

export const LEASE_MS = 8000
export interface Availability {
  allowed: boolean
  busy: boolean
  started: boolean
}
export interface AutoReplyPort {
  now(): number
  availability(session: string): Availability
  send(session: string): void
  /** Remove only this module's still-pending notice, never user input or a running turn. */
  cancelPending(session: string): void
}
interface Entry {
  owner: string
  options: AutoReplyOptions
  lastSeen: number
  due: number | null
  count: number
  enabled: boolean
  awaitingReply: boolean
  activity: number
  status: AutoReplyView['status']
  message: string
}

/** One host-owned entry per session. Only live, sequential client pulses can wake it.
 * There is no autonomous host timer that can send after a tab closes or disconnects. */
export class AutoReplyController {
  private readonly entries = new Map<string, Entry>()
  private disposed = false
  constructor(private readonly port: AutoReplyPort) {}

  enable(session: string, owner: string, options: unknown): AutoReplyView {
    if (this.disposed || !this.port.availability(session).allowed) throw new Error('请在未归档的 QQ Bot 对话中开启。')
    const parsed = parseOptions(options)
    const old = this.entries.get(session)
    if (old?.enabled && this.port.now() - old.lastSeen <= LEASE_MS) {
      if (old.owner !== owner) throw new Error('这个对话已在另一个页面开启自动接话。')
      return this.view(session) // duplicate start never resets count or wait
    }
    if (old) this.port.cancelPending(session)
    this.entries.set(session, { owner, options: parsed, lastSeen: this.port.now(), due: null,
      count: 0, enabled: true, awaitingReply: false, activity: -1, status: 'waiting', message: '' })
    return this.view(session)
  }

  pulse(session: string, owner: string, input: { blocked: boolean; activity: number }): AutoReplyView {
    const row = this.entries.get(session)
    if (!row || row.owner !== owner) throw new Error('自动接话已关闭，请重新开启。')
    if (!row.enabled) return this.view(session)
    const now = this.port.now()
    if (now - row.lastSeen > LEASE_MS) return this.stop(session, '页面已离开或连接中断，请重新开启。')
    row.lastSeen = now
    const available = this.port.availability(session)
    if (!available.allowed) return this.stop(session, '会话已关闭、归档或不可用。')
    if (row.activity !== input.activity) {
      if (row.activity !== -1) row.count = 0
      row.activity = input.activity
      row.due = null
    }
    if (input.blocked || available.busy || !available.started || row.awaitingReply) {
      if (input.blocked) this.port.cancelPending(session)
      if (!row.enabled) return this.view(session)
      row.due = null
      row.status = input.blocked ? 'input' : 'busy'
      return this.view(session)
    }
    if (row.count >= row.options.maxReplies) return this.stop(session, '已达到连续次数上限。', 'limit')
    row.status = 'waiting'
    row.due ??= now + row.options.waitSeconds * 1000
    if (now < row.due) return this.view(session)
    // Reserve before calling the host: followup emits inbox/status synchronously.
    row.due = null
    row.awaitingReply = true
    row.status = 'busy'
    row.count++
    try { this.port.send(session) } catch {
      return this.stop(session, '接话未能发出，请检查会话后重新开启。')
    }
    return this.view(session)
  }

  userInput(session: string): void {
    const row = this.entries.get(session)
    if (!row?.enabled) return
    this.port.cancelPending(session)
    row.count = 0
    row.due = null
    row.awaitingReply = true
    row.status = 'busy'
  }

  busy(session: string): void {
    const row = this.entries.get(session)
    if (row?.enabled) { row.due = null; row.status = 'busy' }
  }

  completed(session: string): void {
    const row = this.entries.get(session)
    if (!row?.enabled) return
    row.awaitingReply = false
    row.due = null
    if (row.count >= row.options.maxReplies) this.stop(session, '已达到连续次数上限。', 'limit')
  }

  disable(session: string, owner: string): void {
    if (this.entries.get(session)?.owner === owner) { this.port.cancelPending(session); this.entries.delete(session) }
  }

  stop(session: string, message: string, status: 'stopped' | 'limit' = 'stopped'): AutoReplyView {
    const row = this.entries.get(session)
    if (row) { row.enabled = false; row.due = null; row.status = status; row.message = message; this.port.cancelPending(session) }
    return this.view(session)
  }

  view(session: string): AutoReplyView {
    const row = this.entries.get(session)
    return row ? { enabled: row.enabled, count: row.count, status: row.status, message: row.message,
      remainingSeconds: row.due === null ? null : Math.max(0, Math.ceil((row.due - this.port.now()) / 1000)) }
      : { enabled: false, count: 0, remainingSeconds: null, status: 'off', message: '' }
  }

  forget(session: string): void { this.port.cancelPending(session); this.entries.delete(session) }
  sweep(): void {
    for (const [id, row] of this.entries) if (this.port.now() - row.lastSeen > LEASE_MS) this.forget(id)
  }
  clear(): void { for (const id of this.entries.keys()) this.forget(id) }
  dispose(): void { this.disposed = true; for (const id of this.entries.keys()) this.forget(id) }
}
