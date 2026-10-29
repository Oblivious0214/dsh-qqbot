/**
 * 角色库：`<数据目录>/roles/` 下每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`。
 * 文件格式：frontmatter（id、name、description、memeFrequency、voiceId 等）+ 正文。格式参考 dsh-persona-switcher（MIT，yupaoa）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isMemeFrequency, type MemeFrequency } from './format.ts'
import { isRecord, renameWithRetry, writeText, type Warn } from './storage.ts'

export interface Role {
  readonly id: string
  readonly name: string
  readonly description: string
  /** 角色正文，进入 `qqbot:persona`。 */
  readonly persona: string
  /** 表情频率（`memeFrequency: low|medium|high|off`）；没写或写错时为空，用默认档。 */
  readonly memeFrequency?: MemeFrequency
  /** 语音字段原样保留，迁移语音时再使用。 */
  readonly voiceId: string
  readonly voicePreviewText: string
}

/** 新建或切换时用的 id 格式。扫描时更宽松，手写的文件名不合规也能读到。 */
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

/** 语音字段写成 JSON 字符串，引号和换行才能往返。 */
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

/** 解析一个角色文件；没有正文时返回 undefined。 */
export function parseRole(text: string, fallbackId: string): Role | undefined {
  const { front, body } = splitFrontmatter(text)
  const persona = body.trim()
  if (persona === '') return undefined
  const id = (scalar(front, 'id') ?? fallbackId).trim()
  if (id === '') return undefined
  const memeFrequency = scalar(front, 'memeFrequency')?.trim()
  return {
    id,
    name: (scalar(front, 'name') ?? id).trim() || id,
    description: (scalar(front, 'description') ?? '').trim(),
    persona,
    ...isMemeFrequency(memeFrequency) ? { memeFrequency } : {},
    voiceId: jsonScalar(front, 'voiceId'),
    voicePreviewText: jsonScalar(front, 'voicePreviewText'),
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

/** 编辑界面提交的角色内容。id 新建后不能改：会话绑定和预设选择都按 id 记录。 */
export interface RoleDraft {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: string
  /** 为空表示用默认档，保存时去掉这一行。 */
  readonly memeFrequency?: MemeFrequency
}

const NAME_LIMIT = 64
const DESCRIPTION_LIMIT = 200
const PERSONA_LIMIT = 50_000

/** 校验编辑界面提交的角色；不合规时抛出可以直接展示给用户的错误。 */
export function validateRoleDraft(value: unknown): RoleDraft {
  if (!isRecord(value)) throw new TypeError('角色格式无效')
  const { id, name, description, persona, memeFrequency } = value
  if (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id)) throw new TypeError('角色 id 只能用小写字母、数字和连字符，最多 64 个字符')
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_LIMIT || /[\r\n]/.test(name)) {
    throw new TypeError(`角色名称不能为空，不能换行，最多 ${NAME_LIMIT} 个字符`)
  }
  if (typeof description !== 'string' || description.length > DESCRIPTION_LIMIT || /[\r\n]/.test(description)) {
    throw new TypeError(`角色简介不能换行，最多 ${DESCRIPTION_LIMIT} 个字符`)
  }
  if (typeof persona !== 'string' || persona.trim() === '' || persona.length > PERSONA_LIMIT) {
    throw new TypeError(`角色设定不能为空，最多 ${PERSONA_LIMIT} 个字符`)
  }
  if (memeFrequency !== undefined && !isMemeFrequency(memeFrequency)) throw new TypeError('表情频率无效')
  return {
    id, name: name.trim(), description: description.trim(), persona: persona.trim(),
    ...memeFrequency === undefined ? {} : { memeFrequency },
  }
}

/**
 * 替换 frontmatter 里的一个字段，没有就追加到末尾。值总是加双引号，scalar() 去掉首尾引号后原样还原。
 * 只改这一行，其他字段（语音、用户手写的字段）原样保留。
 */
function setField(front: string, key: string, value: string): string {
  const line = `${key}: "${value}"`
  const pattern = new RegExp(`^${key}[ \\t]*:.*$`, 'm')
  return pattern.test(front) ? front.replace(pattern, () => line) : `${front.replace(/\n+$/, '')}\n${line}`
}

