/**
 * 提示词查看器的 host 接口：GET `/api/qqbot/prompt-view?session=<id>`，只读。
 * 全部是纯读取：不调用 systemPrompt.assemble()（working-directory 的监听会做文件 I/O、可能写会话），
 * 不读会话历史。依据见 work/prompt-viewer-source-20261029/README.md。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QqbotContent } from './content.ts';
import { type PromptFeatures } from './prompt.ts';
import { type QqbotRegistryStore, type QqbotSession } from './registry.ts';
import { type PromptView, type PromptViewTool } from './view-types.ts';
export declare const name = "qqbot-viewer";
export interface PromptViewInput {
    readonly session: QqbotSession;
    readonly content: QqbotContent;
    readonly store: QqbotRegistryStore;
    /** 上一轮真实组装出的系统提示词；本次启动后还没有请求时为空。 */
    readonly lastPrompt: string | undefined;
    /** 当前工作目录；读不到时为空，不显示这条 context。 */
    readonly workingDirectory: string | undefined;
    readonly tools: readonly PromptViewTool[];
    /** 下一轮组装时的工具情况，决定表情规则是否出现。 */
    readonly features: PromptFeatures;
}
/** 组装查看器数据。纯函数，便于测试。 */
export declare function buildPromptView(input: PromptViewInput): PromptView;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
