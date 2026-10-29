/**
 * 破限预设存储：`<数据目录>/presets.json`。插件只存储和插入，文本由用户完全编辑（架构文档第 4 节）。
 * 文件不存在时用内置默认预设，第一次修改时才写盘。
 */

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

/** 校验一份预设；不合规时抛出可以直接展示给用户的错误。 */
export function validatePreset(value: unknown): JailbreakPreset {
  if (!isRecord(value)) throw new TypeError('破限预设格式无效')
  const { id, name, head, mid, tail } = value
  if (typeof id !== 'string' || !PRESET_ID_PATTERN.test(id)) throw new TypeError('预设 id 只能用小写字母、数字和连字符，最多 64 个字符')
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_LIMIT) throw new TypeError(`预设名称不能为空，最多 ${NAME_LIMIT} 个字符`)
  for (const [label, text] of [['开头', head], ['中间', mid], ['结尾', tail]] as const) {
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new TypeError(`预设${label}段必须是文本，最多 ${TEXT_LIMIT} 个字符`)
  }
  return { id, name: name.trim(), head: head as string, mid: mid as string, tail: tail as string }
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

  /** 新建或覆盖一份预设。 */
  save(value: unknown): JailbreakPreset {
    const preset = validatePreset(value)
    const presets = this.state.presets.some(p => p.id === preset.id)
      ? this.state.presets.map(p => p.id === preset.id ? preset : p)
      : [...this.state.presets, preset]
    this.commit({ ...this.state, presets })
    return preset
  }

  /** 删除预设。不能删最后一份；删的是默认预设时，默认改为剩下的第一份；选了它的角色改回跟随默认。 */
  remove(id: string): void {
    if (this.get(id) === undefined) throw new Error(`没有 id 为 "${id}" 的预设`)
    const presets = this.state.presets.filter(p => p.id !== id)
    if (presets.length === 0) throw new Error('至少要保留一份预设')
    const roles = Object.fromEntries(Object.entries(this.state.roles).filter(([, preset]) => preset !== id))
    this.commit({ ...this.state, presets, roles, default: this.state.default === id ? presets[0]!.id : this.state.default })
  }

  setDefault(id: string): void {
    if (this.get(id) === undefined) throw new Error(`没有 id 为 "${id}" 的预设`)
    this.commit({ ...this.state, default: id })
  }

  /** 为角色选择预设；presetId 为空表示跟随默认。 */
  assign(roleId: string, presetId: string | undefined): void {
    if (presetId !== undefined && this.get(presetId) === undefined) throw new Error(`没有 id 为 "${presetId}" 的预设`)
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
