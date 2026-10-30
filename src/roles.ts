/**
 * 角色库：`<数据目录>/roles/` 下每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`。
 * 文件格式：frontmatter（id、name、description、memeFrequency、voiceId 等）+ 正文。格式参考 dsh-persona-switcher（MIT，yupaoa）。
 * id 是内部键（会话绑定、头像、预设选择都按它记），界面上不显示，也不让用户填：编辑器新建时自动生成，
 * 手写的文件不写 id 时用文件名。用户按名称认角色，所以编辑器保存时要求名称不重复。
 */

import { randomBytes } from 'node:crypto'
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

/** 接口和头像文件名接受的 id 格式。扫描时更宽松，手写的文件名不合规也能读到。 */
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

/** 编辑界面提交的角色内容。修改时带 id；新建时不带，由 save() 生成。 */
export interface RoleDraft {
  readonly id?: string
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
  if (id !== undefined && (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id))) throw new TypeError('角色 id 无效')
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
    ...id === undefined ? {} : { id }, name: name.trim(), description: description.trim(), persona: persona.trim(),
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

/** 把编辑结果写成角色文件文本。existing 为原文件内容；新建时为空，id 写进 frontmatter，用户改目录名也不丢绑定。 */
export function renderRole(draft: RoleDraft & { readonly id: string }, existing: string | undefined): string {
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
        this.warn(`qqbot: 角色 id "${role.id}" 重复（frontmatter 的 id 或文件名），${file} 已跳过`)
      } else {
        roles.set(role.id, role)
        files.set(role.id, file)
      }
    }
    this.roles = roles
    this.files = files
  }

  /**
   * 新建或修改一个角色。新建时编辑器不带 id，生成一个没用过的；带了 id（测试等内部调用）时不能已存在。
   * 修改时 id 必须已存在。名称不能和别的角色重复。
   * 修改只换 name、description、memeFrequency 和正文，frontmatter 其他字段保留。新建写成 `<id>/ROLE.md`。
   */
  save(value: unknown, create: boolean): Role {
    const draft = validateRoleDraft(value)
    this.reload()
    if (!create && draft.id === undefined) throw new TypeError('缺少角色 id')
    const id = draft.id ?? this.freshId()
    const existingFile = this.files.get(id)
    if (create && existingFile !== undefined) throw new Error('这个角色已经存在')
    if (!create && existingFile === undefined) throw new Error('这个角色已经不在角色库里，可能已在文件里删除')
    if (this.list().some(role => role.id !== id && role.name === draft.name)) throw new Error(`已经有叫"${draft.name}"的角色，换个名称`)
    const file = existingFile ?? join(this.dir, id, 'ROLE.md')
    // 同名文件已存在但没读出角色（例如没有正文），不覆盖用户的文件。只有图片的同名目录可以用。
    if (existingFile === undefined && (existsSync(file) || existsSync(join(this.dir, `${id}.md`)))) {
      throw new Error('角色库里有同名的文件，但读不出角色，请先检查这个文件')
    }
    const existing = existingFile === undefined ? undefined : readFileSync(existingFile, 'utf8')
    writeText(file, renderRole({ ...draft, id }, existing))
    this.reload()
    const saved = this.roles.get(id)
    if (saved === undefined) throw new Error(`角色"${draft.name}"写入后读不出来`)
    return saved
  }

  /** 新角色的 id：`r-` 加 8 位十六进制，避开已有的角色和同名的文件、目录（不覆盖读不出角色的手写文件）。 */
  private freshId(): string {
    for (;;) {
      const id = `r-${randomBytes(4).toString('hex')}`
      if (!this.roles.has(id) && !existsSync(join(this.dir, id)) && !existsSync(join(this.dir, `${id}.md`))) return id
    }
  }

  /** 按名称找角色，给 `/role <名称>` 用；名称重复（手写的文件）时取第一个。也认 id，兼容直接改文件的用户。 */
  find(nameOrId: string): Role | undefined {
    const wanted = nameOrId.trim()
    return this.list().find(role => role.name === wanted) ?? this.roles.get(wanted)
  }

  /**
   * 删除角色：移到 `<数据目录>/roles-trash/`，不真正删除文件，用户可以手动放回。
   * 目录形式的角色整个目录一起移走。alsoMove 用同一个时间戳把相关文件（头像）也移进回收站。
   */
  remove(id: string, alsoMove?: (trashDir: string, stamp: string) => void): void {
    this.reload()
    const file = this.files.get(id)
    if (file === undefined) throw new Error('这个角色已经不在角色库里，可能已在文件里删除')
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
