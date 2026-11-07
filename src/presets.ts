/**
 * 破限预设存储：`<数据目录>/presets.json`。插件只存储和插入，文本由用户完全编辑（架构文档第 4 节）。
 * 文件不存在时用内置默认预设，第一次修改时才写盘。
 * id 是内部键（当前预设按它记），界面上不显示：编辑器新建时自动生成，用户只按名称认预设。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_PRESET_HEAD } from './default-content.ts'
import { isRecord, writeJson, type Warn } from './storage.ts'

/** 一份破限预设：开头、中间、结尾三段。 */
export interface JailbreakPreset {
  readonly id: string
  readonly name: string
  readonly head: string
  readonly mid: string
  readonly tail: string
}

/** 默认预设使用用户提供的通用规范，仍可在编辑器里修改。 */
export const DEFAULT_JAILBREAK: JailbreakPreset = {
  id: 'default',
  name: '默认',
  head: DEFAULT_PRESET_HEAD,
  mid: '',
  tail: '',
}

export { PRESET_ID_PATTERN, validatePreset, type PresetDraft } from './preset-validation.ts'
import { validatePreset } from './preset-validation.ts'
export interface PresetFile {
  readonly version: 2
  readonly current: string
  readonly presets: readonly JailbreakPreset[]
}

/** Strict validation also guards migration: damaged libraries remain untouched. */
function parseState(raw: unknown): PresetFile {
  if (!isRecord(raw) || ![1, 2].includes(raw['version'] as number) || !Array.isArray(raw['presets'])) throw new Error('预设文件格式无效')
  const legacy = raw['version'] === 1
  const allowed = legacy ? ['version', 'default', 'presets', 'roles'] : ['version', 'current', 'presets']
  if (Object.keys(raw).some(key => !allowed.includes(key)) || (legacy && !isRecord(raw['roles']))) throw new Error('预设文件格式无效')
  const presets = raw['presets'].map(item => validatePreset(item))
  const ids = new Set(presets.map(p => p.id)), current = raw[legacy ? 'default' : 'current']
  if (!presets.length || ids.size !== presets.length || new Set(presets.map(p => p.name)).size !== presets.length
    || typeof current !== 'string' || !ids.has(current)) throw new Error('预设文件内容无效')
  if (!isDeepStrictEqual(raw['presets'], presets)) throw new Error('预设文件内容无效')
  return { version: 2, current, presets }
}

export class JailbreakStore {
  private state: PresetFile
  private commits = 0
  get commitRevision(): number { return this.commits }
  private loadedDisk: string | undefined

  constructor(private readonly file: string | undefined, private readonly warn: Warn) {
    this.state = file === undefined ? initialState() : this.load(file)
    this.loadedDisk = this.diskText()
  }

  /** 清理后读取新的初始预设。 */
  reload(): void { this.state = this.file === undefined ? initialState() : this.load(this.file); this.loadedDisk = this.diskText() }

  private diskText(): string | undefined { return this.file !== undefined && existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined }

  /** Import must compare the complete real file and current choice.
   * Invalid/deleted files never become a writable default through permissive load. */
  importBaseline(): { state: PresetFile; disk: string | null } {
    const disk = this.diskText()
    if (disk === undefined) {
      // Earlier versions moved malformed originals here. This evidence survives reload/reconstruction.
      if (this.file !== undefined && existsSync(`${this.file}.corrupt`)) throw new Error('预设文件损坏，请恢复有效文件后重新预览')
      if (this.loadedDisk !== undefined) throw new Error('预设文件已删除，请恢复文件后重新预览')
      return { state: this.snapshot(), disk: null }
    }
    let raw: unknown
    try { raw = JSON.parse(disk) } catch { throw new Error('预设文件损坏，请检查文件后重新预览') }
    let state: PresetFile
    try {
      if (!isRecord(raw) || raw['version'] !== 2) throw new Error()
      state = parseState(raw)
    } catch { throw new Error('预设文件内容无效，请检查文件后重新预览') }
    if (disk !== this.loadedDisk || !isDeepStrictEqual(state, this.state)) {
      this.state = structuredClone(state); this.loadedDisk = disk
      throw new Error('磁盘预设已变化，请重新预览后导入')
    }
    return { state: this.snapshot(), disk }
  }

  static at(dir: string, warn: Warn): JailbreakStore {
    return new JailbreakStore(join(dir, 'presets.json'), warn)
  }

  /** 全部 QQ 会话共用同一份当前预设。 */
  current(): JailbreakPreset { return this.get(this.state.current) ?? DEFAULT_JAILBREAK }

  get(id: string): JailbreakPreset | undefined {
    return this.state.presets.find(preset => preset.id === id)
  }

  list(): readonly JailbreakPreset[] {
    return this.state.presets
  }

  /** 完整副本，包含当前选择和全部预设；调用者不能修改存储状态。 */
  snapshot(): PresetFile { return structuredClone(this.state) }

  get currentId(): string { return this.state.current }

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

  /** 配置导入一次提交新增预设，不改变已有内容和当前选择。 */
  appendImported(presets: readonly JailbreakPreset[]): void {
    const ids = new Set(this.state.presets.map(p => p.id))
    const names = new Set(this.state.presets.map(p => p.name))
    for (const item of presets) {
      const preset = validatePreset(item)
      if (ids.has(preset.id) || names.has(preset.name)) throw new Error('预设库已变化，请重新预览配置')
      ids.add(preset.id)
      names.add(preset.name)
    }
    this.commit({ ...this.state, presets: [...this.state.presets, ...presets] })
  }

  /** 删除预设。不能删最后一份；删的是当前预设时，改为剩下的第一份。 */
  remove(id: string): void {
    if (this.get(id) === undefined) throw new Error('这份预设已经不在了，可能已被删除')
    const presets = this.state.presets.filter(p => p.id !== id)
    if (presets.length === 0) throw new Error('至少要保留一份预设')
    this.commit({ ...this.state, presets, current: this.state.current === id ? presets[0]!.id : this.state.current })
  }

  setCurrent(id: string): void {
    if (this.get(id) === undefined) throw new Error('这份预设已经不在了，可能已被删除')
    this.commit({ ...this.state, current: id })
  }

  private commit(next: PresetFile): void {
    if (this.file !== undefined) writeJson(this.file, next)
    this.state = next
    this.commits++
    this.loadedDisk = this.diskText()
  }

  /** 无效文件保留证据并显示内置默认；有效 v1 原子迁移。 */
  private load(file: string): PresetFile {
    // Keep malformed bytes in place: permissive display must not erase strict import evidence
    // or overwrite a prior .corrupt original on a later load.
    let text: string
    try { text = readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`qqbot: 读不了 ${file}：${String(error)}`)
      return initialState()
    }
    let raw: unknown
    try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch {
      this.warn(`qqbot: ${file} 不是有效的 JSON，保留原文件并使用内置默认预设`)
      return initialState()
    }
    try {
      const state = parseState(raw)
      if (isRecord(raw) && raw['version'] === 1) {
        const backup = `${file}.pre-v2`
        // Exclusive creation: the first original is retained across retries/restarts.
        try { writeFileSync(backup, readFileSync(file), { flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(backup).isFile()) throw error }
        writeJson(file, state)
      }
      return state
    } catch (error) {
      this.warn(`qqbot: ${file} 无效或迁移失败，保留原文件并使用内置默认预设：${String(error)}`)
      return initialState()
    }
  }
}

function initialState(): PresetFile {
  return { version: 2, current: DEFAULT_JAILBREAK.id, presets: [DEFAULT_JAILBREAK] }
}
