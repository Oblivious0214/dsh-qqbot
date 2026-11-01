/** 分段显示的计时；数值不进入提示词。 */
/** 字数：中文按字，纯英文每词折合 2 字。 */
export declare function textUnits(text: string): number;
/** 普通聊天的打字速度：对方“想一下”的停顿 + 打下一段每个字的耗时，限制在上限内。 */
export declare const TYPING_SPEEDS: readonly ["fast", "normal", "slow"];
export type TypingSpeed = typeof TYPING_SPEEDS[number];
export declare const TYPING_SPEED_LABELS: Record<TypingSpeed, string>;
/**
 * 下一段出现前的等待：按下一段的字数估算打字时间。
 * @param random 0–1 的随机数，测试时传固定值。
 */
export declare function typingDelay(next: string, speed: TypingSpeed, random?: () => number): number;
/** 读完一段大约要多久（毫秒），按每秒 6 字。 */
export declare function readingMs(text: string): number;
