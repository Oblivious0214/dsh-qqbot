import { TIERS, type Tier } from '../core/config.ts'
import { AUTO_ACTION } from '../core/intent.ts'
import { checkPool, type PresetPool } from './catalog.ts'
import { parseLibrary, type MotionLibrary } from './library.ts'
import { integer, record } from './script.ts'

export interface ActionLibrary {
  readonly revision: number
  readonly library: MotionLibrary
  readonly pools: Readonly<Record<Tier, PresetPool>>
  /** 未单独配置时，高潮沿用当前可用速度档的动作池。 */
  readonly burstPool?: PresetPool
  /** 未单独配置时，温存沿用当前最低可用速度档的动作池。 */
  readonly aftercarePool?: PresetPool
}

const TIER_NAMES: Record<Tier, string> = { low: '低速', medium: '中速', high: '高速' }

/** 一次提交整个动作库和引用，重命名、删除不会留下半份有效的配置。 */
export function parseActionLibrary(value: unknown): ActionLibrary {
  const raw = record(value, '动作库设置')
  const revision = integer(raw['revision'], 0, Number.MAX_SAFE_INTEGER - 1, '动作库版本')
  const library = parseLibrary(raw['library'])
  if (library.clips.some(c => c.name.toLowerCase() === AUTO_ACTION)) throw new Error('auto 用于自动选择，请换一个动作名称')
  const pools = record(raw['pools'], '三档动作池')
  const parsed = {} as Record<Tier, PresetPool>
  for (const tier of TIERS) parsed[tier] = checkPool(library, pools[tier], TIER_NAMES[tier])
  return { revision, library, pools: parsed,
    ...(raw['burstPool'] === undefined ? {} : { burstPool: checkPool(library, raw['burstPool'], '高潮') }),
    ...(raw['aftercarePool'] === undefined ? {} : { aftercarePool: checkPool(library, raw['aftercarePool'], '温存') }) }
}

/**
 * 可选动作：每个动作一行“名称：描述”，不是三档都能用的在后面标“（仅 low、medium）”。
 * 每档只取池里前 40 项，超出的名称在该档视为不可用。权重、轨迹、内部标识和随机状态留在程序里。
 */
export function presetRuntime(config: ActionLibrary): string {
  const names = TIERS.map(tier => config.pools[tier].map(entry => entry.name).slice(0, 40))
  return [...new Set(names.flat())].flatMap(name => {
    const clip = config.library.clips.find(c => c.name === name)
    if (clip === undefined) return []
    const tiers = TIERS.filter((_, i) => names[i]!.includes(name))
    const only = tiers.length === TIERS.length ? '' : `（仅 ${tiers.join('、')}）`
    return [`${clip.name}：${clip.description.slice(0, 120)}${only}`]
  }).join('\n')
}
