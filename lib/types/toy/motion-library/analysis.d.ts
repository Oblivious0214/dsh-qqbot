import { type MotionScript } from './script.ts';
export interface ClipFeatures {
    readonly durationMs: number;
    readonly minPosition: number;
    readonly maxPosition: number;
    readonly reversals: number;
    readonly holdFraction: number;
}
export declare function analyzeFeatures(script: MotionScript): ClipFeatures;
export interface DescriptionDraft {
    readonly text: string;
    readonly source: 'objective' | 'ai-draft';
    readonly requiresReview: true;
}
/** 接受外部 AI 返回的数据而非执行回调；失败或无效时使用客观特征初稿。 */
export declare function descriptionDraft(script: MotionScript, result?: {
    readonly ok: boolean;
    readonly text?: unknown;
}): DescriptionDraft;
/** 受限时间表达式解析；只产生待预览范围，不能自动保存或播放。 */
export declare function selectTimeRange(script: MotionScript, text: string): {
    fromMs: number;
    toMs: number;
    script: MotionScript;
};
export interface LoopCandidate extends MotionScript {
    readonly fromMs: number;
    readonly toMs: number;
    readonly periodMs: number;
    readonly observedRepeats: number;
    readonly maxPositionError: number;
    readonly observedCoverage: number;
    readonly reviewRequired: true;
}
export interface LoopAnalysis {
    readonly candidates: readonly LoopCandidate[];
    readonly fallback: 'keep-original';
    readonly reason: 'repeated-waveform-found' | 'no-reliable-repeat' | 'search-limited';
}
/** 保守启发式：至少三个相近周期，闭合谷点、相近周期与形状；从不强拼首尾。 */
export declare function analyzeLoops(script: MotionScript): LoopAnalysis;
