/** QQ 表情的共享检索与显示协议；只在已经限定的图库中匹配。 */
export declare const MEME_SCOPE_PATH = "/api/qqbot/memes";
export interface ScopedMeme {
    readonly pack: string;
    readonly path: string;
    readonly caption: string;
    readonly tag: string;
    readonly keywords: string;
    readonly url: string;
}
export interface MemeScopeView {
    readonly memes: readonly ScopedMeme[];
    readonly message?: string;
    readonly origin?: string;
}
/** 标签和关键词只缩小当前角色候选，不跨图库回退。 */
export declare function searchMemes(rows: readonly ScopedMeme[], tag?: string, query?: string, limit?: number): ScopedMeme[];
/** 候选自带图库和路径身份，描述同名也不会串图。标识只用于消息协议，界面不显示。 */
export declare function memeKey(row: ScopedMeme): string;
export declare function memeMarker(row: ScopedMeme): string;
/** 历史描述兼容只做当前范围内的精确匹配；没有匹配时保留描述。 */
export declare function findMeme(text: string, rows: readonly ScopedMeme[]): ScopedMeme | undefined;
export declare function memeDescription(text: string): string;
/** 在交给原生 Markdown 之前消去第三方的全局配图标记，加载失败也不会跨库配图。 */
export declare function projectMemes(text: string, rows: readonly ScopedMeme[], base?: string): string;
