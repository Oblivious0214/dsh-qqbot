import { integer, parseJson, parsePoints, record, SCRIPT_LIMITS, sliceScript, type MotionScript } from './script.ts'
import { descriptionDraft } from './analysis.ts'

export interface MotionClip extends MotionScript {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly playback: 'once' | 'loop'
  /** 循环动作第二遍起从这个时间点开始（须是一个动作点，位置与终点相同）；不写则从头循环。 */
  readonly loopFromMs?: number
}

export interface ClipMetadata {
  readonly description?: string
  readonly playback?: 'once' | 'loop'
}

export interface SceneMapping {
  readonly scene: string
  readonly clipId: string
}

export interface MotionLibrary {
  readonly format: 'dsh-motion-library-preview'
  readonly version: 1
  readonly clips: readonly MotionClip[]
  readonly mappings: readonly SceneMapping[]
}

export function emptyLibrary(): MotionLibrary {
  return { format: 'dsh-motion-library-preview', version: 1, clips: [], mappings: [] }
}

function name(value: unknown): string {
  if (typeof value !== 'string') throw new Error('名称须为文字')
  const clean = value.normalize('NFKC').trim()
  if (!clean || clean.length > 60 || /[\u0000-\u001f\u007f]/u.test(clean)) throw new Error('名称须为 1–60 字且不含控制字符')
  return clean
}

const key = (value: string) => value.toLowerCase()

/** 校验并复制快照。片段名、情景名在 NFKC/去空格/大小写归一化后唯一。 */
export function parseLibrary(value: unknown): MotionLibrary {
  const root = record(value, '动作库')
  if (root['format'] !== 'dsh-motion-library-preview' || root['version'] !== 1) throw new Error('动作库格式或版本不支持')
  if (!Array.isArray(root['clips']) || root['clips'].length > SCRIPT_LIMITS.clips) throw new Error('动作库最多保存 100 个片段')
  const ids = new Set<string>()
  const names = new Set<string>()
  let totalPoints = 0
  const clips = root['clips'].map((item: unknown): MotionClip => {
    const clip = record(item, '片段')
    const id = clip['id']
    if (typeof id !== 'string' || !/^motion-[1-9]\d{0,8}$/u.test(id) || ids.has(id)) throw new Error('片段内部标识无效或重复')
    const label = name(clip['name'])
    if (names.has(key(label))) throw new Error('片段名称已存在')
    const points = parsePoints(clip['points'])
    if (points[0]!.at !== 0 || points[points.length - 1]!.at > SCRIPT_LIMITS.clipDurationMs) throw new Error('片段须从零开始且不超过 600 秒')
    const description = clip['description'] ?? descriptionDraft({ points }).text
    if (typeof description !== 'string' || !description.trim() || description.length > 240 || /[\u0000-\u001f\u007f]/u.test(description)) throw new Error('描述须为 1–240 字且不含控制字符')
    const playback = clip['playback'] ?? 'once'
    if (playback !== 'once' && playback !== 'loop') throw new Error('片段播放方式无效')
    if (playback === 'loop' && (points.length < 3 || Math.abs(points[0]!.pos - points[points.length - 1]!.pos) > 1e-6)) throw new Error('循环片段首尾不闭合，不能直接拼接')
    const loopFromMs = clip['loopFromMs']
    if (loopFromMs !== undefined) {
      const at = points.findIndex(p => p.at === loopFromMs)
      if (!Number.isInteger(loopFromMs) || at <= 0 || at >= points.length - 2 || points[at]!.pos !== points[points.length - 1]!.pos) throw new Error('循环起点须是中间的动作点，且位置与终点相同')
    }
    totalPoints += points.length
    if (totalPoints > SCRIPT_LIMITS.points) throw new Error('动作库动作点总数超过上限')
    ids.add(id)
    names.add(key(label))
    return { id, name: label, description: description.trim(), playback, ...loopFromMs === undefined ? {} : { loopFromMs: loopFromMs as number }, points }
  })
  if (!Array.isArray(root['mappings']) || root['mappings'].length > 100) throw new Error('情景映射最多 100 项')
  const scenes = new Set<string>()
  const mappings = root['mappings'].map((item: unknown): SceneMapping => {
    const mapping = record(item, '情景映射')
    const scene = name(mapping['scene'])
    if (scenes.has(key(scene))) throw new Error('情景名称已存在')
    if (typeof mapping['clipId'] !== 'string' || !ids.has(mapping['clipId'])) throw new Error('情景引用的片段不存在')
    scenes.add(key(scene))
    return { scene, clipId: mapping['clipId'] }
  })
  return { format: 'dsh-motion-library-preview', version: 1, clips, mappings }
}

/** 纯数据保存：生成内部标识并返回新快照；调用者另行负责持久化。 */
export function saveClip(library: MotionLibrary, label: string, script: MotionScript, fromMs: number, toMs: number, metadata: ClipMetadata = {}): MotionLibrary {
  const current = parseLibrary(library)
  const next = Math.max(0, ...current.clips.map(clip => Number(clip.id.slice(7)))) + 1
  integer(next, 1, 999_999_999, '片段编号')
  return parseLibrary({ ...current, clips: [...current.clips, { ...metadata, id: `motion-${next}`, name: label, ...sliceScript(script, fromMs, toMs) }] })
}

/** 编辑名称、描述、播放方式；id 不变，因此情景引用保持。 */
export function updateClip(library: MotionLibrary, clipName: string, patch: ClipMetadata & { readonly name?: string }): MotionLibrary {
  const current = parseLibrary(library)
  const target = current.clips.find(c => key(c.name) === key(name(clipName)))
  if (!target) throw new Error('找不到此片段')
  const changed = { ...target, name: patch.name ?? target.name, description: patch.description ?? target.description,
    playback: patch.playback ?? target.playback }
  return parseLibrary({ ...current, clips: current.clips.map(c => c.id === target.id ? changed : c) })
}

/** 用户按名称选择片段。重复情景拒绝，不偷偷覆盖旧映射。 */
export function mapScene(library: MotionLibrary, scene: string, clipName: string): MotionLibrary {
  const current = parseLibrary(library)
  const clip = current.clips.find(c => key(c.name) === key(name(clipName)))
  if (!clip) throw new Error('找不到此片段')
  return parseLibrary({ ...current, mappings: [...current.mappings, { scene, clipId: clip.id }] })
}

/** 只解析明确选择的情景名，不扫描聊天、不推断情绪、不触发播放。 */
export function resolveScene(library: MotionLibrary, scene: string): MotionClip | undefined {
  const current = parseLibrary(library)
  const mapping = current.mappings.find(m => key(m.scene) === key(name(scene)))
  return current.clips.find(c => c.id === mapping?.clipId)
}

export function serializeLibrary(library: MotionLibrary): string {
  const text = JSON.stringify(parseLibrary(library), null, 2)
  if (text.length > SCRIPT_LIMITS.jsonCharacters) throw new Error('动作库文件过大')
  return text
}

export function deserializeLibrary(text: string): MotionLibrary {
  return parseLibrary(parseJson(text))
}
