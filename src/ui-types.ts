/**
 * QQ 界面设置和图片接口的约定，host 和浏览器端共用。不 import 任何东西，两端都能直接打包。
 * 设置存 `<DSH_HOME>/qqbot/ui.json`，图片存 `<DSH_HOME>/qqbot/images/`。
 */

/** GET 读设置和图片版本，POST 提交一个操作；`?session=<id>` 时顺带返回这个会话当前的角色。 */
export const UI_PATH = '/api/qqbot/ui'
/** GET `?kind=avatar&role=<id>` 或 `?kind=background`，返回图片本身。 */
export const IMAGE_PATH = '/api/qqbot/image'

/** 色板来自 dsh-qq-skin：经典蓝、炫彩紫、简洁白、经典绿气泡、深空黑。 */
export const PALETTES = ['classic', 'vivid', 'clean', 'green', 'black'] as const
export type Palette = typeof PALETTES[number]

export const PALETTE_LABELS: Record<Palette, string> = {
  classic: '经典蓝',
  vivid: '炫彩紫',
  clean: '简洁白',
  green: '经典绿气泡',
  black: '深空黑',
}

export const BACKGROUND_FITS = ['cover', 'contain', 'fill'] as const
export type BackgroundFit = typeof BACKGROUND_FITS[number]

export const BACKGROUND_FIT_LABELS: Record<BackgroundFit, string> = {
  cover: '铺满裁切',
  contain: '完整显示',
  fill: '拉伸',
}

export interface UiSettings {
  readonly palette: Palette
  /** 用户气泡右侧的小尾巴。 */
  readonly bubbleTail: boolean
  /** 角色消息左侧的头像。 */
  readonly avatars: boolean
  /** 聊天区最大宽度（px）。 */
  readonly chatMaxWidth: number
  /** 隐藏工具调用过程和回合统计，只留消息和时间。 */
  readonly immersive: boolean
  /** 背景图片作为特殊色板启用；切换普通色板时保留已上传图片。 */
  readonly backgroundEnabled: boolean
  readonly backgroundFit: BackgroundFit
}

/** 默认值和 dsh-qq-skin 一致。 */
export const DEFAULT_UI_SETTINGS: UiSettings = {
  palette: 'classic',
  bubbleTail: true,
  avatars: true,
  chatMaxWidth: 880,
  immersive: true,
  backgroundEnabled: true,
  backgroundFit: 'cover',
}

export const UI_LIMITS = {
  chatMaxWidth: { min: 480, max: 1600 },
} as const

/** 图片版本号（保存时的毫秒时间戳），拼进图片地址，换图后浏览器不会用旧缓存。 */
export interface UiView {
  readonly settings: UiSettings
  readonly background?: number
  /** 角色 id → 头像版本。 */
  readonly avatars: Readonly<Record<string, number>>
  /** 带 `?session=` 请求时才有。 */
  readonly session?: UiSessionView
}

/** voice：角色卡选的音色（内部键），没选时没有这一项。音色还在不在由浏览器端对照语音设置判断。 */
export type UiRole = { readonly id: string; readonly name: string; readonly voice?: string } | null

export interface UiSessionView {
  /** 这个会话当前的角色，没有角色时为 null。 */
  readonly role: UiRole
  /** 角色库里可以选的角色，供会话里的角色切换菜单。 */
  readonly roster: readonly { readonly id: string; readonly name: string; readonly description: string }[]
  /**
   * 各轮用的角色：从 turn 这一轮起用 role，直到下一条，按轮次升序。角色已删除时为 null。
   * 最早一条之前的轮次按最早一条显示；为空表示还没记录，按当前角色显示。
   */
  readonly turns: readonly { readonly turn: number; readonly role: UiRole }[]
}

export type UiAction =
  | { readonly action: 'settings.save'; readonly settings: UiSettings }
  /** data 是 `data:image/png|jpeg|webp;base64,...`。 */
  | { readonly action: 'avatar.set'; readonly role: string; readonly data: string }
  | { readonly action: 'avatar.remove'; readonly role: string }
  | { readonly action: 'background.set'; readonly data: string }
  | { readonly action: 'background.remove' }
  /** 设置一个会话的角色，role 为 null 表示不用角色。会话还没开始时也可以设，第一轮就用它。 */
  | { readonly action: 'session.role'; readonly session: string; readonly role: string | null }

export interface UiError {
  readonly error: 'bad-request' | 'failed' | 'not-found'
  readonly message: string
}

/** 浏览器端压缩后的尺寸上限；host 再按字节数兜底。 */
export const AVATAR_SIZE = 256
export const BACKGROUND_MAX_EDGE = 1920
export const IMAGE_BYTE_LIMIT = { avatar: 1024 * 1024, background: 8 * 1024 * 1024 } as const

/** 外部插件未提供时长时的兜底间隔（毫秒）：字数取底数 2.6 的对数，最多 10 秒。
 * 保留 0–0.5 秒随机浮动；random 传 [0,1) 的随机数，测试时可以固定。
 */
export function segmentDelay(text: string, random = Math.random()): number {
  const ascii = /^[\x00-\x7f]*$/.test(text)
  const units = ascii ? text.trim().split(/\s+/).filter(Boolean).length : (text.match(/[\p{L}\p{N}]/gu) ?? []).length
  return Math.min(10, Math.log(units + 1) / Math.log(2.6) + random * 0.5) * 1000
}
