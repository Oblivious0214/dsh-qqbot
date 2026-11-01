/**
 * qqbot 预设隔离组里的压缩后端：DSH 原生 compaction-basic，只换摘要模板。
 *
 * compaction-basic 的配置没有模板选项，摘要指令写死为英文编程栏目。它注明 `summarize()`
 * 是唯一的子类钩子，这里只覆盖它；阈值、保留、事务和计量全部沿用原生实现。
 * 本插件只出现在 qqbot 预设的 `cordis:group` 里，标准会话仍用 DSH 自己的 compaction-basic。
 *
 * `summarizeChat()` 改写自 compaction-basic 的 `summarizeWithLlm()`（src/summarizer.ts，MIT），
 * 那个函数没有导出。和原版只差指令文本；DSH 升级时对照原版检查。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { ContentBlock, GenerateOptions, Message, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
/**
 * 摘要指令，作为最后一条 user 消息接在回放的对话后面，前缀缓存和原版一样复用。
 * 栏目没有内容时整栏省略：对话短时摘要比原文长会被 compaction-basic 拒绝。
 */
export declare const CHAT_COMPACTION_INSTRUCTION: string;
/** compaction-basic 回放给摘要器的对话：派生的系统头和被遮蔽的历史。对应它的 `SummarizationInput`。 */
export interface SummarizationInput {
    readonly tools?: readonly ToolSchema[];
    readonly messages: readonly Message[];
}
/** 对应 compaction-basic 的 `SummaryResult` 中经过 `ctx.llm.stream()` 的那种形态。 */
export interface SummaryResult {
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    usage?: TokenUsage;
    rawOutput: ContentBlock[];
    llmStreamCall: true;
}
/** 摘要调用用到的配置：compaction-basic 解析后的默认值，加按模型的覆盖。 */
export type SummaryConfig = Pick<ResolvedConfig, 'summarizationProvider' | 'summarizationModel' | 'maxTokens' | 'modelPolicies'>;
/** 摘要调用只用到 `ctx.llm.stream()`，测试时可以换成假的。 */
export interface SummaryLlm {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** 摘要调用只读 agent 的这几项。 */
export type SummaryAgent = Pick<Agent, 'options'> & {
    readonly session: Pick<Agent['session'], 'id' | 'requestHeader' | 'toolHistory'>;
};
/**
 * 用中文聊天模板生成摘要。目标模型、上限、按模型覆盖的取法和 compaction-basic 相同：
 * 配置的摘要模型 → 最近一次请求的模型 → AgentOptions。
 */
export declare function summarizeChat(llm: SummaryLlm, config: SummaryConfig, input: SummarizationInput, agent: SummaryAgent, signal?: AbortSignal): Promise<SummaryResult>;
/** compaction-basic 换成中文聊天模板。配置项、服务名、自动压缩和 `/compact` 都和原版相同。 */
export declare class QqbotCompactionEngine extends BasicCompactionEngine {
    protected summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>;
}
export default QqbotCompactionEngine;
