/** Synchronous final commit is intentional: maintenance cannot interleave with rename. */
export interface JournalStore {
    load(roleId: string): unknown | undefined;
    save(roleId: string, journal: unknown, guard: () => void): void;
    detach(roleId: string, stamp: string, guard: () => void): void;
    restore(roleId: string, stamp: string, guard: () => void): void;
}
export type StoreStage = 'temporary' | 'rename' | 'directory-sync';
export declare class FileJournalStore implements JournalStore {
    private readonly fault;
    private readonly root;
    constructor(root: string, fault?: (stage: StoreStage) => void);
    private check;
    private directory;
    private file;
    load(roleId: string): unknown | undefined;
    save(roleId: string, journal: unknown, guard: () => void): void;
    detach(roleId: string, stamp: string, guard: () => void): void;
    restore(roleId: string, stamp: string, guard: () => void): void;
}
