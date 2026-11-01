/**
 * 运动配置：用户设定的行程、速度上限、快慢分界、行程分界和高速范围偏好。
 * host 和浏览器共用，纯函数，不碰存储和设备。
 *
 * 换算规则迁移自 dsh-serveu 的 definition-config.js 和 preview.js（speedBands），字段改为 camelCase，
 * 不读旧的 localStorage 记录（旧插件没有发布过，见 CLAUDE.md）。
 */
/** 程序层的绝对上限，任何配置都不能越过。 */
export declare const HARD_LIMITS: {
    readonly minPosition: 0;
    readonly maxPosition: 100;
    readonly minSpeed: 2;
    readonly maxSpeed: 500;
};
export declare const TIERS: readonly ["low", "medium", "high"];
export type Tier = (typeof TIERS)[number];
export declare const RANGES: readonly ["full", "lower_half", "upper_half", "lower", "middle", "upper"];
export type RangeName = (typeof RANGES)[number];
export interface HighTierPreference {
    /** large：大行程高速；local：小行程高频，选中的范围再围绕中点缩短。 */
    readonly rangePreference: 'large' | 'local';
    /** 只在 local 时生效，0–90。 */
    readonly localShrinkPercent: number;
}
export interface MotionConfig {
    /** 自动停止秒数；0 表示不自动停止，缺省 30。 */
    readonly autoStopSeconds?: number;
    readonly standby?: {
        readonly preset: string;
        readonly minPosition: number;
        readonly maxPosition: number;
        readonly maxSpeed: number;
    };
    readonly minPosition: number;
    readonly maxPosition: number;
    /** unit/s，2–500。 */
    readonly maxSpeed: number;
    /** 低/中、中/高的分界，unit/s。 */
    readonly speedBreakpoints: readonly [number, number];
    /** 下端/中间、中间/上端的分界，相对于允许行程的百分比，1–99。 */
    readonly rangeBreakpoints: readonly [number, number];
    readonly tiers: {
        readonly high: HighTierPreference;
    };
}
export declare function defaultMotion(): MotionConfig;
/** 校验来自请求或文件的配置，返回只含已知字段的新对象。不合法时抛出中文错误。 */
export declare function parseMotion(value: unknown): MotionConfig;
export interface SpeedBands {
    /** 低速 < low ≤ 中速 < high ≤ 高速 ≤ cap。 */
    readonly low: number;
    readonly high: number;
    readonly cap: number;
}
/**
 * 按速度上限压缩快慢分界：上限变低时分界跟着收拢，三档之间尽量留 10 unit/s 的间隔。
 * 算法照搬旧插件 preview.js 的 speedBands。
 */
export declare function speedBands(config: Pick<MotionConfig, 'maxSpeed' | 'speedBreakpoints'>): SpeedBands;
export interface TierBudget {
    readonly min: number;
    readonly max: number;
    readonly nominal: number;
}
/** 一个速度档在当前上限下可用的速度区间。上限太低、该档不存在时抛出。 */
export declare function tierBudget(config: MotionConfig, tier: Tier): TierBudget;
/**
 * 高潮刺激用哪一档：选档时取该档，不可用就往低档找，再往高档找；
 * 自己填速度时取速度所在的档（超过上限按最高可用档）。动作池未单独保存时沿用这一档的池。
 */
export declare function burstTier(config: MotionConfig, speed: 'medium' | 'high' | number): Tier | undefined;
/** 六个范围在允许行程里的实际坐标（可以是小数，输出时再向内取整）。 */
export declare function rangeCoordinates(config: MotionConfig): Record<RangeName, readonly [number, number]>;
/** 设备报告的机内限制（蓝牙 D0）。 */
export interface HardwareLimits {
    readonly minPosition: number;
    readonly maxPosition: number;
    readonly maxSpeed: number;
}
