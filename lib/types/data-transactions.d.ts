interface SavedPath {
    path: string;
    existed: boolean;
    checksum?: string;
    expected?: string;
}
interface Manifest {
    version: 1;
    stamp: string;
    state: 'prepared' | 'committed' | 'rolled-back';
    paths: SavedPath[];
    metadata: unknown;
}
export type TransactionFault = (stage: 'prepared' | 'changed' | 'commit' | 'committed' | 'rollback') => void;
export declare function inside(root: string, path: string): string;
export declare class FileDataTransaction {
    private readonly root;
    readonly manifest: Manifest;
    private readonly fault;
    readonly dir: string;
    private constructor();
    static prepare(root: string, domain: string, paths: readonly string[], metadata: unknown, fault?: TransactionFault): FileDataTransaction;
    private persist;
    /** ROLE.md 的唯一预期新字节，防止失败恢复覆盖等待期间的外部手写修改。 */
    expectFile(path: string, text: string, newDirectory?: boolean): void;
    changed(): void;
    commit(): void;
    get committed(): boolean;
    rollback(): void;
    static recover(root: string, domain: string): void;
}
export {};
