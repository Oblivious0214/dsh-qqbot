/** 可执行适配：仅由现有 MotionPlayer 拉取；本模块没有设备连接或计时器。 */
import { type MotionConfig } from '../core/config.ts';
import { type LiveAdjust, type MotionProfile, type Packet } from '../core/motion.ts';
import type { Intent } from '../core/intent.ts';
import type { MotionClip } from './library.ts';
export interface PlaybackCursor {
    readonly sourceMs: number;
    readonly pass: number;
    readonly completed: boolean;
}
export declare class PresetPlayback {
    readonly name: string;
    private readonly steps;
    private readonly looping;
    /** 仅用于旧 v1 once 的 AI 兼容重播。 */
    private repeating;
    private index;
    private pass;
    private readonly endMs;
    /** 循环时回到的步序号：片段写了 loopFromMs 就从那里循环，否则从头。 */
    private loopIndex;
    private offset;
    private entering;
    private readonly quantize;
    private readonly cap;
    private readonly start;
    /** clip 由调用方从动作池选定（见 selectAction）；intent 只提供范围和速度档。 */
    constructor(intent: Intent, config: MotionConfig, clip: MotionClip, profile: MotionProfile, adjust?: LiveAdjust, cursor?: PlaybackCursor);
    cursor(): PlaybackCursor;
    /** 完整走一遍的时长（不含进入包），按该档速度算，不含升速；有循环起点时也按整条轨迹算。 */
    get passMs(): number;
    /** 第二遍起每遍的时长：有循环起点时只算从起点到终点。 */
    get loopPassMs(): number;
    /** 单次动作播完从头再播，直到换选择或停止；循环动作本来就一直循环。 */
    repeat(): void;
    /** 暂停只重做限速进入；已完成和已耗时的轨迹保留。 */
    reenter(): void;
    next(lastSpeed?: number, lastDurationMs?: number): Packet | undefined;
    /** 消费实际运行时间；暂停时可提交半包进度，进入包不消耗源轨迹。 */
    consume(packet: Packet, elapsedMs: number): void;
}
