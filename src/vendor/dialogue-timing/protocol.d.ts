export interface TimedStage { text: string; durationMs?: number; cycles?: number; motion?: unknown }
export interface TimedReply { version: 1; stages: TimedStage[] }
/** complete: [/qq] has arrived. Otherwise only the closed stages so far. */
export interface TimedStream { stages: TimedStage[]; complete: boolean }
export const SEGMENT_PROMPT: string;
export function proseOnly(text: string): string;
export function parseTimedReply(text: string): TimedReply | null;
export function parseTimedStream(text: string): TimedStream | null;
export function stripTimedReply(text: string): string;
