import { type MotionConfig } from './config.ts';
export interface SafetyWords {
    readonly enabled: boolean;
    readonly words: readonly string[];
}
export declare const DEFAULT_SAFETY_WORDS: SafetyWords;
export declare const MAX_SAFETY_WORDS = 20;
export declare const MAX_SAFETY_WORD_LENGTH = 40;
export declare function parseSafetyWords(value: unknown): SafetyWords;
/** 高→中、中→低；低档内再降 20%，始终不高于当前速度。 */
export declare function slowerSpeed(speed: number, config: MotionConfig): number;
