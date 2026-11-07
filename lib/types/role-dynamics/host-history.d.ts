/** rc.5 public sessionQuery observations; no writes to the host log. */
import { type HistoryCut, type HistoryEvent, type HistoryView } from './history.ts';
export interface HostSession {
    readonly id: string;
    readonly seq: number;
    readonly header: HistoryCut['header'];
}
interface Observation {
    readonly header: HistoryCut['header'];
    readonly inheritedEventCount: number;
    readonly events: readonly HistoryEvent[];
    readonly cursor: number;
    [Symbol.dispose](): void;
}
export interface HistoryHost {
    sessionQuery: {
        observeSession(id: string, options: {
            projections: 'none';
        }): Promise<Observation>;
    };
    sessions: {
        get(id: string): HostSession | undefined;
        flush(session: HostSession): Promise<boolean>;
    };
}
export declare class HostHistoryView implements HistoryView {
    private readonly host;
    private readonly cuts;
    private readonly publications;
    private disposed;
    constructor(host: () => HistoryHost);
    /** The caller subscribes before the first asynchronous observation. */
    observe(session: HostSession, event: HistoryEvent): void;
    prepare(id: string, ancestors?: Set<string>, inherit?: boolean): Promise<void>;
    capture(id: string): HistoryCut;
    flush(id: string): Promise<HistoryCut>;
    clear(): void;
    dispose(): void;
}
export {};
