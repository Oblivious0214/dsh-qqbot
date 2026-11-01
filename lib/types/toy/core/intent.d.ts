/**
 * 动作意图：AI 只选范围、速度档和动作名，程序换算成实际坐标和速度。
 * 迁移自 dsh-serveu 的 definition-protocol.js（reduceIntent、describeIntent），去掉了 protocol 标记字段。
 * 动作全部来自动作库；名称不在该档动作池里时由播放器按 auto 处理。
 */
import { type MotionConfig, type RangeName, type Tier } from './config.ts';
/** 由程序从该档动作池抽取。 */
export declare const AUTO_ACTION = "auto";
/** 一个完整的动作选择。 */
export interface Intent {
    readonly range: RangeName;
    readonly tier: Tier;
    /** 动作库里的名称（已做 NFKC 和去空格），或 auto。 */
    readonly action: string;
}
/** 段落里的 motion 字段：三项，或 `{ "stop": true }`。提示词只教写全，只写变化项也接受。 */
export type MotionCommand = Partial<Intent> | {
    readonly stop: true;
};
export declare const RANGE_LABELS: Record<RangeName, string>;
export declare const TIER_LABELS: Record<Tier, string>;
/** 规整动作名：去空格、NFKC；auto 不分大小写。不合法时返回 undefined。 */
export declare function actionName(value: unknown): string | undefined;
/**
 * 在上一个选择上应用一条 motion，返回新的选择；`stop` 返回 null。
 * 字段相同时返回 previous 本身，调用方据此判断"没有变化，不重启节奏"。
 * 首次启动或停止之后必须三项齐全，否则抛出。
 */
export declare function reduceIntent(previous: Intent | null, command: unknown): Intent | null;
/** 实际坐标区间（小数），已含高速小行程的缩短。 */
export declare function intentPosition(intent: Intent, config: MotionConfig): readonly [number, number];
export declare function sameIntent(a: Intent | null, b: Intent | null): boolean;
