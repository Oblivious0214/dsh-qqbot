/** 内置动作的名称、描述、生成轨迹和默认动作池。转换和核对脚本共用。 */

/** 与基础动作重复的旧轨迹改名沿用：标准往复即稳定节奏，匀速全抽即滑动。 */
export const RENAMES = { normal: '稳定节奏', takeit: '滑动' }

/** 程序生成的轨迹（0=根部，100=龟头），播放时按档位速度整体拉伸。 */
function alternating(durations) {
  const actions = [{ at: 0, pos: 0 }]
  let at = 0
  durations.forEach((ms, i) => { at += ms; actions.push({ at: Math.round(at), pos: i % 2 === 0 ? 100 : 0 }) })
  return actions
}
const ramp = (from, to, legs) => Array.from({ length: legs }, (_, i) => from * (to / from) ** (i / (legs - 1)))
/** 渐变走完一遍后只循环最后一个往返（最快或最慢那一程）。 */
const lastRoundTrip = actions => actions.at(-3).at

export { lastRoundTrip }

export const GENERATED = [
  { key: 'accelerate', name: '渐快', actions: alternating(ramp(900, 360, 12)), loop: 'last' },
  { key: 'decelerate', name: '渐慢', actions: alternating(ramp(360, 900, 12)), loop: 'last' },
  { key: 'intermittent', name: '间歇', actions: [{ at: 0, pos: 0 }, { at: 400, pos: 100 }, { at: 800, pos: 0 }, { at: 1300, pos: 0 }] },
  { key: 'fast_out', name: '快去慢回', actions: [{ at: 0, pos: 0 }, { at: 300, pos: 100 }, { at: 900, pos: 0 }] },
  { key: 'slow_out', name: '慢去快回', actions: [{ at: 0, pos: 0 }, { at: 600, pos: 100 }, { at: 900, pos: 0 }] },
]

/** 给模型和用户看的描述，按源键或生成键。上端=龟头，下端=根部。 */
export const DESCRIPTIONS = {
  normal: '速度始终不变，节奏平稳。',
  classic: '两端放缓、中段加快的柔和往返，下端留一点余量。',
  accelerate: '往返逐渐加快，到最快后保持最快的节奏。',
  decelerate: '往返由快逐渐放慢，放到最慢后保持慢节奏。',
  intermittent: '动一下、停一下，断断续续。',
  fast_out: '向龟头快速推进，回根部时放慢。',
  slow_out: '向龟头缓慢推进，快速回到根部。',
  takeit: '往返的同时整体在范围内先上移再下移，刺激位置缓慢变化。',
  mw: '全程往返，在龟头和根部各补一次半程回弹。',
  deep: '深浅交替的折线，幅度起伏不定，整体先升后降。',
  tease: '在根部小幅轻点，穿插几次中等幅度的抽送。',
  edge: '大幅冲向龟头、中途折返，节奏急促多变。',
  rhythm: '从根部一口气推到龟头，带重拍感的规律抽送。',
  zipper: '锯齿式逐级爬升到龟头再逐级回落，结尾两次全程。',
  risingheat: '一次全程后小幅波浪逐级回落再爬升，周期较长。',
  angelbounce: '两次全程深抽后，在中段和根部小幅连颤。',
  psytrance: '中等幅度的波浪，整体先升到龟头再回落，呈拱形。',
  girlwants: '先在根部小幅慢动，逐渐加大到全程，在龟头轻颤后缓慢回落。',
  cpr: '折返着逐步推到龟头，再一次滑落到底，反复进行。',
  stepclimb: '细密的小幅快颤，从根部逐级移到龟头再逐级回落。',
  tide: '快速冲到龟头并在顶部碎颤，回到根部稍作回弹。',
  slopburst: '开头中幅试探，随后连续几次大幅爆发。',
  gimmemore: '两级锯齿推到龟头后一落到底。',
  tikthots: '在根部、中段、龟头分区密颤，最后几次不规则的大幅抽送。',
  sugardaddy: '像呼吸一样的中幅起伏，位置缓慢上移又回落，中间夹一次全程。',
  underground: '在不同区段间切换的短促抽动，从根部逐级移到龟头。',
  cyberdream: '在根部小幅蓄势、越来越碎，最后一次全程突进。',
  swallowwave: '大幅往返，整体逐渐上移到龟头再回落，像大浪。',
  premiumwave: '幅度像潮水一样从根部涨到全程，再退回根部。',
}


/**
 * 默认动作池（2026-11-01 用户确认）：三档按性格拉开。爆发没有自己的池时用高速池，温存用低速池，
 * 所以高速池偏激烈、低速池偏舒缓。不再从旧池候选生成。
 */
const POOLS = {
  low: [['温柔正弦', 'high'], ['呼吸起伏', 'high'], ['长波缓涌'], ['低吟渐起'], ['稳定节奏'], ['渐慢'], ['慢去快回'], ['间歇', 'low']],
  medium: [['稳定节奏', 'high'], ['滑动'], ['潮汐涨落'], ['拱形中浪'], ['快去慢回'], ['慢去快回'], ['渐快'], ['渐慢'], ['深浅跌宕', 'low']],
  high: [['稳定节奏', 'high'], ['强拍律动', 'high'], ['深抽连颤'], ['冲顶碎颤'], ['全幅大浪'], ['极限冲刺'], ['中幅爆发'], ['渐快', 'low']],
}

/** 名称须存在于内置目录（catalog 改名后或生成动作）。 */
export function defaultPool(tier, _pool, catalog) {
  const known = new Set([...Object.entries(catalog).map(([key, preset]) => RENAMES[key] ?? preset.name), ...GENERATED.map(item => item.name)])
  return POOLS[tier].map(([name, weight = 'medium']) => {
    if (!known.has(name)) throw new Error(`默认动作池里的动作不存在：${name}`)
    return { name, weight }
  })
}
