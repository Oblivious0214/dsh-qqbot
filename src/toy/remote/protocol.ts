import { reduceIntent, type Intent } from '../core/intent.ts'

export const REMOTE_VERSION = '0.1.1'
export interface Route {
  adapter: 'astrbot' | 'qq-bridge'
  account: string
  platform: string
  conversation: string
  user: string
}
export interface Envelope {
  v: 1
  type: string
  leaseId: string
  route: Route
  seq: number
  generation: number
}
export interface Lease extends Envelope {
  type: 'lease' | 'heartbeat'
  serverTime: number
  expiresAt: number
}
export interface Command extends Envelope {
  type: 'command'
  commandId: string
  turnId: string
  segment: number
  issuedAt: number
  expiresAt: number
  holdMs: number
  motion: Intent | { stop: true }
}
export interface Cancel extends Envelope { type: 'cancel'; reason: string }
export type ServerFrame = Lease | Command | Cancel

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-object')
  return value as Record<string, unknown>
}
export function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid-string')
  return value
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid-number')
  return value
}
export function parseRoute(value: unknown): Route {
  const r = record(value)
  if (r.adapter !== 'astrbot' && r.adapter !== 'qq-bridge') throw new Error('invalid-adapter')
  return { adapter: r.adapter, account: string(r.account), platform: string(r.platform), conversation: string(r.conversation), user: string(r.user) }
}
export function sameRoute(a: Route, b: Route): boolean {
  return a.adapter === b.adapter && a.account === b.account && a.platform === b.platform && a.conversation === b.conversation && a.user === b.user
}
export function decode(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('frame-too-large')
  const r = record(JSON.parse(text))
  if (r.v !== 1) throw new Error('unsupported-version')
  return r
}
export function parseServerFrame(value: unknown): ServerFrame {
  const r = record(value)
  if (r.v !== 1) throw new Error('unsupported-version')
  const base = { v: 1 as const, leaseId: string(r.leaseId), route: parseRoute(r.route), seq: integer(r.seq), generation: integer(r.generation) }
  if (r.type === 'lease' || r.type === 'heartbeat') {
    const serverTime = integer(r.serverTime), expiresAt = integer(r.expiresAt)
    if (expiresAt <= serverTime || expiresAt - serverTime > 10000) throw new Error('invalid-lease')
    return { ...base, type: r.type, serverTime, expiresAt }
  }
  if (r.type === 'cancel') return { ...base, type: 'cancel', reason: string(r.reason, 80) }
  if (r.type !== 'command') throw new Error('invalid-type')
  const intent = reduceIntent(null, r.motion)
  const issuedAt = integer(r.issuedAt), expiresAt = integer(r.expiresAt)
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 10000) throw new Error('invalid-expiry')
  return { ...base, type: 'command', commandId: string(r.commandId), turnId: string(r.turnId), segment: integer(r.segment, 0, 31),
    issuedAt, expiresAt, holdMs: integer(r.holdMs, 1, 30000), motion: intent ?? { stop: true } }
}
export function remoteAddress(raw: string, allowLoopback = false): string {
  const url = new URL(raw)
  if (url.username || url.password || url.hash || url.search) throw new Error('invalid-address')
  if (url.protocol !== 'wss:' && !(allowLoopback && url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('tls-required')
  return url.href
}
