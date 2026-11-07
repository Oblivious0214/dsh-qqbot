import { createHash } from 'node:crypto'
import { isRecord } from '../storage.ts'
import { LIMITS } from './types.ts'
import { fail } from './errors.ts'
export { fail, ImportError, record, text } from './errors.ts'
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
/** 排序只用于指纹，不改变原件与材料顺序。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
export function base64(value: unknown, limit = LIMITS.file): Buffer {
  if (typeof value !== 'string') return fail('malformed', '原文件必须是 base64 文本')
  if (value.length > Math.ceil(limit / 3) * 4) return fail('too-large', '文件超过大小上限')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return fail('malformed', 'base64 格式无效')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) return fail('malformed', 'base64 编码无效')
  if (bytes.length > limit) return fail('too-large', '文件超过大小上限')
  return bytes
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('malformed', '文件不是有效 UTF-8') }
}
export function json(text: string): unknown {
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { return fail('malformed', 'JSON 格式无效') }
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length) {
    const [item, depth] = stack.pop()!
    if (depth > LIMITS.depth) return fail('too-large', 'JSON 嵌套超过 64 层')
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, depth + 1])
  }
  return value
}
export const pointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')
/** 先逐值计量 JSON UTF-8 字节，超限即停；避免先构造整份响应／缩进档案字符串。 */
export function jsonBytes(value: unknown, pretty = false, limit = Number.MAX_SAFE_INTEGER): number {
  let size = 0
  const add = (n: number): void => { size += n }
  const walk = (item: unknown, depth: number): void => {
    if (size > limit) return
    if (item === null || typeof item !== 'object') { add(Buffer.byteLength(JSON.stringify(item) ?? 'null')); return }
    const array = Array.isArray(item)
    const entries = array ? item.map((v, i) => [String(i), v] as const) : Object.entries(item).filter(([, v]) => v !== undefined)
    add(2)
    for (const [i, [key, child]] of entries.entries()) {
      if (size > limit) return
      if (i) add(1)
      if (pretty) add(1 + (depth + 1) * 2)
      if (!array) add(Buffer.byteLength(JSON.stringify(key)) + (pretty ? 2 : 1))
      walk(child, depth + 1)
    }
    if (pretty && entries.length) add(1 + depth * 2)
  }
  walk(value, 0)
  return size
}
