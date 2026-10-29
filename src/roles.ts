/**
 * 角色库：`<数据目录>/roles/` 下每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`。
 * 文件格式沿用 dsh-persona-switcher（frontmatter + 正文），旧角色卡复制过来即可使用。
 * 解析规则迁移自 dsh-persona-switcher lib/index.js 的 parseRole / scanRoles（MIT，yupaoa）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Warn } from './storage.ts'

export interface Role {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 角色正文，进入 `qqbot:persona`。 */
  readonly persona: string
  /** 语音和表情偏好原样保留，迁移语音、表情规则时再使用。 */
  readonly voiceId: string
  readonly voicePreviewText: string
  readonly memePreference: unknown
}

/** 新建或切换时用的 id 格式。扫描时更宽松，旧文件名不合规也能读到。 */
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function splitFrontmatter(text: string): { front: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return { front: '', body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { front: '', body: normalized }
  const after = normalized.indexOf('\n', end + 1)
  return { front: normalized.slice(3, end), body: after < 0 ? '' : normalized.slice(after + 1) }
}

function rawScalar(front: string, key: string): string | undefined {
  return new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, 'm').exec(front)?.[1]?.trim()
}

/** 普通字段：可带单引号或双引号。 */
function scalar(front: string, key: string): string | undefined {
  const value = rawScalar(front, key)
  if (value === undefined) return undefined
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** 语音字段旧插件写成 JSON 字符串，引号和换行才能往返。 */
function jsonScalar(front: string, key: string): string {
  const raw = rawScalar(front, key)
  if (raw === undefined || raw === '') return ''
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' ? value : ''
  } catch {
    return raw
  }
}

function jsonValue(front: string, key: string): unknown {
  const raw = rawScalar(front, key)
  if (raw === undefined || raw === '') return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/** 解析一个角色文件；没有正文时返回 undefined。 */
export function parseRole(text: string, fallbackId: string): Role | undefined {
  const { front, body } = splitFrontmatter(text)
  const persona = body.trim()
  if (persona === '') return undefined
  const id = (scalar(front, 'id') ?? fallbackId).trim()
  if (id === '') return undefined
  return {
    id,
    name: (scalar(front, 'name') ?? id).trim() || id,
    description: (scalar(front, 'description') ?? '').trim(),
    persona,
    voiceId: jsonScalar(front, 'voiceId'),
    voicePreviewText: jsonScalar(front, 'voicePreviewText'),
    memePreference: jsonValue(front, 'memePreference'),
  }
}

/** 角色库条目：目录里有 ROLE.md，或 `.md` 文件。返回 [条目名, 文件路径, 默认 id]。 */
export function roleEntries(dir: string): [entry: string, file: string, fallbackId: string][] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: [string, string, string][] = []
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.isDirectory()) result.push([entry.name, join(dir, entry.name, 'ROLE.md'), entry.name])
    else if (entry.isFile() && /\.md$/i.test(entry.name)) result.push([entry.name, join(dir, entry.name), entry.name.replace(/\.md$/i, '')])
  }
  return result
}

export class RoleLibrary {
  private roles = new Map<string, Role>()

  constructor(readonly dir: string, private readonly warn: Warn) {
    this.reload()
  }

  /** 重新扫描目录。用户在文件里改了角色卡，下次 `/role` 时生效。 */
  reload(): void {
    const roles = new Map<string, Role>()
    for (const [, file, fallbackId] of roleEntries(this.dir)) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        // 目录里没有 ROLE.md 是正常情况（例如只放了图片），不警告。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`qqbot: 读不了角色文件 ${file}：${String(error)}`)
        continue
      }
      const role = parseRole(text, fallbackId)
      if (role === undefined) {
        this.warn(`qqbot: 角色文件 ${file} 没有正文，已跳过`)
      } else if (roles.has(role.id)) {
        this.warn(`qqbot: 角色 id "${role.id}" 重复，${file} 已跳过`)
      } else {
        roles.set(role.id, role)
      }
    }
    this.roles = roles
  }

  get(id: string): Role | undefined {
    return this.roles.get(id)
  }

  list(): Role[] {
    return [...this.roles.values()]
  }
}
