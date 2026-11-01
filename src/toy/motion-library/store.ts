import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { writeJson, type Warn } from '../storage.ts'
import { defaultActionLibrary } from './builtins.ts'
import { parseActionLibrary, type ActionLibrary } from './config.ts'
import { parseFunscript, parseJson, record, SCRIPT_LIMITS, serializeFunscript } from './script.ts'

const FORMAT = 'dsh-motion-library-files'
const TRACK_NAME = /^[a-f0-9]{64}\.funscript$/u
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

interface StoredLibrary {
  readonly format: typeof FORMAT
  readonly version: 1
  readonly revision: number
  readonly library: {
    readonly format: 'dsh-motion-library-preview'
    readonly version: 1
    readonly clips: readonly { readonly file: string; readonly [key: string]: unknown }[]
    readonly mappings: ActionLibrary['library']['mappings']
  }
  readonly pools: ActionLibrary['pools']
  readonly burstPool?: ActionLibrary['burstPool']
  readonly aftercarePool?: ActionLibrary['aftercarePool']
}

/** 单个配置索引原子切换；轨迹按内容生成文件名且写入后不再修改。 */
export class ActionLibraryStore {
  private current: ActionLibrary
  private diskText: string | undefined
  private lastGood: unknown
  private loadFailed = false
  private readonly tracks: string

  constructor(private readonly file: string, private readonly warn: Warn) {
    this.tracks = join(dirname(file), 'motion-scripts')
    this.current = defaultActionLibrary()
    try {
      this.diskText = this.readIndex(file)
      if (this.diskText === undefined) {
        if (existsSync(`${file}.bak`)) throw new Error('动作库索引缺失')
        return
      }
      const raw = parseJson(this.diskText)
      this.current = this.decode(raw)
      this.lastGood = raw
    } catch (error) {
      this.warn(`动作库读取失败，尝试上一份备份：${String(error)}`)
      this.recover()
    }
  }

  static at(dir: string, warn: Warn): ActionLibraryStore { return new ActionLibraryStore(join(dir, 'motion-library.json'), warn) }
  get value(): ActionLibrary { return structuredClone(this.current) }

  /** 全部清理由宿主先删除 toy 数据域，再重新写入内置库。 */
  reset(): void {
    this.diskText = this.readIndex(this.file)
    this.lastGood = undefined
    this.loadFailed = false
    this.commit({ ...defaultActionLibrary(), revision: this.current.revision + 1 })
  }

  save(value: unknown): ActionLibrary {
    if (this.loadFailed) throw new Error('动作库及备份无法读取，原文件已保留，请先恢复文件或清理全部数据。')
    const next = parseActionLibrary(value)
    if (next.revision !== this.current.revision || this.readIndex(this.file) !== this.diskText) {
      throw new Error('动作库已在其他页面更新，请重新打开后编辑')
    }
    return this.commit({ ...next, revision: next.revision + 1 })
  }

