/** 独立编写的有限脚本数据解析器；不读取路径、不执行脚本、不触碰设备。 */
export interface MotionPoint {
  readonly at: number
  readonly pos: number
}

export interface MotionScript {
  readonly points: readonly MotionPoint[]
}

export const SCRIPT_LIMITS = {
  jsonCharacters: 2_000_000,
  points: 20_000,
  sourceDurationMs: 3_600_000,
  clipDurationMs: 600_000,
  previewDurationMs: 3_600_000,
  clips: 100,
} as const

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为对象`)
  return value as Record<string, unknown>
}

export function finite(value: unknown, low: number, high: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
    throw new Error(`${label}须在 ${low}–${high} 之间`)
  }
  return value
}

export function integer(value: unknown, low: number, high: number, label: string): number {
  const n = finite(value, low, high, label)
  if (!Number.isSafeInteger(n)) throw new Error(`${label}须为整数`)
  return n
}

export function parseJson(text: string): unknown {
  if (typeof text !== 'string' || text.length > SCRIPT_LIMITS.jsonCharacters) throw new Error('脚本文件过大或不是文本')
  try { return JSON.parse(text.replace(/^\uFEFF/u, '')) as unknown } catch { throw new Error('脚本不是有效 JSON') }
}

/** 严格拒绝乱序、重复时间、非有限数字及越界位置，不静默排序或丢弃坏点。 */
export function parsePoints(value: unknown): MotionPoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > SCRIPT_LIMITS.points) {
    throw new Error(`动作点数量须为 2–${SCRIPT_LIMITS.points}`)
  }
  let previous = -1
  return value.map((item: unknown, index) => {
    const point = record(item, `动作点 ${index + 1}`)
    const at = integer(point['at'], 0, SCRIPT_LIMITS.sourceDurationMs, '时间')
    const pos = finite(point['pos'], 0, 100, '位置')
    if (at <= previous) throw new Error('动作点时间须严格递增，不能重复')
    previous = at
    return { at, pos }
  })
}

/** 仅支持单轴 actions/at/pos 子集；其他元信息丢弃，未知版本和多轴扩展拒绝。 */
export function parseFunscript(text: string): MotionScript {
  const root = record(parseJson(text), '脚本')
  if (root['version'] !== undefined && root['version'] !== '1.0') throw new Error('暂不支持此脚本版本')
  if (root['axes'] !== undefined || root['scripts'] !== undefined) throw new Error('暂不支持多轴脚本')
  if (root['inverted'] !== undefined && typeof root['inverted'] !== 'boolean') throw new Error('反向标记须为布尔值')
  const points = parsePoints(root['actions'])
  return { points: root['inverted'] === true ? points.map(p => ({ at: p.at, pos: 100 - p.pos })) : points }
}

/** 轨迹落盘只保存单轴标准字段，名称、分组及播放配置由库索引保存。 */
export function serializeFunscript(script: MotionScript): string {
  return `${JSON.stringify({ version: '1.0', actions: parsePoints(script.points) }, null, 2)}\n`
}

/** 截取闭区间，边界按线性插值补点，片段从零开始，保留中间点及停留。 */
export function sliceScript(script: MotionScript, fromMs: number, toMs: number): MotionScript {
  const points = parsePoints(script.points)
  const first = points[0]!
  const last = points[points.length - 1]!
  integer(fromMs, first.at, last.at, '片段起点')
  integer(toMs, first.at, last.at, '片段终点')
  if (toMs <= fromMs || toMs - fromMs > SCRIPT_LIMITS.clipDurationMs) throw new Error('片段须大于零且不超过 600 秒')
  const positionAt = (at: number): number => {
    const i = points.findIndex(p => p.at >= at)
    const right = points[i]!
    if (right.at === at) return right.pos
    const left = points[i - 1]!
    return left.pos + (right.pos - left.pos) * (at - left.at) / (right.at - left.at)
  }
  const selected = [
    { at: 0, pos: positionAt(fromMs) },
    ...points.filter(p => p.at > fromMs && p.at < toMs).map(p => ({ at: p.at - fromMs, pos: p.pos })),
    { at: toMs - fromMs, pos: positionAt(toMs) },
  ]
  return { points: parsePoints(selected) }
}
