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
export declare const RECOMMENDED_HOTKEY = "Ctrl+KeyM";
/** 未设置快捷键，暂停键和恢复键的默认值。 */
export declare const NO_HOTKEY = "";
/** 被编辑键占用的组合：Ctrl 或 Meta 加上面的字母，不带 Alt（Ctrl+Shift+Z 是重做，也算）。 */
export declare function reservedHotkey(value: string): boolean;
/** 合法的写法：`Space`，或至少带 Ctrl、Alt、Meta 之一的组合键，例如 `Ctrl+Shift+KeyS`。Escape 留给关闭弹窗。 */
export declare function validHotkey(value: unknown): value is string;
/** 键盘事件里用到的部分。 */
export interface KeyLike {
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly repeat?: boolean;
    readonly isComposing?: boolean;
    readonly target?: unknown;
}
/** 按下的键对应的写法；不能作为快捷键时返回 undefined。 */
export declare function hotkeyFromEvent(event: KeyLike): string | undefined;
export declare function matchesHotkey(hotkey: string, event: KeyLike): boolean;
/** 给用户看的写法，例如 `Ctrl+Shift+S`。 */
export declare function hotkeyLabel(hotkey: string): string;
