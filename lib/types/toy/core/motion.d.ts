/**
 * 程序直接驱动的位移包：手动定位，以及动作轨迹共用的限位、快调和包间隔规则。纯函数，不碰设备和计时器。
 * AI 选的动作全部来自动作库，由 motion-library/playback.ts 播放。
 *
 * 规则迁移自 dsh-serveu 的 definition-output.js（packetizeLeg、outputRange）：
 * - 每一程切成至少 100 ms 一包，同一程的包等长；取整或蓝牙速度量化只会让它变慢，不会变快。
 * - 升速有上限：每秒最多加 RAMP_UP。降速和停止不受限制。
 */
import { type MotionConfig } from './config.ts';
import { type Intent } from './intent.ts';
/** 两包之间的最短间隔。 */
export declare const MIN_INTERVAL_MS = 100;
/** 升速上限（unit/s²）。默认配置下慢档到快档约 5.5 秒。 */
export declare const RAMP_UP = 60;
export interface Packet {
    /** 目标位置，0–100 的整数。 */
    readonly position: number;
    readonly durationMs: number;
    /** 本包允许的速度上限（unit/s，整数）。hold 包不发送，这个值没有意义。 */
    readonly speed: number;
    /** 位置不变，只等待，不发送。 */
    readonly hold: boolean;
    /** 第一包：从未知位置移到起点。 */
    readonly entry?: true;
    /** 一次往返的最后一包。 */
    readonly cycleEnd?: true;
}
/** 传输方式对速度的量化：给定想要的速度，返回设备实际会用的速度（不大于输入）。Buttplug 不量化。 */
export interface MotionProfile {
    readonly quantize?: (speed: number) => number;
}
/**
 * 右栏的本场实际参数，只存在内存里；未指定的项跟随 AI。
 * 最终仍按总设置的行程和速度上限截断。
 */
export interface LiveAdjust {
    readonly bounds?: readonly [number, number];
    readonly speed?: number;
}
export declare const NO_ADJUST: LiveAdjust;
export interface LiveMotion {
    readonly bounds: readonly [number, number];
    /** 目标速度（unit/s），实际轨迹仍受进入限速、升速及设备精度约束。 */
    readonly speed: number;
}
/** 用户选定的实际窗口按总行程截断，至少留一格；未手动选择时使用 AI 范围。 */
export declare function adjustBounds(bounds: readonly [number, number], config: MotionConfig, adjust?: LiveAdjust): readonly [number, number];
/** 界面与执行共用的实际参数；停止时以全行程／慢档为初值，读取不发包。 */
export declare function liveMotion(intent: Intent | null, config: MotionConfig, adjust?: LiveAdjust): LiveMotion;
/** 实际坐标向内取整，不扩大 AI 选的范围。 */
export declare function outputBounds(intent: Intent, config: MotionConfig): readonly [number, number];
/** 手动定位的慢速：慢档下限附近，不超过总设置的速度上限。 */
export declare function gentleSpeed(config: MotionConfig): number;
/** 手动定位：0–100 映射到总设置的行程内。 */
export declare function manualPosition(value: number, config: MotionConfig): number;
/**
 * 手动定位：以慢速移到 target 后停住（之后只有等待包）。from 是上一包已走完的位置；未知时按 0–100 全程最坏距离限速。
 */
export declare function manualPackets(target: number, config: MotionConfig, profile?: MotionProfile, from?: number): Generator<Packet, never, undefined>;
