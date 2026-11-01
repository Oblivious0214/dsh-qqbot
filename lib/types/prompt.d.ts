/**
 * qqbot 预设内的提示词插件：只挂在 qqbot 预设里，所以标准会话不受影响。
 * 读取 host 层 qqbot 服务的内容和登记，组装成本预设的 section 和 context。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QqbotContent } from './content.ts';
import { type QqbotRegistryStore, type QqbotSession } from './registry.ts';
export declare const name = "qqbot-prompt";
export declare const inject: string[];
/** `qqbot:prompt` 里的一段。name 沿用分段时的 section 名，供提示词查看器标出来源。 */
export interface PromptPart {
    readonly name: string;
    readonly order: number;
    readonly text: string;
    /** 外部槽位的登记插件；dsh-qqbot 自己的段落为空。 */
    readonly source?: string;
}
/** 各段之间的分隔，和 DSH 拼接 section 时一致（system-prompt 的 renderPrompt）。 */
export declare const PART_SEPARATOR = "\n\n";
/** 本轮组装时宿主环境的情况：哪些按工具在场才输出的规则要出现。 */
export interface PromptFeatures {
    /** 本会话能用 dsh-meme 的 send_meme。 */
    readonly meme: boolean;
}
/**
 * 按 SECTION_ORDER 列出本会话的各段，去掉空段。同 order 按名称排序，和 DSH 的 section 排序规则一致。
 * session 为空时只剩不按会话求值的段落。
 */
export declare function assembleParts(content: QqbotContent, store: QqbotRegistryStore, session: QqbotSession | undefined, features?: PromptFeatures): PromptPart[];
/** `qqbot:runtime` context 的文本：每条一行 `名称: 内容`，空条目去掉。 */
export declare function renderRuntime(store: QqbotRegistryStore, session: QqbotSession): string;
export declare function apply(ctx: Context): void;
