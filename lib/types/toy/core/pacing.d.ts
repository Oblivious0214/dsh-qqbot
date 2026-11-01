/**
 * 设备在动时的段落停留时间。只改显示节奏，不进提示词。
 * 这一段换了新动作：停满“节奏”秒数，让用户感受完整个动作；
 * 动作没变的接续段：只停到读完（至少 CONTINUE_MIN_MS），不超过节奏秒数。
 * 设备停着或普通聊天时不用这里，仍按 qqbot 的打字节奏。
 */
export interface MotionPacing {
    /** 新动作段落停留的秒数。 */
    readonly seconds: number;
}
export declare const DEFAULT_PACING: MotionPacing;
export declare const PACING_SECONDS: {
    readonly min: 1;
    readonly max: 120;
};
/** 旧版本保存的 min/max/speed 没有 seconds，按默认处理。 */
export declare function parsePacing(value: unknown): MotionPacing;
/** 等待毫秒数。fresh：这一段写了新动作。 */
export declare function pacingHold(text: string, fresh: boolean, pacing: MotionPacing): number;
