/** 独立编写的有限脚本数据解析器；不读取路径、不执行脚本、不触碰设备。 */
export interface MotionPoint {
    readonly at: number;
    readonly pos: number;
}
export interface MotionScript {
    readonly points: readonly MotionPoint[];
}
export declare const SCRIPT_LIMITS: {
    readonly jsonCharacters: 2000000;
    readonly points: 20000;
    readonly sourceDurationMs: 3600000;
    readonly clipDurationMs: 600000;
    readonly previewDurationMs: 3600000;
    readonly clips: 100;
};
export declare function record(value: unknown, label: string): Record<string, unknown>;
export declare function finite(value: unknown, low: number, high: number, label: string): number;
export declare function integer(value: unknown, low: number, high: number, label: string): number;
export declare function parseJson(text: string): unknown;
/** 严格拒绝乱序、重复时间、非有限数字及越界位置，不静默排序或丢弃坏点。 */
export declare function parsePoints(value: unknown): MotionPoint[];
/** 仅支持单轴 actions/at/pos 子集；其他元信息丢弃，未知版本和多轴扩展拒绝。 */
export declare function parseFunscript(text: string): MotionScript;
/** 轨迹落盘只保存单轴标准字段，名称、分组及播放配置由库索引保存。 */
export declare function serializeFunscript(script: MotionScript): string;
/**
 * 循环动作首尾位置不同时，在结尾补一个回到起点的点，时间按结尾那段的速度推算，
 * 末尾停留时沿用最近的移动速度；不能再增加时长或点数时，改接原片段尾部。
 */
export declare function closeLoop(points: readonly MotionPoint[]): MotionPoint[];
/** 截取闭区间，边界按线性插值补点，片段从零开始，保留中间点及停留。 */
export declare function sliceScript(script: MotionScript, fromMs: number, toMs: number): MotionScript;
