/**
 * 右栏“高潮”流程投递给 AI 的消息（用户 2026-11-01 要求）。
 * 设备由程序按高潮设置运行，消息只让 AI 用角色口吻配合流程出字：
 * 按下时投“高潮”，只写高潮过程；刺激结束转入温存时再投“温存”，单独写事后温存。
 * 段数按阶段秒数估算，时间越长写得越多。两条文本用户可在高潮设置里改写，{秒数}、{段数} 发送时填入。
 * 作为带来源标记的历史消息追加，不改 section，不影响前缀缓存。
 */
import type { BurstSettings } from './api-types.ts';
export declare const CLIMAX_SOURCE = "qqbot-toy-climax";
export declare const CLIMAX_SUMMARY = "\u9AD8\u6F6E";
export declare const AFTERCARE_SUMMARY = "\u6E29\u5B58";
export declare const CLIMAX_PROMPT_KEYS: readonly ["climax", "aftercare"];
export type ClimaxPromptKey = typeof CLIMAX_PROMPT_KEYS[number];
/** 用户改写过的通知；没改的不出现，用内置默认。 */
export type ClimaxPrompts = Partial<Record<ClimaxPromptKey, string>>;
export declare const MAX_CLIMAX_PROMPT_LENGTH = 2000;
export declare const CLIMAX_PLACEHOLDERS: readonly ["{秒数}", "{段数}"];
export declare const DEFAULT_CLIMAX_PROMPTS: Readonly<Record<ClimaxPromptKey, string>>;
/** 这一阶段大约写几段：高潮期间段落按普通打字节奏显示，每段约 2–4 秒。 */
export declare function stageCount(seconds: number, perStage: number, min: number, max: number): number;
/** 按下高潮时的消息正文。 */
export declare function climaxText(settings: BurstSettings, prompts?: ClimaxPrompts): string;
/** 刺激结束、转入温存时的消息正文。 */
export declare function aftercareText(settings: BurstSettings, prompts?: ClimaxPrompts): string;
