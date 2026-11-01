/**
 * 登记到 qqbot 的设备规则（`qqbot:ext:toy`）和运行时状态行。
 *
 * 缓存：规则只随这几件事变化：用户改互动规则、改高速范围偏好、有人设时切换主动性档位（含角色上限变化）或改当前档的说明、
 * 换角色或改角色卡的偏好动作和范围（换角色时角色设定在更前面，已经失效，这一行不多造成失效）。
 * 行程、速度上限和分界不进提示词，拖滑条不会让前缀失效；坐标换算、限速、升速过渡和越界拒绝都由程序做。
 * 接入、断开和暂停走 runtime context，不改规则。
 */

import type { MotionConfig } from './config.ts'
import { RANGE_LABELS, TIER_LABELS } from './intent.ts'
import { RANGES, TIERS, type RangeName } from './config.ts'
import { PROACTIVITY_KEYS, type Proactivity, type ProactivityKey } from './safety.ts'

export const MAX_BEHAVIOR_LENGTH = 6000

/** 用户可编辑的互动规则的默认内容。和档位无关，档位另有固定段落。 */
export const DEFAULT_BEHAVIOR = `配合当前段落的语气和节奏安排动作、变化或停顿；没有必要时延续当前动作，不强行增加动作。
表达方式沿用当前人设，不向用户解释控制协议。`

const list = <T extends string>(keys: readonly T[], labels: Record<T, string>) =>
  keys.map(key => `${key}=${labels[key]}`).join('，')

const PROTOCOL = `设备联动：你随剧情安排设备动作，只选范围、速度档和动作，程序换算成实际位置和速度并执行限速。
角色对用户性器官做的抚弄、套弄、口交、骑乘等动作由设备执行：用户要求这类动作，就是要求设备开始或改变动作。
设备从角色碰到用户性器官的那一段开始动作；之前脱衣、靠近、挑逗的段落不写 motion。
写法：动作写在 [qq] 段落的 motion 字段里，该段显示时生效；没有变化的段落省略 motion，保持当前动作，相同选择不会重启节奏。
range：${list(RANGES, RANGE_LABELS)}。按该段文字写到的部位选，部位变了就在那一段改 motion。冠状沟、顶部、尖端也对应 upper；深插、整根吞到底、顶到最里面、顶到子宫口、顶住研磨对应 lower。插入按深度推进：龟头抵住、刚进去一点、浅插用 upper，吃进一半用 upper_half，整根进去后用 full 或 lower。轻和慢不影响范围，写到根部就用 lower。
tier：${list(TIERS, TIER_LABELS)}。action：填运行时“可选动作”里的动作名称，标了“仅”的只在所列档使用；拿不准时写 auto，由程序从该档动作池选择。
每处 motion 都写全三项，例如 [qq]{"version":1,"stages":[{"text":"……","motion":{"range":"full","tier":"low","action":"……"}}]}[/qq]。停止写 "motion":{"stop":true}。默认逐步变化；用户要求或剧情需要时可以直接换档。`

const HIGH_RANGE = {
  large: '高速档倾向大行程：full、lower_half、upper_half。',
  local: '高速档倾向小行程高频：lower、middle、upper；程序会再把所选范围围绕中点缩短，你不必为此再缩小范围。',
} as const

/** 档位名，固定写在用户文本前面，用户改文本也不会丢掉"现在是哪一档"。 */
export const PROACTIVITY_LABELS: Record<ProactivityKey, string> = {
  follow: '低自主性',
  situational: '中自主性',
  high: '高自主性',
}

export const MAX_PROACTIVITY_TEXT_LENGTH = 2000

