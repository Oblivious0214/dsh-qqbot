/** 可供两端共用的校验错误；不引入 Node 模块。 */
import type { ErrorCode } from './types.ts'
export class ImportError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) { super(message) }
}
export function fail(code: ErrorCode, message: string): never { throw new ImportError(code, message) }
export function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('malformed', `${path} 必须是对象`)
  return value as Record<string, unknown>
}
export function text(value: unknown, path: string): string {
  if (typeof value !== 'string') return fail('malformed', `${path} 必须是文本`)
  return value
}
