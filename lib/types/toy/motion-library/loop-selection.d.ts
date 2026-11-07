import { type MotionScript } from './script.ts';
export interface LoopSelection extends MotionScript {
    readonly fromMs: number;
    readonly toMs: number;
    readonly method: 'natural' | 'tail';
}
/** 唯一的循环准备入口：预览和保存共用相同原始源、手选范围和确定性结果。 */
export declare function prepareLoopSelection(script: MotionScript, fromMs: number, toMs: number): LoopSelection;