/** 各档默认说明；在 QQbot 角色编辑器中分别改写，设备槽位仍由本插件组装。 */
export const DEFAULT_PROACTIVITY_TEXTS: Record<ProactivityKey, string> = {
  follow: `主要依照用户要求控制设备。只在用户要求开始、改变或停止时调整动作；用户没有提出时保持当前动作。
用户说"停一下""先停""暂停""别动"等时，第一段写 "motion":{"stop":true}，本条回复里不再启动；说"慢一点""轻一点"时降一档或换更缓的动作。等用户明确要继续再安排。`,
  situational: `以用户要求为主，结合剧情走向和人设性格控制设备。用户没有具体要求时，可以根据当前情境适度开始或调整动作。
用户说"停一下""先停""暂停""别动"等时，第一段写 "motion":{"stop":true}；之后可以按人设表现不舍，在后面的段落里安排轻微动作（例如 upper 加 low）。用户再次要求停时，本条回复里不再启动。`,
  high: `更多依据剧情走向和人设性格自主决定设备动作，可以主动开始、加快或改变动作，不必等待用户逐项要求。用户在剧情里说"停""慢一点"时，由角色按人设决定是否照做。`,
}

export type ProactivityTexts = Partial<Record<ProactivityKey, string>>

/** 某一档实际用的说明：用户改写过用改写的，否则用默认。 */
export function proactivityText(texts: ProactivityTexts | undefined, level: Proactivity): string {
  const key = PROACTIVITY_KEYS[level]
  return texts?.[key] ?? DEFAULT_PROACTIVITY_TEXTS[key]
}

/** 角色卡写的偏好。 */
export interface RolePreference {
  readonly name: string
  /** 动作库里的动作名称。 */
  readonly actions?: readonly string[]
  readonly ranges?: readonly RangeName[]
}

export interface RuleInput {
  readonly motion: Pick<MotionConfig, 'tiers'>
  readonly behavior: string
  readonly proactivity: Proactivity
  readonly proactivityTexts?: ProactivityTexts
  readonly role?: RolePreference
}

/** 角色偏好一行；没有偏好时为空串。只说倾向，用户的话优先。 */
export function preferenceLine(role: RolePreference | undefined): string {
  if (role === undefined) return ''
  const parts = [
    ...role.actions === undefined ? [] : [`动作 ${role.actions.join('、')}`],
    ...role.ranges === undefined ? [] : [`范围 ${role.ranges.join('、')}`],
  ]
  return parts.length === 0 ? '' : `${role.name}偏好${parts.join('，')}；用户没有提出时优先从中选。`
}

/** 没有角色时不给自主性档位，只留叫停的写法。 */
const NO_ROLE_STOP = '用户要求停下时，第一段写 "motion":{"stop":true}，等用户要求再继续。'

/** 设备规则全文。无人设时用叫停一行代替主动性段落；有人设且说明清空时只留档位名。 */
export function deviceRules(input: RuleInput): string {
  const behavior = input.behavior.trim()
  const level = proactivityText(input.proactivityTexts, input.proactivity).trim()
  const label = `自主性：${PROACTIVITY_LABELS[PROACTIVITY_KEYS[input.proactivity]]}。`
  const preference = preferenceLine(input.role)
  return [
    PROTOCOL,
    HIGH_RANGE[input.motion.tiers.high.rangePreference],
    input.role === undefined ? NO_ROLE_STOP : level === '' ? label : `${label}\n${level}`,
    ...preference === '' ? [] : [preference],
    ...behavior === '' ? [] : [`补充互动规则：\n${behavior}`],
  ].join('\n')
}

/** 浏览器上报的设备状态。 */
export const DEVICE_STATUSES = ['ready', 'paused', 'disconnected'] as const
export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

const STATUS_TEXT: Record<DeviceStatus, string> = {
  ready: '已连接，可以安排动作',
  paused: '用户已暂停，动作不会执行',
  disconnected: '未连接，动作不会执行',
}

/** `qqbot:runtime` 里的一行（不含名称前缀）。每次变化都会在历史里多一条 context，状态只在用户操作时变。 */
export function runtimeLine(status: DeviceStatus): string {
  return STATUS_TEXT[status]
}
