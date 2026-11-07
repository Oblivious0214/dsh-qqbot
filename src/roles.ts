/**
 * 角色库：`<数据目录>/roles/` 下每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`。
 * 文件格式：frontmatter（id、name、description、memeFrequency、proactivity、motionActions、motionRanges、voice 等）+ 正文。格式参考 dsh-persona-switcher（MIT，yupaoa）。
 * id 是内部键（会话绑定、头像、预设选择都按它记），界面上不显示，也不让用户填：编辑器新建时自动生成，
 * 手写的文件不写 id 时用文件名。用户按名称认角色，所以编辑器保存时要求名称不重复。
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isMemeFrequency, type MemeFrequency } from './format.ts'
import { MOTION_RANGES, type MotionAction, type MotionRange, type RoleProactivity } from './library-types.ts'
import { renameWithRetry, writeText, type Warn } from './storage.ts'
import { VOICE_ID_PATTERN } from './voice-types.ts'
import type { MemePreferences } from './library-types.ts'
import { validateMemePreferences } from './meme-preferences.ts'
import { validateProactivityTexts } from './role-proactivity.ts'
import type { RoleProactivityTexts } from './library-types.ts'
import { validateConfig } from './role-dynamics/validate.ts'
import type { RoleDynamicsConfig } from './role-dynamics/types.ts'
import { digest } from './role-dynamics/history.ts'
import { FileDataTransaction } from './data-transactions.ts'
import { recoverConfigurationFiles } from './config-import-recovery.ts'

export interface PreparedRoleSave {
  readonly id: string; readonly file: string; readonly existing?: string; readonly text: string
  readonly draft: RoleDraft; readonly current?: Role; readonly create: boolean
}
export interface RoleTransactions {
  save(prepared: PreparedRoleSave): Promise<Role>
  remove(id: string, extras: readonly string[]): Promise<string>
  restore(stamp: string): Promise<void>
}

export interface Role extends MemePreferences {
  readonly dynamics?: RoleDynamicsConfig
  /** 损坏配置保留静态资料，但所有动态／分享／覆盖路径必须报告此错误。 */
  readonly dynamicsError?: string
  readonly dynamicsRevision?: string
  readonly id: string
  readonly name: string
  readonly description: string
  /** 角色正文，进入 `qqbot:persona`。 */
  readonly persona: string
  /** 表情频率（`memeFrequency: low|medium|high|off`）；没写或写错时为空，用默认档。 */
  readonly memeFrequency?: MemeFrequency
  /** 设备主动性上限（`proactivity: follow|situational|high`）；没写或写错时为空，表示不限。 */
  readonly proactivity?: RoleProactivity
  readonly proactivityTexts?: RoleProactivityTexts
  /** 偏好的设备动作和范围（`motionActions: slide, steady`）；不认识的值丢掉，全丢掉或没写时为空。 */
  readonly motionActions?: readonly MotionAction[]
  readonly motionRanges?: readonly MotionRange[]
  /** 音色（`voice: v-xxxxxxxx`，语音设置里音色的内部键）；没写或格式不对时为空，这个角色的回复显示文字。 */
  readonly voice?: string
}

/** 接口和头像文件名接受的 id 格式。扫描时更宽松，手写的文件名不合规也能读到。 */
export { ROLE_ID_PATTERN, isRoleProactivity, validateRoleDraft, type RoleDraft } from './role-validation.ts'
import { isRoleProactivity, validateRoleDraft, actionNames, type RoleDraft } from './role-validation.ts'
/** 逗号分隔的列表：按 choices 的顺序去重，丢掉不认识的值；一个都不剩时为空。 */
function pickList<T extends string>(raw: string | undefined, choices: readonly T[]): T[] | undefined {
  if (raw === undefined) return undefined
  const values = new Set(raw.split(/[,，]/).map(v => v.trim()))
  const picked = choices.filter(c => values.has(c))
  return picked.length === 0 ? undefined : picked
}

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

/** 新表情字段用单行 JSON，保留多行补充文字、引号和反斜线，不影响其他 frontmatter。 */
function readMemePreferences(front: string): MemePreferences {
  const result: Record<string, unknown> = {}
  for (const key of ['memePacks', 'memeTags', 'memePrompt']) {
    const raw = rawScalar(front, key)
    if (raw === undefined) continue
    try { Object.assign(result, validateMemePreferences({ [key]: JSON.parse(raw) })) } catch { /* 手写字段错误只忽略该字段。 */ }
  }
  return result as MemePreferences
}

