/**
 * QQ 界面设置和图片：设置存 `<数据目录>/ui.json`，角色头像存 `images/avatars/<角色 id>.<扩展名>`，
 * 聊天背景存 `images/background.<扩展名>`。只影响浏览器端显示，不进提示词。
 * 接口：UI_PATH 读写设置和图片，IMAGE_PATH 读图片。都走 DSH 的认证，只有 owner 能访问。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QqbotData } from './content.ts';
import { type Warn } from './storage.ts';
import { type UiSettings, type UiView } from './ui-types.ts';
export declare const name = "qqbot-ui";
declare const IMAGE_TYPES: {
    readonly png: "image/png";
    readonly jpeg: "image/jpeg";
    readonly webp: "image/webp";
};
type ImageType = keyof typeof IMAGE_TYPES;
/** 请求格式不对，和"操作本身失败"区分开。 */
export declare class BadRequest extends Error {
}
/** 校验编辑器提交的整份设置；不合规时抛出可以直接展示给用户的错误。 */
export declare function validateUiSettings(value: unknown): UiSettings;
/** 解码浏览器传来的 data URL，按文件头确认真是 PNG/JPEG/WebP，不信任声明的类型。 */
export declare function decodeImage(data: unknown, limit: number): {
    type: ImageType;
    bytes: Buffer;
};
/** 一张图片：同一个名字只留一种扩展名。 */
declare class ImageSlot {
    private readonly dir;
    private readonly stem;
    constructor(dir: string, stem: string);
    find(): {
        file: string;
        type: ImageType;
        version: number;
    } | undefined;
    write(type: ImageType, bytes: Buffer): void;
    remove(): void;
}
export declare class UiStore {
    readonly dir: string;
    private readonly warn;
    private settingsCache;
    constructor(dir: string, warn: Warn);
    clearCache(): void;
    private get file();
    private get imageDir();
    private get avatarDir();
    get settings(): UiSettings;
    saveSettings(value: unknown): void;
    background(): ImageSlot;
    avatar(role: string): ImageSlot;
    /** 角色 id → 头像版本。文件名不合规的跳过。 */
    avatarVersions(): Record<string, number>;
    /** 删除角色时把头像一起移到回收站，放回角色时可以一起放回。 */
    trashAvatar(role: string, trashDir: string, stamp: string): void;
}
export declare function uiView(data: QqbotData, ui: UiStore, sessionId: string | undefined): UiView;
/** 执行一个操作。格式错误抛 BadRequest，操作失败（找不到、写不了盘）抛 Error。 */
export declare function applyUiAction(data: QqbotData, ui: UiStore, body: unknown): void;
/** 读图片。地址里带版本号，换图后地址就变了，所以可以让浏览器长期缓存。 */
export declare function imageResponse(ui: UiStore, request: Request): Response;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export {};
