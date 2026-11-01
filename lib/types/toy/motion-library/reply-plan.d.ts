import type { MotionConfig, Tier } from '../core/config.ts';
import { type MotionClip } from './library.ts';
import type { MotionPreview } from './preview.ts';
export type PlanStopReason = 'completed' | 'reply-ended' | 'user-interrupted' | 'replaced' | 'timeout' | 'detached' | 'disconnected' | 'disabled' | 'revoked';
export interface ReplyMotionPlan {
    readonly kind: 'reply-motion-plan-preview';
    readonly executable: false;
    readonly reply: string;
    readonly clipName: string;
    readonly seed: number;
    readonly playback: 'once' | 'loop';
    readonly preview: MotionPreview;
    /** 原生控制层授予的最大运行预算；气泡事件不能延长它。 */
    readonly budgetMs: number;
    readonly finish: 'full-clip' | 'protection-will-stop' | 'finite-loop-budget';
    readonly phase: 'active' | 'paused' | 'stopped';
    readonly elapsedMs: number;
    readonly stopReason?: PlanStopReason;
}
export interface ReplyPlanOptions {
    readonly reply: string;
    readonly tier: Tier;
    readonly seed: number;
    readonly budgetMs: number;
    readonly tempo?: 'original' | 'tier';
    readonly positionJitter?: number;
    readonly timingJitter?: number;
}
/** 同一轮回复的离线计划快照；生成不代表授权，也不发任何设备命令。 */
export declare function createReplyPlan(clip: MotionClip, config: MotionConfig, options: ReplyPlanOptions): ReplyMotionPlan;
export type ReplyPlanEvent = {
    readonly type: 'bubble';
    readonly reply: string;
} | {
    readonly type: 'elapsed';
    readonly ms: number;
} | {
    readonly type: 'pause' | 'resume';
} | {
    readonly type: PlanStopReason;
};
/** 模拟状态机：气泡只继承；终止优先且不可被 resume/bubble 复活；暂停冻结进度。 */
export declare function reduceReplyPlan(plan: ReplyMotionPlan, event: ReplyPlanEvent): ReplyMotionPlan;
