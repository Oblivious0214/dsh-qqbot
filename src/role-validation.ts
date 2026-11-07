/** 两端共用的角色表单校验；不读取本机文件。 */
import { isRecord } from './json-record.ts'
import { MEME_FREQUENCIES, MOTION_ACTION_LIMIT, MOTION_RANGES, motionActionName, ROLE_PROACTIVITIES, type MemeFrequency, type MemePreferences, type MotionAction, type MotionRange, type RoleProactivity, type RoleProactivityTexts } from './library-types.ts'
import { VOICE_ID_PATTERN } from './voice-types.ts'
import { validateMemePreferences } from './meme-preferences.ts'
import { validateProactivityTexts } from './role-proactivity.ts'
import { validateConfig } from './role-dynamics/validate.ts'
import type { RoleDynamicsConfig } from './role-dynamics/types.ts'
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const isMemeFrequency = (value: unknown): value is MemeFrequency => typeof value === 'string' && (MEME_FREQUENCIES as readonly string[]).includes(value)
export const isRoleProactivity = (value: unknown): value is RoleProactivity => typeof value === 'string' && (ROLE_PROACTIVITIES as readonly string[]).includes(value)
/** 编辑界面提交的角色内容。修改时带 id；新建时不带，由 save() 生成。 */
export interface RoleDraft extends MemePreferences {
  readonly id?: string
  readonly name: string
  readonly description: string
  readonly persona: string
  /** 为空表示用默认档，保存时去掉这一行。 */
  readonly memeFrequency?: MemeFrequency
  /** 为空表示使用低自主性，保存时去掉这一行。 */
  readonly proactivity?: RoleProactivity
  readonly proactivityTexts?: RoleProactivityTexts
  /** 为空表示没有偏好，保存时去掉这一行。 */
  readonly motionActions?: readonly MotionAction[]
  readonly motionRanges?: readonly MotionRange[]
  /** 为空表示不用语音，保存时去掉这一行。 */
  readonly voice?: string
  readonly dynamics?: RoleDynamicsConfig | null
  readonly dynamicsBaseRevision?: string
  readonly resetDynamics?: boolean
  readonly dynamicsRenames?: Readonly<Record<string, string>>
}

const NAME_LIMIT = 64
const DESCRIPTION_LIMIT = 200
const PERSONA_LIMIT = 50_000

/** 校验编辑界面提交的角色；不合规时抛出可以直接展示给用户的错误。 */
export function validateRoleDraft(value: unknown): RoleDraft {
  if (!isRecord(value)) throw new TypeError('角色格式无效')
  const { id, name, description, persona, memeFrequency, proactivity, motionActions, motionRanges, voice } = value
  if (id !== undefined && (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id))) throw new TypeError('角色 id 无效')
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_LIMIT || /[\r\n]/.test(name)) {
    throw new TypeError(`角色名称不能为空，不能换行，最多 ${NAME_LIMIT} 个字符`)
  }
  if (typeof description !== 'string' || description.length > DESCRIPTION_LIMIT || /[\r\n]/.test(description)) {
    throw new TypeError(`角色简介不能换行，最多 ${DESCRIPTION_LIMIT} 个字符`)
  }
  if (typeof persona !== 'string' || persona.trim() === '' || persona.length > PERSONA_LIMIT) {
    throw new TypeError(`角色设定不能为空，最多 ${PERSONA_LIMIT} 个字符`)
  }
  if (memeFrequency !== undefined && !isMemeFrequency(memeFrequency)) throw new TypeError('表情频率无效')
  if (proactivity !== undefined && !isRoleProactivity(proactivity)) throw new TypeError('联动主动性无效')
  const proactivityTexts = validateProactivityTexts(value['proactivityTexts'])
  if (motionActions !== undefined && !Array.isArray(motionActions)) throw new TypeError('偏好动作无效')
  const actions = actionNames(motionActions, true)
  const ranges = validList(motionRanges, MOTION_RANGES, '偏好范围无效')
  if (voice !== undefined && (typeof voice !== 'string' || !VOICE_ID_PATTERN.test(voice))) throw new TypeError('音色无效')
  const dynamics = value['dynamics'] === undefined ? undefined : value['dynamics'] === null ? null : validateConfig(value['dynamics'])
  const dynamicsBaseRevision = value['dynamicsBaseRevision']
  if (dynamicsBaseRevision !== undefined && typeof dynamicsBaseRevision !== 'string') throw new TypeError('动态配置基线无效')
  if (value['resetDynamics'] !== undefined && typeof value['resetDynamics'] !== 'boolean') throw new TypeError('重置选择无效')
  const dynamicsRenames = value['dynamicsRenames']
  if (dynamicsRenames !== undefined && (!isRecord(dynamicsRenames) || Object.values(dynamicsRenames).some(v => typeof v !== 'string'))) throw new TypeError('字段改名映射无效')
  return {
    ...dynamics === undefined ? {} : { dynamics },
    ...dynamicsBaseRevision === undefined ? {} : { dynamicsBaseRevision: dynamicsBaseRevision as string },
    ...value['resetDynamics'] === undefined ? {} : { resetDynamics: value['resetDynamics'] as boolean },
    ...dynamicsRenames === undefined ? {} : { dynamicsRenames: dynamicsRenames as Record<string, string> },
    ...id === undefined ? {} : { id }, name: name.trim(), description: description.trim(), persona: persona.trim(),
    ...validateMemePreferences(value),
    ...memeFrequency === undefined ? {} : { memeFrequency },
    ...proactivity === undefined ? {} : { proactivity },
    ...proactivityTexts === undefined ? {} : { proactivityTexts },
    ...actions === undefined ? {} : { motionActions: actions },
    ...ranges === undefined ? {} : { motionRanges: ranges },
    ...voice === undefined ? {} : { voice },
  }
}

/** 偏好动作名：去重、保留顺序、最多 MOTION_ACTION_LIMIT 个；strict 时不合规的名称报错，否则丢掉。空列表当作没写。 */
export function actionNames(values: readonly unknown[] | undefined, strict: boolean): string[] | undefined {
  if (values === undefined) return undefined
  const names: string[] = []
  for (const value of values) {
    const name = motionActionName(value)
    if (name === undefined) { if (strict) throw new TypeError('偏好动作无效'); continue }
    if (!names.includes(name)) names.push(name)
  }
  if (strict && names.length > MOTION_ACTION_LIMIT) throw new TypeError(`偏好动作最多 ${MOTION_ACTION_LIMIT} 个`)
  const kept = names.slice(0, MOTION_ACTION_LIMIT)
  return kept.length === 0 ? undefined : kept
}

/** 编辑界面提交的列表：每项都要认识；按 choices 的顺序去重，空列表当作没写。 */
function validList<T extends string>(value: unknown, choices: readonly T[], message: string): T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(v => !choices.includes(v as T))) throw new TypeError(message)
  const picked = choices.filter(c => value.includes(c))
  return picked.length === 0 ? undefined : picked
}

