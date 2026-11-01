/** Shared wire contract; runtime activation is deliberately never persisted. */
export declare const AUTO_REPLY_PATH = "/api/qqbot/auto-reply";
export declare const AUTO_REPLY_SOURCE = "qqbot-auto-reply";
export declare const DEFAULT_OPTIONS: {
    readonly waitSeconds: 120;
    readonly maxReplies: 6;
};
export declare const AUTO_REPLY_PROMPT_LIMIT = 6000;
export declare const QUICK_REPLY_PROMPT_LIMIT = 6000;
export interface AutoReplyOptions {
    waitSeconds: number;
    maxReplies: number;
}
export interface AutoReplyView {
    enabled: boolean;
    count: number;
    remainingSeconds: number | null;
    status: 'off' | 'waiting' | 'busy' | 'input' | 'limit' | 'stopped';
    message: string;
}
export declare function parseOptions(value: unknown): AutoReplyOptions;
/** Appended as an attributed notice, never inserted into a system prefix. */
export { AUTO_REPLY_TEXT } from './prompts.ts';
export type QuickReplyClickMode = 'send' | 'draft';
export declare const DEFAULT_QUICK_REPLY_CLICK_MODE: QuickReplyClickMode;
export interface QuickReplyView {
    enabled: boolean;
    clickMode?: QuickReplyClickMode;
}
export interface AutoReplyPromptView {
    prompt: string;
    defaultPrompt: string;
}
