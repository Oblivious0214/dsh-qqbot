/**
 * 暂停快捷键：按下后设备和文字一起暂停（docs/architecture.md 第 10 节）。
 * 默认不设，界面推荐设为 Ctrl+M（首次授权时勾选即设好）；设了以后在输入框里也有效。用 ServeUCentral 等外部急停时可以不设。
 * 输入栏的"暂停"按钮任何档位都在，不能关闭。
 * 恢复用界面上的"继续"，或用户另设的恢复快捷键（可选，必须和暂停键不同）。暂停键不做切换，避免慌乱中连按两下又启动。
 *
 * 写法迁移自 dsh-serveu 的 preferences.js（validHotkey、hotkeyFromEvent、matchesHotkey）。
 * 单独的空格在输入框、按钮、滑条里不触发，照常打字和操作；带 Ctrl、Alt 或 Meta 的组合键在输入框里也触发。
 */

/** 推荐的暂停键。Ctrl+空格和 Alt+空格在 Windows 上分别被中文输入法和窗口菜单占用（2026-10-30 用户实测），改用字母键。 */
export const RECOMMENDED_HOTKEY = 'Ctrl+KeyM'

/** 未设置快捷键，暂停键和恢复键的默认值。 */
export const NO_HOTKEY = ''

const KEY = /^(Key[A-Z]|Digit[0-9]|Space|F(?:[1-9]|1[0-2]))$/
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

/** 剪切、复制、粘贴、撤销、重做、全选：捕获阶段会把它们从输入框里抢走，不能当快捷键（DSH 的 shortcuts 包同样保留这些）。 */
const EDITING = new Set(['KeyX', 'KeyC', 'KeyV', 'KeyZ', 'KeyY', 'KeyA'])

/** 被编辑键占用的组合：Ctrl 或 Meta 加上面的字母，不带 Alt（Ctrl+Shift+Z 是重做，也算）。 */
export function reservedHotkey(value: string): boolean {
  const parts = value.split('+')
  const key = parts.pop()!
  return EDITING.has(key) && !parts.includes('Alt') && (parts.includes('Ctrl') || parts.includes('Meta'))
}

/** 合法的写法：`Space`，或至少带 Ctrl、Alt、Meta 之一的组合键，例如 `Ctrl+Shift+KeyS`。Escape 留给关闭弹窗。 */
export function validHotkey(value: unknown): value is string {
  if (value === 'Space') return true
  if (typeof value !== 'string') return false
  const parts = value.split('+')
  const key = parts.pop()!
  return KEY.test(key) && parts.length > 0 && new Set(parts).size === parts.length
    && parts.every(part => (MODIFIERS as readonly string[]).includes(part))
    && parts.some(part => part !== 'Shift')
    && !reservedHotkey(value)
}

/** 键盘事件里用到的部分。 */
export interface KeyLike {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly repeat?: boolean
  readonly isComposing?: boolean
  readonly target?: unknown
}

/** 按下的键对应的写法；不能作为快捷键时返回 undefined。 */
export function hotkeyFromEvent(event: KeyLike): string | undefined {
  if (event.isComposing === true || event.repeat === true) return undefined
  const parts = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code]
  const value = parts.filter(Boolean).join('+')
  return validHotkey(value) ? value : undefined
}

/** 打字或操作控件时，单独的空格让给控件。 */
const TYPING = 'input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="button"],[role="slider"],[role="combobox"]'

interface TargetLike {
  readonly isContentEditable?: boolean
  closest?(selector: string): unknown
}

export function matchesHotkey(hotkey: string, event: KeyLike): boolean {
  if (hotkey === NO_HOTKEY || hotkeyFromEvent(event) !== hotkey) return false
  if (hotkey !== 'Space') return true
  const target = event.target as TargetLike | null | undefined
  return !(target?.isContentEditable === true || (target?.closest?.(TYPING) ?? null) !== null)
}

/** 给用户看的写法，例如 `Ctrl+Shift+S`。 */
export function hotkeyLabel(hotkey: string): string {
  return hotkey.replace(/Key|Digit/g, '')
}
