/**
 * 角色记忆整理的调度，在 host 层 `ctx.qqbot.memory`。
 *
 * 每个 qqbot 会话由预设内的 memory-agent 登记进来（它能拿到本会话的 agent 和 llm）。这里负责：
 * 判断新增内容够不够（消息数门槛）、同一会话不重复整理、同一角色的整理排队、写回时检查期间有没有被改过。
 * 触发时机（空闲、压缩、开新会话、手动）见 docs/architecture.md 第 6 节。
 */
import type { QqbotData } from './content.ts';
import type { ConsolidationInput, ConsolidationResult } from './memory-consolidate.ts';
import type { Warn } from './storage.ts';
/** 距上次整理至少新增多少轮（每条用户消息一轮），自动触发才整理。手动不受限。实测后再调。 */
export declare const MIN_NEW_TURNS = 10;
/** AI 最后一次回复后多久没有新消息算空闲。DeepSeek 的前缀缓存一般能保留到这时。 */
export declare const IDLE_MS: number;
/** 一个还开着的 qqbot 会话，由 memory-agent 登记。 */
export interface LiveMemorySession {
    readonly id: string;
    /** 会话的最新轮次（0 表示还没聊过）。 */
    latestTurn(): number;
    /** 最近一次有动静的时间，手动整理时用来挑最近的会话。 */
    lastActive(): number;
    /** 同步取下当前的请求前缀；还没发过请求时为 undefined。 */
    capture(): ConsolidationInput | undefined;
    /** 用取下的前缀发整理请求。 */
    run(input: ConsolidationInput, roleName: string, previous: string, signal?: AbortSignal): Promise<ConsolidationResult>;
}
export type ConsolidationOutcome = {
    readonly kind: 'done';
    readonly changed: boolean;
}
/** 新内容不够、没有角色、没有可回放的请求，或这个会话正在整理。 */
 | {
    readonly kind: 'skipped';
    readonly reason: 'no-role' | 'too-few' | 'no-request' | 'busy';
}
/** 整理期间记忆被改过，这次结果丢弃。 */
 | {
    readonly kind: 'stale';
}
/** 两次输出都超长或格式不对，保留旧版。 */
 | {
    readonly kind: 'rejected';
    readonly problem: string;
} | {
    readonly kind: 'failed';
    readonly error: string;
};
export declare class MemoryCoordinator {
    private readonly content;
    private readonly warn;
    private readonly paused;
    private generation;
    private cleanup;
    /** 清理时使进行中和排队的旧整理结果失效。 */
    invalidate(): void;
    private readonly live;
    private readonly running;
    /** 角色 id → 这个角色上一个整理任务；新任务接在后面。 */
    private readonly queues;
    constructor(content: QqbotData, warn: Warn, paused?: () => boolean);
    /** 登记会话，返回注销函数。 */
    register(session: LiveMemorySession): () => void;
    /**
     * 会话里还没整理过的轮次范围：从上次整理之后、或当前角色这一段开始（取较晚的）到最新一轮。
     * 换过角色时只算当前角色这一段。
     */
    pendingTurns(sessionId: string, roleId: string, latestTurn: number): number;
    /** 整理一个会话。force 时不看门槛（手动），但至少要有一轮新内容。 */
    consolidate(sessionId: string, force?: boolean): Promise<ConsolidationOutcome>;
    /** 开新会话：同一角色其他还开着的会话有足够的新内容，就在后台整理。不等待。 */
    consolidateOthers(newSessionId: string, roleId: string): void;
    /** 手动整理：用这个角色最近有动静的、还开着的会话。找不到时抛出可以直接展示的错误。 */
    consolidateRole(roleId: string): Promise<ConsolidationOutcome>;
}
/** 手动整理结果给用户看的说明；成功时为 undefined。 */
export declare function outcomeMessage(outcome: ConsolidationOutcome): string | undefined;
