import { type HistoryCut } from './history.ts';
export declare class DynamicsSelections {
    private readonly file;
    constructor(file: string);
    private load;
    private save;
    has(sessionId: string): boolean;
    /** Copy all necessary prefixes to the child so later forks need no parent. */
    inherit(cut: HistoryCut, parent: HistoryCut): string | null | undefined;
    current(cut: HistoryCut): string | null | undefined;
    /** All historically selected roles still verifiable in this branch's cut. */
    roles(cut: HistoryCut): string[];
    record(cut: HistoryCut, role: string | null, start?: boolean): void;
    seal(cut: HistoryCut): void;
}