/** 解析一个角色文件；没有正文时返回 undefined。 */
export function parseRole(text: string, fallbackId: string): Role | undefined {
  const { front, body } = splitFrontmatter(text)
  const persona = body.trim()
  if (persona === '') return undefined
  const id = (scalar(front, 'id') ?? fallbackId).trim()
  if (id === '') return undefined
  const memeFrequency = scalar(front, 'memeFrequency')?.trim()
  const proactivity = scalar(front, 'proactivity')?.trim()
  let proactivityTexts: RoleProactivityTexts | undefined
  try {
    const raw = rawScalar(front, 'proactivityTexts')
    if (raw !== undefined) proactivityTexts = validateProactivityTexts(JSON.parse(raw))
  } catch { /* 手写字段无效时沿用联动默认说明。 */ }
  const motionActions = actionNames(scalar(front, 'motionActions')?.split(/[,，]/), false)
  const motionRanges = pickList(scalar(front, 'motionRanges'), MOTION_RANGES)
  const voice = scalar(front, 'voice')?.trim()
  let dynamics: RoleDynamicsConfig | undefined
  let dynamicsError: string | undefined
  const raw = rawScalar(front, 'dynamics')
  if (raw !== undefined) {
    try {
      if ((front.match(/^dynamics[ \t]*:/gm) ?? []).length !== 1) throw new Error('dynamics 重复定义')
      dynamics = validateConfig(JSON.parse(raw))
    } catch (error) { dynamicsError = `动态设定无效：${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    id,
    name: (scalar(front, 'name') ?? id).trim() || id,
    description: (scalar(front, 'description') ?? '').trim(),
    persona,
    ...dynamics === undefined ? {} : { dynamics },
    ...dynamicsError === undefined ? {} : { dynamicsError },
    dynamicsRevision: dynamicsError === undefined ? digest(dynamics ?? null) : digest(raw),
    ...readMemePreferences(front),
    ...isMemeFrequency(memeFrequency) ? { memeFrequency } : {},
    ...isRoleProactivity(proactivity) ? { proactivity } : {},
    ...proactivityTexts === undefined ? {} : { proactivityTexts },
    ...motionActions === undefined ? {} : { motionActions },
    ...motionRanges === undefined ? {} : { motionRanges },
    ...voice !== undefined && VOICE_ID_PATTERN.test(voice) ? { voice } : {},
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

/**
 * 替换 frontmatter 里的一个字段，没有就追加到末尾。值总是加双引号，scalar() 去掉首尾引号后原样还原。
 * 只改这一行，其他字段（用户手写的字段）原样保留。
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
  const prior = existing === undefined ? undefined : parseRole(existing, draft.id)
  if (prior?.dynamicsError !== undefined) throw new TypeError(prior.dynamicsError)
  // splitFrontmatter 的 front 以换行开头、不以换行结尾（取的是两条 --- 之间）。
  let front = existing === undefined ? `\nid: ${draft.id}` : splitFrontmatter(existing).front
  front = setField(front, 'name', draft.name)
  front = setField(front, 'description', draft.description)
  front = draft.memeFrequency === undefined
    ? removeField(front, 'memeFrequency')
    : setField(front, 'memeFrequency', draft.memeFrequency)
  for (const key of ['memePacks', 'memeTags', 'memePrompt', 'proactivityTexts'] as const) {
    const value = draft[key]
    if (value === undefined) front = removeField(front, key)
    else {
      const line = `${key}: ${JSON.stringify(value)}`
      const pattern = new RegExp(`^${key}[ \\t]*:.*$`, 'm')
      front = pattern.test(front) ? front.replace(pattern, () => line) : `${front.replace(/\n+$/, '')}\n${line}`
    }
  }
  front = draft.proactivity === undefined
    ? removeField(front, 'proactivity')
    : setField(front, 'proactivity', draft.proactivity)
  front = draft.motionActions === undefined
    ? removeField(front, 'motionActions')
    : setField(front, 'motionActions', draft.motionActions.join(', '))
  front = draft.motionRanges === undefined
    ? removeField(front, 'motionRanges')
    : setField(front, 'motionRanges', draft.motionRanges.join(', '))
  front = draft.voice === undefined ? removeField(front, 'voice') : setField(front, 'voice', draft.voice)
  if (draft.dynamics === null) front = removeField(front, 'dynamics')
  else if (draft.dynamics !== undefined) {
    const line = `dynamics: ${JSON.stringify(validateConfig(draft.dynamics))}`
    front = /^dynamics[ \t]*:.*$/m.test(front) ? front.replace(/^dynamics[ \t]*:.*$/m, () => line) : `${front.replace(/\n+$/, '')}\n${line}`
  }
  return `---${front}\n---\n\n${draft.persona}\n`
}

export class RoleLibrary {
  private transactions: RoleTransactions | undefined
  private readonly blocked = new Set<string>()
  private readonly writing = new Set<string>()
  get transactional(): boolean { return this.transactions !== undefined }
  useTransactions(transactions: RoleTransactions): void { this.transactions = transactions }
  gate(id: string, blocked: boolean): void { if (blocked) this.blocked.add(id); else this.blocked.delete(id) }
  reserve(id: string, busy: boolean): void { if (busy) this.writing.add(id); else this.writing.delete(id) }
  assertReady(id: string): void { if (this.blocked.has(id) || this.writing.has(id)) throw new Error('角色资料事务尚未完成，请恢复后再试') }
  configuration(id: string): RoleDynamicsConfig | undefined {
    if (this.blocked.has(id)) throw new Error('角色资料事务需要恢复')
    this.reload()
    const role = this.get(id)
    if (role?.dynamicsError) throw new TypeError(role.dynamicsError)
    return role?.dynamics
  }
  fileFor(id: string): string | undefined { this.reload(); return this.files.get(id) }
  /** 预览必须绑定实际字节，包含未知 frontmatter 和手写修改。 */
  contents(): readonly { file: string; text: string }[] { return roleEntries(this.dir).filter(([, file]) => existsSync(file)).map(([, file]) => ({ file, text: readFileSync(file, 'utf8') })) }
  private roles = new Map<string, Role>()
  /** 角色 id → 文件路径。frontmatter 里的 id 可以和文件名不同，写回时按这里找文件。 */
  private files = new Map<string, string>()

  constructor(readonly dir: string, private readonly warn: Warn) {
    FileDataTransaction.recover(dirname(dir), 'role-transactions')
    recoverConfigurationFiles(dir)
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
   * 修改只换 name、description、memeFrequency、proactivity、motionActions、motionRanges、voice 和正文，frontmatter 其他字段保留。新建写成 `<id>/ROLE.md`。
   */
  prepareSave(value: unknown, create: boolean): PreparedRoleSave {
    const draft = validateRoleDraft(value)
    this.reload()
    if (!create && draft.id === undefined) throw new TypeError('缺少角色 id')
    const id = draft.id ?? this.freshId()
    this.assertReady(id)
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
    const current = this.get(id)
    if (current?.dynamicsError) throw new TypeError(current.dynamicsError)
    if (!create && draft.dynamics !== undefined && draft.dynamicsBaseRevision !== current?.dynamicsRevision) throw new Error('动态配置基线已变化，请重新读取角色后保存')
    const text = renderRole({ ...draft, id }, existing)
    return { id, file, text, draft, create, ...existing === undefined ? {} : { existing }, ...current === undefined ? {} : { current } }
  }
  publish(prepared: PreparedRoleSave): Role {
    if ((existsSync(prepared.file) ? readFileSync(prepared.file, 'utf8') : undefined) !== prepared.existing) throw new Error('角色文件已变化，请重新读取后保存')
    this.reload()
    if (this.list().some(role => role.id !== prepared.id && role.name === prepared.draft.name)) throw new Error(`已经有叫"${prepared.draft.name}"的角色，换个名称`)
    writeText(prepared.file, prepared.text)
    this.reload()
    const saved = this.roles.get(prepared.id)
    if (saved === undefined) throw new Error('角色写入后读不出来')
    return saved
  }
  save(value: unknown, create: boolean): Role {
    const prepared = this.prepareSave(value, create)
    const changed = prepared.draft.dynamics !== undefined && (prepared.draft.resetDynamics === true || digest(prepared.current?.dynamics ?? null) !== digest(prepared.draft.dynamics))
    if (changed && !create && (this.transactions || existsSync(join(dirname(this.dir), 'role-dynamics', 'roles', createHash('sha256').update(prepared.id).digest('hex'))))) throw new Error('动态配置保存需要等待角色事务，请使用 saveAsync')
    return this.publish(prepared)
  }
  async saveAsync(value: unknown, create: boolean): Promise<Role> {
    const prepared = this.prepareSave(value, create)
    if (this.transactions) return this.transactions.save(prepared)
    return this.save(value, create)
  }
  removeAsync(id: string, extras: readonly string[] = []): Promise<string> {
    if (!this.transactions) throw new Error('角色回收事务未接入')
    return this.transactions.remove(id, extras)
  }
  restore(stamp: string): Promise<void> {
    if (!this.transactions) throw new Error('角色回收事务未接入')
    return this.transactions.restore(stamp)
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
  remove(id: string, alsoMove?: (trashDir: string, stamp: string) => void, extras: readonly string[] = []): void {
    this.assertReady(id)
    if (this.transactions || existsSync(join(dirname(this.dir), 'role-dynamics', 'roles', createHash('sha256').update(id).digest('hex')))) throw new Error('角色回收需要等待角色事务，请使用 removeAsync')
    this.reload()
    const file = this.files.get(id)
    if (file === undefined) throw new Error('这个角色已经不在角色库里，可能已在文件里删除')
    const source = basename(file) === 'ROLE.md' && dirname(dirname(file)) === this.dir ? dirname(file) : file
    const trash = join(dirname(this.dir), 'roles-trash')
    mkdirSync(trash, { recursive: true })
    const tx = FileDataTransaction.prepare(dirname(this.dir), 'role-transactions', [source, ...extras], { kind: 'static-remove', roleId: id })
    const stamp = tx.manifest.stamp
    try {
      renameWithRetry(source, join(trash, `${stamp}-${basename(source)}`))
      alsoMove?.(trash, stamp)
      tx.commit()
    } catch (error) { if (!tx.committed) tx.rollback(); throw error }
    finally { this.reload() }
  }

  get(id: string): Role | undefined {
    return this.roles.get(id)
  }

  list(): Role[] {
    return [...this.roles.values()]
  }
}
