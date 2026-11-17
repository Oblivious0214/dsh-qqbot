/**
 * 运动播放器：按 dsh-qqbot 的显示时钟驱动设备。qqbot 每显示一段就调用 reveal()，
 * 播放器在后台按当前选择循环发包，自己不决定文字什么时候出现。
 *
 * 程序层停止都在这里（CLAUDE.md"急停只能由程序执行"）：
 * - stop()：退出联动、出错等都走它，立即停止并清掉当前选择（暂停按钮和快捷键走 pause()）；
 * - 看门狗：每段显示后，在预定间隔加 5 秒余量内没等到下一段就停止；最后一段按用户设置停止或转入待机；
 * - 设备断开、发送出错时停止；
 * - 换选择或改限制时从未知位置限速重新进入（轨迹的进入包）。
 * - 换到更快的选择时从上一包的速度按 RAMP_UP 升速；停止、暂停、改限制之后从慢档起步。
 *
 * 节奏循环迁移自 dsh-serveu 的 live-player.js（LivePlayer.pump/setMotion），显示计时部分已移到 dsh-qqbot。
 */
import { type MotionConfig } from '../core/config.ts';
import type { BurstSpeed } from '../api-types.ts';
import { type Intent } from '../core/intent.ts';
import { type LiveAdjust } from '../core/motion.ts';
import type { Transport } from './transport.ts';
import type { ActionLibrary } from '../motion-library/config.ts';
export type StopCause = 'user' | 'model' | 'timeout' | 'disconnected' | 'error' | 'stop-error' | 'complete' | 'burst-end' | 'aftercare-end';
/** 用户在右栏发起、由程序直接驱动的动作；AI 的段落不能改写它。 */
export type ProgramKind = 'manual' | 'burst' | 'aftercare' | 'standby';
export interface Clock {
    now(): number;
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}
export declare const realClock: Clock;
export interface PlayerEvents {
    /** 播放已停止或发生停止请求错误；error / stop-error 携带具体错误。 */
    readonly onStop?: (cause: StopCause, error?: Error) => void;
    /** 在发送停止前取得失败回调，便于调用方绑定当时的会话，避免迟到错误归到新会话。 */
    readonly stopFailureHandler?: () => (error: Error) => void;
}
export declare class MotionPlayer {
    private readonly transport;
    private readonly events;
    private readonly clock;
    /** 当前选择；null 表示静止。 */
    intent: Intent | null;
    paused: boolean;
    private config;
    private library;
    private preset;
    /** 仅新选择抽取；后续使用不可变片段快照。 */
    private presetSeed;
    private selectedClip;
    private completedIntent;
    private remapPending;
    private replacement;
    get completed(): boolean;
    get sourceCursor(): import("../motion-library/playback.ts").PlaybackCursor | undefined;
    private sameSelection;
    isCompletedSelection(intent: Intent): boolean;
    /** 抽到或点名的动作名。 */
    private chosenName;
    private requestedAction;
    private adjust;
    private speedLimit;
    /** 安全词的临时速度上限；不重启轨迹、不延长计时。 */
    setSpeedLimit(speed: number | undefined): void;
    get targetSpeed(): number;
    private program;
    /** 高潮／温存所用速度（档位上限或自己填的速度），只供显示和安全词降速参考。 */
    private programSpeed;
    /** 上一包走完后的位置；停止后未知。 */
    private lastPosition;
    get mode(): ProgramKind | 'ai';
    /** 最近一包发出的目标位置，只供界面显示（没有位置反馈）。 */
    lastTarget: number | undefined;
    private displayMove;
    /** 无硬件反馈；按当前发包的运动时长推算，仅供界面显示。 */
    get displayPosition(): number | undefined;
    /** 最近一次停止前由谁驱动，供停止回调区分原因。 */
    endedMode: ProgramKind | 'ai';
    private scriptTick;
    private lastDuration;
    get presetName(): string | undefined;
    private generator;
    /** 上一包实际发出的速度，换选择时作为起步速度；停下后清空，再启动从慢档起步。 */
    private lastSpeed;
    /** 每次停止、换选择、改限制加一，作废还在路上的发包结果。 */
    private epoch;
    private motionTimer;
    private pending;
    /** pump 正在等上一次停止完成。 */
    private waiting;
    /** 上一次停止的 Promise；新的发包要等它完成。 */
    private barrier;
    private watchdog;
    private deadline;
    /** 暂停时看门狗还剩多久。 */
    private remaining;
    private tail;
    private readonly unsubscribe;
    constructor(transport: Transport, events?: PlayerEvents, clock?: Clock);
    private autoStopMs;
    /** 设置用户允许的限制。变化时正在运行的选择从未知位置重新进入。 */
    configure(config: MotionConfig): void;
    /** 动作库变化时，AI 选的动作停止；用户在右栏发起的动作不受影响。 */
    configureLibrary(library: ActionLibrary | undefined): void;
    /** 按选择取播放源：名称在该档动作池里就用它，否则（含 auto）按权重抽一个。 */
    private sourceFor;
    /** 仅在旧包已消费、或 halt 已提交半包后读取游标。 */
    private applyPending;
    private remapSource;
    /**
     * qqbot 显示了一段。
     * @param intent 这一段的动作：选择、null（停止）或 undefined（不变），见 resolveStageIntents。
     * @param holdMs 到下一段预计还要多久；最后一段传 undefined，按自动停止设置计时。
     */
    reveal(intent: Intent | null | undefined, holdMs: number | undefined): void;
    /** 暂停：设备停下，选择和看门狗剩余时间保留，resume() 后从未知位置重新进入。 */
    pause(): void;
    resume(): void;
    /** 只读现有看门狗；显示代码不能重设安全超时。 */
    remainingMs(): number | undefined;
    /** 立即停止并清掉选择；模型停止保留用户暂停，后续选择等显式继续。 */
    stop(cause: StopCause, error?: Error): void;
    dispose(): void;
    private setIntent;
    /** 建好当前选择的轨迹；暂停恢复时沿用原进度。出错时停止。 */
    private choose;
    private start;
    private endCause;
    /** 换上播放源；出错时停止。返回是否可以继续发包。 */
    private useSource;
    private idle;
    /** 本场快调。运行中的动作等当前一包走完后按新偏移接上；手动定位和温存不受影响。 */
    setAdjust(adjust: LiveAdjust): void;
    /** 手动定位：打断当前动作，慢速移到 position（已在总设置行程内）后停住。暂停中不执行。 */
    moveTo(position: number): void;
    /**
     * 高潮刺激：从独立动作池随机选，按设置的速度档（或自己填的速度）播放；单次动作播完换下一个。
     * 本场快调手动调过速度时以快调为准。
     */
    burst(library: ActionLibrary | undefined, durationMs: number, speed?: BurstSpeed): void;
    /** 温存：从温存动作池随机选，用最低可用速度档、靠龟头的浅行程播放；单次动作播完换下一个。 */
    aftercare(library: ActionLibrary | undefined, durationMs: number): void;
    private presetProgram;
    private startProgram;
    /** 停下设备、作废所有在路上的发包；不改 intent。 */
    private halt;
    private arm;
    private expire;
    private startStandby;
    private clearWatchdog;
    private pump;
}
