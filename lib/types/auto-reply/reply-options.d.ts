/** Browser-safe metadata envelope, separate from the existing [qq] stages protocol. */
export declare const OPTIONS_OPEN = "[qq-replies]";
export declare const OPTIONS_CLOSE = "[/qq-replies]";
export declare function parseReplyOptions(raw: string): readonly string[];
export interface SplitReplyOptions {
    body: string;
    replies: readonly string[];
}
/** Reserve a standalone suffix before rendering/voice/timing, including partial or invalid
 * metadata. Code fences and quoted examples stay ordinary content. Never edit durable history. */
export declare function splitReplyOptions(source: string, running: boolean): SplitReplyOptions;
/** Trim only the text suffix while preserving the native order of other blocks. */
export declare function projectReplyOptions<T extends {
    kind: string;
    text?: string;
}>(blocks: readonly T[], running: boolean): {
    blocks: readonly T[];
    replies: readonly string[];
};
