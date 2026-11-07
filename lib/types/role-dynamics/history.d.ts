/** Complete immutable sessionQuery cut. seq is the next sequence, not the last event. */
export interface HistoryEvent {
    seq: number;
    type: string;
    data: Record<string, unknown>;
    sourceEventSeqs?: number[];
    [metadata: string]: unknown;
}
export interface HistoryCut {
    header: {
        id: string;
        isSeeded?: boolean;
        parentSession?: string;
    };
    inheritedEventCount: number;
    seq: number;
    events: HistoryEvent[];
}
export interface HistoryView {
    capture(sessionId: string): HistoryCut;
    /** Must flush the host and return a cut read from its durable log. */
    flush(sessionId: string): Promise<HistoryCut>;
}
export interface Anchor {
    sessionId: string;
    seq: number;
    phase: 'before' | 'after';
    prefix: string;
    nextPrefix?: string;
}
export declare function canonical(value: unknown): string;
export declare const digest: (value: unknown) => string;
export declare function prefixes(cut: HistoryCut): string[];
export declare function anchor(cut: HistoryCut, phase: Anchor['phase'], seq?: number): Anchor;
export declare function matches(position: Anchor, cut: HistoryCut, includeTail: boolean): boolean;
export declare function turnEnd(cut: HistoryCut, startSeq: number): HistoryEvent | undefined;
export declare function completed(cut: HistoryCut, startSeq: number): HistoryEvent | undefined;
export declare function successfulCall(cut: HistoryCut, startSeq: number, callSeq: number, callId: string): boolean;
/** rc.5 Native root and PTC sub-dispatch identities are both real host events. */
export declare function validStateCall(cut: HistoryCut, startSeq: number, call: HistoryEvent, callId: string): boolean;
