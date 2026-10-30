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

/**
 * 角色卡 `proactivity` 字段：这个角色最多到哪个设备主动性档位，由设备插件和用户的选择取较低者。
 * 没写时不限（等于 high）。dsh-qqbot 自己不用它，只通过登记服务的 `role()` 交给设备插件。
 */
export const ROLE_PROACTIVITIES = ['follow', 'situational', 'high'] as const
export type RoleProactivity = typeof ROLE_PROACTIVITIES[number]

export const ROLE_PROACTIVITY_LABELS: Record<RoleProactivity, string> = {
  follow: '跟随',
  situational: '情境主动',
  high: '高主动',
}

export interface LibraryRole {
  /** 内部键，自动生成，界面上不显示。 */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: string
  /** 没写时为空，用 DEFAULT_MEME_FREQUENCY。 */
  readonly memeFrequency?: MemeFrequency
  /** 设备主动性上限；没写时为空，表示不限。 */
  readonly proactivity?: RoleProactivity
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
export interface LibraryRoleDraft {
  readonly id?: string
  readonly name: string
  readonly description: string
  readonly persona: string
  readonly memeFrequency?: MemeFrequency
  readonly proactivity?: RoleProactivity
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
