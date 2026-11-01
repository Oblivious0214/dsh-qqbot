/**
 * 角色记忆的整理请求，和 compaction-basic 的摘要请求一样：原样回放本会话的系统提示词、工具和历史，
 * 整理指令（含旧记忆）作为最后一条 user 消息。前缀和上一次聊天请求相同，输入基本都能命中缓存。
 * 结果不写进会话，只写角色记忆文件（role-memory.ts）。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, Message, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm';
/** 整理指令。旧记忆放在这里，不放进前缀。 */
export declare function consolidationInstruction(roleName: string, previous: string): string;
/** 整理需要的会话内容，在触发时同步取下：之后会话再变（压缩换掉旧历史、新消息）都不影响这次整理。 */
export interface ConsolidationInput {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: GenerateOptions['reasoningEffort'];
    readonly messages: readonly Message[];
    readonly tools?: readonly ToolSchema[];
    readonly toolHistory: ReturnType<Agent['session']['toolHistory']>;
    readonly sessionId: Agent['session']['id'];
}
export type ConsolidationAgent = Pick<Agent, 'options'> & {
    readonly session: Pick<Agent['session'], 'id' | 'requestHeader' | 'toolHistory' | 'deriveMessages'>;
};
/**
 * 取下会话当前的请求前缀。和上一次聊天请求用同一个模型和同样的工具，前缀才能命中缓存。
 * 会话还没发过请求时没有可回放的前缀，返回 undefined。
 */
export declare function captureConsolidation(agent: ConsolidationAgent): ConsolidationInput | undefined;
export interface ConsolidationLlm {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** 一次整理的结果。text 为 undefined 时表示两次都不合格，保留旧版。 */
export interface ConsolidationResult {
    readonly text: string | undefined;
    readonly problem?: string;
}
/**
 * 发整理请求，校验结构和长度。不合格时把问题告诉模型重写一次，还不合格就放弃（保留旧记忆）。
 * 请求出错（网络、取消）时抛出。
 */
export declare function consolidateMemory(llm: ConsolidationLlm, input: ConsolidationInput, roleName: string, previous: string, signal?: AbortSignal): Promise<ConsolidationResult>;