  private readIndex(file: string): string | undefined {
    try {
      if (statSync(file).size > SCRIPT_LIMITS.jsonCharacters * 4) throw new Error('动作库文件过大')
      return readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private decode(value: unknown): ActionLibrary {
    const raw = record(value, '动作库')
    if (raw['format'] !== FORMAT || raw['version'] !== 1) throw new Error('动作库存储版本无效')
    const library = record(raw['library'], '动作目录')
    if (!Array.isArray(library['clips']) || library['clips'].length > SCRIPT_LIMITS.clips) throw new Error('动作目录数量无效')
    const clips = library['clips'].map((item: unknown) => {
      const clip = record(item, '动作配置')
      const file = clip['file']
      if (typeof file !== 'string' || !TRACK_NAME.test(file)) throw new Error('轨迹文件引用无效')
      if ('points' in clip || 'actions' in clip) throw new Error('动作配置不能内嵌轨迹')
      const path = join(this.tracks, file)
      if (statSync(path).size > SCRIPT_LIMITS.jsonCharacters * 4) throw new Error('轨迹文件过大')
      const text = readFileSync(path, 'utf8')
      if (`${digest(text)}.funscript` !== file) throw new Error('轨迹文件校验失败')
      return { ...clip, ...parseFunscript(text) }
    })
    return parseActionLibrary({ revision: raw['revision'], library: { ...library, clips }, pools: raw['pools'], burstPool: raw['burstPool'], aftercarePool: raw['aftercarePool'] })
  }

  private recover(): void {
    try {
      const text = this.readIndex(`${this.file}.bak`)
      if (text === undefined) throw new Error('没有可用备份')
      const raw = parseJson(text)
      const restored = this.decode(raw)
      if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.corrupt-${randomUUID()}`)
      // 备份仍保留；仅在所有轨迹和配置通过校验后切换当前索引。
      this.diskText = this.readIndex(this.file)
      this.lastGood = raw
      this.commit(restored)
      this.warn('动作库已从上一份备份恢复。')
    } catch (error) {
      this.loadFailed = true
      this.warn(`动作库备份恢复失败，原文件保留：${String(error)}`)
    }
  }

  private commit(value: ActionLibrary): ActionLibrary {
    const parsed = parseActionLibrary(value)
    mkdirSync(this.tracks, { recursive: true })
    const clips = parsed.library.clips.map(({ points, ...metadata }) => {
      const text = serializeFunscript({ points })
      const file = `${digest(text)}.funscript`
      const path = join(this.tracks, file)
      if (existsSync(path)) {
        if (readFileSync(path, 'utf8') !== text) throw new Error('已有轨迹文件校验失败')
      } else {
        // writeJson 使用同一排版和临时文件改名，写出后再核对字节。
        writeJson(path, JSON.parse(text))
        if (readFileSync(path, 'utf8') !== text) throw new Error('轨迹写入核对失败')
      }
      return { ...metadata, file }
    })
    const stored: StoredLibrary = { format: FORMAT, version: 1, revision: parsed.revision,
      library: { ...parsed.library, clips }, pools: parsed.pools,
      ...(parsed.burstPool === undefined ? {} : { burstPool: parsed.burstPool }),
      ...(parsed.aftercarePool === undefined ? {} : { aftercarePool: parsed.aftercarePool }) }
    if (this.lastGood !== undefined) writeJson(`${this.file}.bak`, this.lastGood)
    writeJson(this.file, stored)
    this.diskText = `${JSON.stringify(stored, null, 2)}\n`
    this.lastGood = stored
    this.current = parsed
    // 索引提交成功后的清理失败不把已完成的保存报告为失败。
    try { this.collectTracks(stored) } catch (error) { this.warn(`动作库旧轨迹清理未完成：${String(error)}`) }
    return this.value
  }

  private collectTracks(current: StoredLibrary): void {
    // 损坏索引保留期间也保留现场轨迹，方便手动恢复。
    if (readdirSync(dirname(this.file)).some(name => name.startsWith(`${basename(this.file)}.corrupt-`))) return
    const keep = new Set(current.library.clips.map(clip => clip.file))
    const backup = this.readIndex(`${this.file}.bak`)
    if (backup !== undefined) {
      const raw = record(parseJson(backup), '动作备份')
      if (raw['format'] === FORMAT) {
        const library = record(raw['library'], '动作备份目录')
        if (!Array.isArray(library['clips'])) throw new Error('动作备份目录无效')
        for (const value of library['clips']) {
          const file = record(value, '动作备份')['file']
          if (typeof file !== 'string' || !TRACK_NAME.test(file)) throw new Error('动作备份引用无效')
          keep.add(file)
        }
      }
    }
    for (const file of readdirSync(this.tracks)) {
      if (TRACK_NAME.test(file) && !keep.has(file)) unlinkSync(join(this.tracks, file))
    }
  }
}
