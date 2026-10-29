export interface TimedStage { text: string; durationMs?: number; motion?: unknown }
export interface TimedReply { version: 1; stages: TimedStage[] }
export const SEGMENT_PROMPT: string;
export function proseOnly(text: string): string;
export function parseTimedReply(text: string): TimedReply | null;
export function stripTimedReply(text: string): string;
