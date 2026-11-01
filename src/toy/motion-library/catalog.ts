import { parseMotion, tierBudget, TIERS, type MotionConfig, type Tier } from '../core/config.ts'
import { parseLibrary, type MotionClip, type MotionLibrary } from './library.ts'
import { analyzeFeatures } from './analysis.ts'
import { integer, SCRIPT_LIMITS } from './script.ts'
import { previewScript, type MotionPreview, type PreviewOptions } from './preview.ts'

export interface CatalogItem {
  readonly name: string
  readonly description: string
  readonly playback: 'once' | 'loop'
  readonly durationMs: number
}

/** 给模型/界面使用的精简数据目录，不提供点数组、内部 id 或路径。 */
export function queryCatalog(library: MotionLibrary, page: { readonly offset?: number; readonly limit?: number } = {}): readonly CatalogItem[] {
  const offset = integer(page.offset ?? 0, 0, SCRIPT_LIMITS.clips, '目录起点')
  const limit = integer(page.limit ?? 20, 1, 20, '目录数量')
  return parseLibrary(library).clips.slice(offset, offset + limit).map(c => ({
    name: c.name, description: c.description, playback: c.playback, durationMs: analyzeFeatures(c).durationMs,
  }))
}

export const POOL_WEIGHTS = { low: 1, medium: 2, high: 3 } as const
export type PoolWeight = keyof typeof POOL_WEIGHTS

/** 一档的动作池：该档能用的动作及 auto 抽取权重。 */
export type PresetPool = readonly { readonly name: string; readonly weight: PoolWeight }[]

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase()

/** 池里的动作对应的片段；名称不在池里返回 undefined。 */
export function poolClip(library: MotionLibrary, pool: PresetPool, name: string): MotionClip | undefined {
  if (!pool.some(entry => normalize(entry.name) === normalize(name))) return undefined
  return library.clips.find(c => normalize(c.name) === normalize(name))
}

/** 校验一档动作池：至少一个动作，名称在库里且不重复，权重有效。 */
export function checkPool(library: MotionLibrary, pool: unknown, label: string): PresetPool {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error(`${label}动作池至少要有一个动作`)
  if (pool.length > SCRIPT_LIMITS.clips) throw new Error(`${label}动作池数量无效`)
  const seen = new Set<string>()
  return pool.map((value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}动作池格式无效`)
    const { name, weight } = value as Record<string, unknown>
    if (typeof name !== 'string') throw new Error(`${label}动作池名称无效`)
    const clip = library.clips.find(c => normalize(c.name) === normalize(name))
    if (clip === undefined) throw new Error(`${label}动作池里的“${name}”不在动作库中`)
    if (seen.has(clip.id)) throw new Error(`${label}动作池里“${clip.name}”重复`)
    if (typeof weight !== 'string' || !Object.hasOwn(POOL_WEIGHTS, weight)) throw new Error(`${label}动作池权重无效`)
    seen.add(clip.id)
    return { name: clip.name, weight: weight as PoolWeight }
  })
}

/**
 * 从一档动作池选动作：名称在池里时就用它，否则（含 auto）按权重抽一个。
 * 同一个种子总是抽到同一个，气泡、暂停、快调不重新抽。
 */
export function selectAction(library: MotionLibrary, pool: PresetPool, seed: number, name?: string): MotionClip {
  integer(seed, 0, 0xffff_ffff, '随机种子')
  if (name !== undefined) {
    const named = poolClip(library, pool, name)
    if (named !== undefined) return named
  }
  const entries = pool.flatMap(entry => {
    const clip = library.clips.find(c => normalize(c.name) === normalize(entry.name))
    return clip === undefined ? [] : [{ clip, weight: POOL_WEIGHTS[entry.weight] }]
  })
  if (entries.length === 0) throw new Error('该速度档的动作池为空')
  // 独立的确定性散列抽样，不使用共享 PRNG，不随气泡到达次数变化。
  let hash = (seed ^ 0x9e3779b9) >>> 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad) >>> 0
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97) >>> 0
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  let remainder = ((hash ^ (hash >>> 15)) >>> 0) / 0x1_0000_0000 * total
  for (const entry of entries) { remainder -= entry.weight; if (remainder < 0) return entry.clip }
  return entries[entries.length - 1]!.clip
}

/** 保留形状及相对时长；原速只套档位上限，按档变速则匹配该档 nominal 后整体拉伸限速。 */
export function previewPreset(clip: MotionClip, tier: Tier, config: MotionConfig,
  options: Omit<PreviewOptions, 'minPosition' | 'maxPosition' | 'maxSpeed' | 'speedScale'> & { readonly tempo?: 'original' | 'tier' } = {},
): MotionPreview {
  if (!TIERS.includes(tier)) throw new Error('速度档位无效')
  const valid = parseMotion(config)
  const budget = tierBudget(valid, tier)
  const points = clip.points
  // 先通过预览的纯解析边界验证，防止无效点用于峰值计算。
  const original = previewScript(clip, { ...options, closedLoop: clip.playback === 'loop',
    maxDurationMs: options.tempo === 'tier' ? SCRIPT_LIMITS.previewDurationMs : options.maxDurationMs ?? 30000,
    minPosition: valid.minPosition, maxPosition: valid.maxPosition, maxSpeed: budget.max })
  if (options.tempo !== undefined && options.tempo !== 'original' && options.tempo !== 'tier') throw new Error('变速方式无效')
  if (options.tempo !== 'tier') return original
  const width = original.bounds[1] - original.bounds[0]
  let peak = 0
  for (let i = 1; i < points.length; i++) peak = Math.max(peak, Math.abs(points[i]!.pos - points[i - 1]!.pos) * width / 100 * 1000 / (points[i]!.at - points[i - 1]!.at))
  const speedScale = peak === 0 ? 1 : Math.min(4, Math.max(0.25, budget.nominal / peak))
  return previewScript(clip, { ...options, closedLoop: clip.playback === 'loop', minPosition: valid.minPosition, maxPosition: valid.maxPosition, maxSpeed: budget.max, speedScale })
}
