import type { MotionScript } from './script.ts';
export interface HeatBucket {
    fromMs: number;
    toMs: number;
    min: number;
    max: number;
    movement: number;
    coveredMs: number;
}
export declare function heatmapColor(movement: number, peak: number): string;
/** 原始线段与窗口桶相交积分；显示数据从不用于保存。 */
export declare function buildHeatmap(script: MotionScript, from: number, to: number, count: number): HeatBucket[];
