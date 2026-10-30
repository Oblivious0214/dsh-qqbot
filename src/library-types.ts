/**
 * 角色和破限预设编辑接口的约定，host 和浏览器端共用。不 import 任何东西，两端都能直接打包。
 * 接口只有一个路径：GET 读全部，POST 提交一个操作并返回操作后的全部数据。DSH 的 fetch 路由只支持 GET、HEAD、POST。
 */

/** `/api` 下的精确路由，由 DSH 的 connection 做认证；只有 owner 能读写。 */
export const LIBRARY_PATH = '/api/qqbot/library'

/** 角色卡 `memeFrequency` 字段的取值。 */
export const MEME_FREQUENCIES = ['low', 'medium', 'high', 'off'] as const
export type MemeFrequency = typeof MEME_FREQUENCIES[number]

/** 角色卡没写表情频率时用的档位。 */
export const DEFAULT_MEME_FREQUENCY: MemeFrequency = 'medium'

export const MEME_FREQUENCY_LABELS: Record<MemeFrequency, string> = {
  low: '低',
  medium: '适中',
  high: '高',
  off: '不主动发',
}

/** 只保存角色偏好，不修改 dsh-meme 的图库开关。名称供界面和提示词使用。 */
export interface MemePackChoice {
  readonly id: string
  readonly name: string
}

export interface MemePreferences {
  readonly memePacks?: readonly MemePackChoice[]
  readonly memeTags?: readonly string[]
  readonly memePrompt?: string
}
export const MEME_PROMPT_LIMIT = 4000

/**
 * 角色卡 `proactivity` 字段：这个角色最多到哪个设备主动性档位，由设备插件和用户的选择取较低者。
 * 没写时不限（等于 high）。dsh-qqbot 自己不用它，只通过登记服务的 `role()` 交给设备插件。
 */
export const ROLE_PROACTIVITIES = ['follow', 'situational', 'high'] as const
export type RoleProactivity = typeof ROLE_PROACTIVITIES[number]

export const ROLE_PROACTIVITY_LABELS: Record<RoleProactivity, string> = {
  follow: '低自主性',
  situational: '中自主性',
  high: '高自主性',
}

/** 每个角色分别改写三档说明；未写的档位使用联动插件提供的默认说明。 */
export type RoleProactivityTexts = Partial<Record<RoleProactivity, string>>
export const ROLE_PROACTIVITY_TEXT_LIMIT = 2000

/**
 * 角色卡 `motionActions`、`motionRanges` 字段：角色偏好的设备动作和范围，逗号分隔。
 * 只是倾向，由设备插件写进它的规则；dsh-qqbot 自己不用，名称和设备插件的动作、范围一致。
 */
export const MOTION_ACTIONS = ['steady', 'accelerate', 'decelerate', 'intermittent', 'fast_out', 'slow_out', 'slide'] as const
export type MotionAction = typeof MOTION_ACTIONS[number]
export const MOTION_ACTION_LABELS: Record<MotionAction, string> = {
  steady: '稳定节奏', accelerate: '渐快', decelerate: '渐慢', intermittent: '间歇', fast_out: '快去慢回', slow_out: '慢去快回', slide: '滑动',
}
export const MOTION_RANGES = ['full', 'lower_half', 'upper_half', 'lower', 'middle', 'upper'] as const
export type MotionRange = typeof MOTION_RANGES[number]
export const MOTION_RANGE_LABELS: Record<MotionRange, string> = {
  full: '全行程', lower_half: '下半程', upper_half: '上半程', lower: '下端局部', middle: '中间段', upper: '上端局部',
}

export interface LibraryRole extends MemePreferences {
  /** 内部键，自动生成，界面上不显示。 */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: string
  /** 没写时为空，用 DEFAULT_MEME_FREQUENCY。 */
  readonly memeFrequency?: MemeFrequency
  /** 设备主动性上限；没写时为空，表示不限。 */
  readonly proactivity?: RoleProactivity
  readonly proactivityTexts?: RoleProactivityTexts
  /** 偏好的设备动作和范围；没写时为空。 */
  readonly motionActions?: readonly MotionAction[]
  readonly motionRanges?: readonly MotionRange[]
  /** 音色的内部键（语音设置里的音色）；没选时为空。 */
  readonly voice?: string
  /** 单独选的破限预设；跟随默认时为空。 */
  readonly preset?: string
}

export interface LibraryPreset {
  /** 内部键，自动生成，界面上不显示。 */
  readonly id: string
  readonly name: string
  readonly head: string
  readonly mid: string
  readonly tail: string
}

export interface LibraryView {
  /** 当前已启用的可选插件能力，供编辑器按需显示选项。 */
  readonly features: { readonly meme: boolean; readonly toy: boolean }
  /** 角色卡所在目录，界面上提示用户也可以直接改文件。 */
  readonly rolesDir: string
  readonly roles: readonly LibraryRole[]
  /** 新 QQ 会话的默认角色；为空表示新会话不带角色。 */
  readonly defaultRole?: string
  readonly presets: readonly LibraryPreset[]
  readonly defaultPreset: string
  /** role.save 和 preset.save 成功后，保存的条目 id（新建角色的 id 由服务端生成）。 */
  readonly saved?: string
}

/** 新建时不带 id，由服务端生成；修改时带上原 id。 */
export interface LibraryRoleDraft extends MemePreferences {
  readonly id?: string
  readonly name: string
  readonly description: string
  readonly persona: string
  readonly memeFrequency?: MemeFrequency
  readonly proactivity?: RoleProactivity
  readonly proactivityTexts?: RoleProactivityTexts
  readonly motionActions?: readonly MotionAction[]
  readonly motionRanges?: readonly MotionRange[]
  readonly voice?: string
  /** 角色编辑器选择的具体预设，随角色保存。旧调用未传时保留原选择。 */
  readonly preset?: string
}

/** 角色和预设：新建不带 id（服务端生成），修改时带原 id；名称不能重复。 */
export type LibraryAction =
  | { readonly action: 'role.save'; readonly create: boolean; readonly role: LibraryRoleDraft }
  | { readonly action: 'role.remove'; readonly id: string }
  /** id 为空表示新会话不带角色。 */
  | { readonly action: 'role.default'; readonly id?: string }
  /** preset 为空表示跟随默认预设。 */
  | { readonly action: 'role.preset'; readonly id: string; readonly preset?: string }
  | { readonly action: 'preset.save'; readonly create: boolean; readonly preset: LibraryPresetDraft }
  | { readonly action: 'preset.remove'; readonly id: string }
  | { readonly action: 'preset.default'; readonly id: string }

/** 新建时不带 id，由服务端生成；修改时带上原 id。 */
export type LibraryPresetDraft = Omit<LibraryPreset, 'id'> & { readonly id?: string }

export interface LibraryError {
  readonly error: 'bad-request' | 'failed'
  readonly message: string
}
