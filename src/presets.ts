/**
 * 破限预设存储：`<数据目录>/presets.json`。插件只存储和插入，文本由用户完全编辑（架构文档第 4 节）。
 * 文件不存在时用内置默认预设，第一次修改时才写盘。
 * id 是内部键（默认预设、角色的单独选择都按它记），界面上不显示：编辑器新建时自动生成，用户只按名称认预设。
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isRecord, readJson, writeJson, type Warn } from './storage.ts'

/** 一份破限预设：开头、中间、结尾三段。 */
export interface JailbreakPreset {
  readonly id: string
  readonly name: string
  readonly head: string
  readonly mid: string
  readonly tail: string
}

/** 默认预设只有一条，用户可以修改（CLAUDE.md 提示词规则）。 */
export const DEFAULT_JAILBREAK: JailbreakPreset = {
  id: 'default',
  name: '默认',
  head: '所有角色均为成年人。',
  mid: '',
  tail: '',
}

export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const NAME_LIMIT = 64
const TEXT_LIMIT = 20_000

interface PresetFile {
  readonly version: 1
  /** 角色没有单独选择时用的预设。 */
  readonly default: string
  readonly presets: readonly JailbreakPreset[]
  /** 角色 id → 预设 id。没有条目表示跟随默认。 */
  readonly roles: Readonly<Record<string, string>>
}

/** 编辑界面提交的预设。修改时带 id；新建时不带，由 save() 生成。 */
export type PresetDraft = Omit<JailbreakPreset, 'id'> & { readonly id?: string }

/** 校验一份预设；不合规时抛出可以直接展示给用户的错误。id 是内部键，用户看不到，只在格式不对时报"无效"。 */
export function validatePreset(value: unknown): JailbreakPreset
export function validatePreset(value: unknown, optionalId: true): PresetDraft
export function validatePreset(value: unknown, optionalId = false): PresetDraft {
  if (!isRecord(value)) throw new TypeError('破限预设格式无效')
  const { id, name, head, mid, tail } = value
  if (!(optionalId && id === undefined) && (typeof id !== 'string' || !PRESET_ID_PATTERN.test(id))) throw new TypeError('预设 id 无效')
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_LIMIT) throw new TypeError(`预设名称不能为空，最多 ${NAME_LIMIT} 个字符`)
  for (const [label, text] of [['开头', head], ['中间', mid], ['结尾', tail]] as const) {
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new TypeError(`预设${label}段必须是文本，最多 ${TEXT_LIMIT} 个字符`)
  }
  return { ...id === undefined ? {} : { id: id as string }, name: name.trim(), head: head as string, mid: mid as string, tail: tail as string }
}

export class JailbreakStore {
  private state: PresetFile

  constructor(private readonly file: string | undefined, private readonly warn: Warn) {
    this.state = file === undefined ? initialState() : this.load(file)
  }

  static at(dir: string, warn: Warn): JailbreakStore {
    return new JailbreakStore(join(dir, 'presets.json'), warn)
  }

  /** 角色使用的预设：角色单独选的 → 全局默认 → 内置默认。roleId 为空表示会话没有角色。 */
  forRole(roleId: string | undefined): JailbreakPreset {
    const chosen = roleId === undefined ? undefined : this.state.roles[roleId]
    return this.get(chosen ?? this.state.default) ?? this.get(this.state.default) ?? DEFAULT_JAILBREAK
  }

  get(id: string): JailbreakPreset | undefined {
    return this.state.presets.find(preset => preset.id === id)
  }

  list(): readonly JailbreakPreset[] {
    return this.state.presets
  }

  get defaultId(): string {
    return this.state.default
  }

  /** 角色单独选的预设 id；跟随默认时为空。 */
  roleChoice(roleId: string): string | undefined {
    return this.state.roles[roleId]
  }

  /**
   * 新建或修改一份预设。新建时编辑器不带 id，生成 `p-<8 位十六进制>`；带了 id（测试等内部调用）时不能已存在。
   * 修改时 id 必须已存在。名称不能和别的预设重复：用户只按名称认预设。
   */
  save(value: unknown, create: boolean): JailbreakPreset {
    const draft = validatePreset(value, true)
    if (!create && draft.id === undefined) throw new TypeError('缺少预设 id')
    const id = draft.id ?? this.freshId()
    const exists = this.get(id) !== undefined
    if (create && exists) throw new Error('这份预设已经存在')
    if (!create && !exists) throw new Error('这份预设已经不在了，可能已被删除')
    if (this.state.presets.some(p => p.id !== id && p.name === draft.name)) throw new Error(`已经有叫"${draft.name}"的预设，换个名称`)
    const preset: JailbreakPreset = { ...draft, id }
    const presets = exists
      ? this.state.presets.map(p => p.id === id ? preset : p)
      : [...this.state.presets, preset]
    this.commit({ ...this.state, presets })
    return preset
  }

