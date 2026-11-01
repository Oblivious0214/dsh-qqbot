import { type MotionScript } from './script.ts';
export interface PreviewOptions {
    /** 必须由调用者提供用户限制与机内限制的交集，不能来自模型。 */
    readonly minPosition: number;
    readonly maxPosition: number;
    readonly maxSpeed: number;
    readonly startSpeed?: number;
    readonly window?: readonly [number, number];
    readonly speedScale?: number;
    readonly positionJitter?: number;
    readonly timingJitter?: number;
    readonly seed?: number;
    readonly maxDurationMs?: number;
    readonly closedLoop?: boolean;
}
export interface PreviewLeg {
    readonly kind: 'entry' | 'move' | 'hold';
    readonly target: number;
    readonly durationMs: number;
    readonly endsAtMs: number;
    readonly sourceAtMs: number;
}
export interface MotionPreview {
    readonly kind: 'motion-preview';
    readonly executable: false;
    readonly sourceDurationMs: number;
    readonly durationMs: number;
    readonly retimedLegs: number;
    readonly timeStretch: number;
    readonly seed: number;
    readonly bounds: readonly [number, number];
    readonly legs: readonly PreviewLeg[];
}
/** 有限的可视化轨迹，不能作为播放器 Packet 使用；不实现调度、授权或传输。 */
export declare function previewScript(script: MotionScript, options: PreviewOptions): MotionPreview;
export interface StandbySampleOptions {
    readonly cycles: number;
    readonly highRange: readonly [number, number];
    readonly speedRange: readonly [number, number];
    readonly seed: number;
}
/** 仅生成有限的往返样本，不监听空闲、不启动待机。位置是片段的相对坐标。 */
export declare function createStandbySample(options: StandbySampleOptions): MotionScript;
