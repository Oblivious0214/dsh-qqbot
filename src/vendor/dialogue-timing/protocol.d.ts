/**
 * voice: explicit speech choice; absent means text.
 * tone: short delivery description for the voice service, already cleaned by toneOf.
 * salvaged: recovered text, never has voice, tone or motion.
 */
export interface TimedStage { text: string; voice?: true; tone?: string; motion?: unknown; salvaged?: true }
export const TONE_LIMIT: number;
/** Cleans a model-written tone: no brackets or line breaks, at most TONE_LIMIT characters; '' when unusable. */
export function toneOf(value: unknown): string;
export interface TimedReply { version: 1; stages: TimedStage[] }
/** complete: [/qq] has arrived. Otherwise only the closed stages so far. */
export interface TimedStream { stages: TimedStage[]; complete: boolean }
export const SEGMENT_PROMPT: string;
/** Rewrites drifted tag variants (<qq>, 【qq】, ［/QQ］…) to [qq] / [/qq]. */
export function normalizeTags(text: string): string;
export function proseOnly(text: string): string;
/** The reply holds, or is starting, a [qq] block (any tolerated form). */
export function hasTimedBlock(text: string): boolean;
export function parseTimedReply(text: string): TimedReply | null;
export function parseTimedStream(text: string): TimedStream | null;
/** A finished reply: an open block counts as closed; always complete when not null. */
export function parseFinishedReply(text: string): TimedStream | null;
export function salvageTimedReply(text: string): TimedReply | null;
export function stripTimedReply(text: string): string;