/** 去掉 frontmatter 里的一个字段。front 以换行开头，所以每行前面都有换行。 */
function removeField(front: string, key: string): string {
  return front.replace(new RegExp(`\\n${key}[ \\t]*:.*$`, 'gm'), '')
}

/** 把编辑结果写成角色文件文本。existing 为原文件内容；新建时为空。 */
export function renderRole(draft: RoleDraft, existing: string | undefined): string {
  // splitFrontmatter 的 front 以换行开头、不以换行结尾（取的是两条 --- 之间）。
  let front = existing === undefined ? `\nid: ${draft.id}` : splitFrontmatter(existing).front
  front = setField(front, 'name', draft.name)
  front = setField(front, 'description', draft.description)
  front = draft.memeFrequency === undefined
    ? removeField(front, 'memeFrequency')
    : setField(front, 'memeFrequency', draft.memeFrequency)
  return `---${front}\n---\n\n${draft.persona}\n`
}

export class RoleLibrary {
  private roles = new Map<string, Role>()
  /** 角色 id → 文件路径。frontmatter 里的 id 可以和文件名不同，写回时按这里找文件。 */
  private files = new Map<string, string>()

  constructor(readonly dir: string, private readonly warn: Warn) {
    this.reload()
  }

  /** 重新扫描目录。用户在文件里改了角色卡，下次 `/role` 时生效。 */
  reload(): void {
    const roles = new Map<string, Role>()
    const files = new Map<string, string>()
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
        files.set(role.id, file)
      }
    }
    this.roles = roles
    this.files = files
  }

  /**
   * 新建或修改一个角色。create 为真时 id 不能已存在；为假时必须已存在。
   * 修改只换 name、description、memeFrequency 和正文，frontmatter 其他字段保留。新建写成 `<id>/ROLE.md`。
   */
  save(value: unknown, create: boolean): Role {
    const draft = validateRoleDraft(value)
    this.reload()
    const existingFile = this.files.get(draft.id)
    if (create && existingFile !== undefined) throw new Error(`已经有 id 为 "${draft.id}" 的角色`)
    if (!create && existingFile === undefined) throw new Error(`没有 id 为 "${draft.id}" 的角色`)
    let file = existingFile
    let existing: string | undefined
    if (file === undefined) {
      file = join(this.dir, draft.id, 'ROLE.md')
      // 同名文件已存在但没读出角色（例如没有正文），不覆盖用户的文件。只有图片的同名目录可以用。
      if (existsSync(file) || existsSync(join(this.dir, `${draft.id}.md`))) {
        throw new Error(`角色库里已经有 ${draft.id} 的文件，但读不出角色，请先检查这个文件`)
      }
    } else {
      existing = readFileSync(file, 'utf8')
    }
    writeText(file, renderRole(draft, existing))
    this.reload()
    const saved = this.roles.get(draft.id)
    if (saved === undefined) throw new Error(`角色 ${draft.id} 写入后读不出来`)
    return saved
  }

  /**
   * 删除角色：移到 `<数据目录>/roles-trash/`，不真正删除文件，用户可以手动放回。
   * 目录形式的角色整个目录一起移走。alsoMove 用同一个时间戳把相关文件（头像）也移进回收站。
   */
  remove(id: string, alsoMove?: (trashDir: string, stamp: string) => void): void {
    this.reload()
    const file = this.files.get(id)
    if (file === undefined) throw new Error(`没有 id 为 "${id}" 的角色`)
    const source = basename(file) === 'ROLE.md' && dirname(dirname(file)) === this.dir ? dirname(file) : file
    const trash = join(dirname(this.dir), 'roles-trash')
    mkdirSync(trash, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameWithRetry(source, join(trash, `${stamp}-${basename(source)}`))
    this.reload()
    alsoMove?.(trash, stamp)
  }

  get(id: string): Role | undefined {
    return this.roles.get(id)
  }

  list(): Role[] {
    return [...this.roles.values()]
  }
}
