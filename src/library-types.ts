/**
 * 角色和破限预设编辑接口的约定，host 和浏览器端共用。不 import 任何东西，两端都能直接打包。
 * 接口只有一个路径：GET 读全部，POST 提交一个操作并返回操作后的全部数据。DSH 的 fetch 路由只支持 GET、HEAD、POST。
 */

/** `/api` 下的精确路由，由 DSH 的 connection 做认证；只有 owner 能读写。 */
export const LIBRARY_PATH = '/api/qqbot/library'

export interface LibraryRole {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: string
  /** 单独选的破限预设；跟随默认时为空。 */
  readonly preset?: string
}

export interface LibraryPreset {
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
}

export interface LibraryRoleDraft {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: string
}

/** create 为真时 id 不能已存在，防止新建时覆盖同名条目；为假时必须已存在。 */
export type LibraryAction =
  | { readonly action: 'role.save'; readonly create: boolean; readonly role: LibraryRoleDraft }
  | { readonly action: 'role.remove'; readonly id: string }
  /** id 为空表示新会话不带角色。 */
  | { readonly action: 'role.default'; readonly id?: string }
  /** preset 为空表示跟随默认预设。 */
  | { readonly action: 'role.preset'; readonly id: string; readonly preset?: string }
  | { readonly action: 'preset.save'; readonly create: boolean; readonly preset: LibraryPreset }
  | { readonly action: 'preset.remove'; readonly id: string }
  | { readonly action: 'preset.default'; readonly id: string }

export interface LibraryError {
  readonly error: 'bad-request' | 'failed'
  readonly message: string
}