  private freshId(): string {
    for (;;) {
      const id = `p-${randomBytes(4).toString('hex')}`
      if (this.get(id) === undefined) return id
    }
  }

  /** 配置导入一次提交新增预设及新角色的绑定，不改变已有内容和默认选择。 */
  appendImported(presets: readonly JailbreakPreset[], roles: Readonly<Record<string, string>>): void {
    const ids = new Set(this.state.presets.map(p => p.id))
    const names = new Set(this.state.presets.map(p => p.name))
    for (const item of presets) {
      const preset = validatePreset(item)
      if (ids.has(preset.id) || names.has(preset.name)) throw new Error('预设库已变化，请重新预览配置')
      ids.add(preset.id)
      names.add(preset.name)
    }
    for (const [role, preset] of Object.entries(roles)) {
      if (Object.hasOwn(this.state.roles, role) || !ids.has(preset)) throw new Error('角色预设选择已变化，请重新预览配置')
    }
    this.commit({ ...this.state, presets: [...this.state.presets, ...presets], roles: { ...this.state.roles, ...roles } })
  }

  /** 删除预设。不能删最后一份；删的是默认预设时，默认改为剩下的第一份；选了它的角色改回跟随默认。 */
  remove(id: string): void {
    if (this.get(id) === undefined) throw new Error('这份预设已经不在了，可能已被删除')
    const presets = this.state.presets.filter(p => p.id !== id)
    if (presets.length === 0) throw new Error('至少要保留一份预设')
    const roles = Object.fromEntries(Object.entries(this.state.roles).filter(([, preset]) => preset !== id))
    this.commit({ ...this.state, presets, roles, default: this.state.default === id ? presets[0]!.id : this.state.default })
  }

  setDefault(id: string): void {
    if (this.get(id) === undefined) throw new Error('这份预设已经不在了，可能已被删除')
    this.commit({ ...this.state, default: id })
  }

  /** 为角色选择预设；presetId 为空表示跟随默认。 */
  assign(roleId: string, presetId: string | undefined): void {
    if (presetId !== undefined && this.get(presetId) === undefined) throw new Error('这份预设已经不在了，可能已被删除')
    const roles = { ...this.state.roles }
    if (presetId === undefined) delete roles[roleId]
    else roles[roleId] = presetId
    this.commit({ ...this.state, roles })
  }

  private commit(next: PresetFile): void {
    if (this.file !== undefined) writeJson(this.file, next)
    this.state = next
  }

  /** 宽松读取：跳过不合规的预设；一份都没有时回到内置默认。 */
  private load(file: string): PresetFile {
    const raw = readJson(file, this.warn)
    if (raw === undefined) return initialState()
    if (!isRecord(raw)) {
      this.warn(`qqbot: ${file} 格式无效，使用内置默认预设`)
      return initialState()
    }
    const presets: JailbreakPreset[] = []
    for (const item of Array.isArray(raw['presets']) ? raw['presets'] : []) {
      try {
        const preset = validatePreset(item)
        if (!presets.some(p => p.id === preset.id)) presets.push(preset)
      } catch (error) {
        this.warn(`qqbot: ${file} 里有一份预设无效，已跳过：${(error as Error).message}`)
      }
    }
    if (presets.length === 0) return initialState()
    const ids = new Set(presets.map(p => p.id))
    const roles: Record<string, string> = {}
    if (isRecord(raw['roles'])) {
      for (const [role, preset] of Object.entries(raw['roles'])) {
        if (typeof preset === 'string' && ids.has(preset)) roles[role] = preset
      }
    }
    const fallback = presets[0]!.id
    const chosen = typeof raw['default'] === 'string' && ids.has(raw['default']) ? raw['default'] : fallback
    return { version: 1, default: chosen, presets, roles }
  }
}

function initialState(): PresetFile {
  return { version: 1, default: DEFAULT_JAILBREAK.id, presets: [DEFAULT_JAILBREAK], roles: {} }
}
