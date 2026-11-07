import { JailbreakStore } from '../presets.ts';
import { RoleLibrary } from '../roles.ts';
import { type ImportPayload, type Preview, type SavedImport } from './types.ts';
export interface ImportData {
    roles: RoleLibrary;
    presets: JailbreakStore;
}
/** 仅供故障注入；生产调用不需要传。异常模拟崩溃时不运行回滚。 */
export declare class InterruptedImport extends Error {
}
export interface StoreOptions {
    checkpoint?: (point: string) => void;
    warn?: (message: string) => void;
}
export declare class TavernImportStore {
    private readonly data;
    private readonly options;
    private readonly secret;
    private readonly root;
    private readonly backups;
    private disposed;
    constructor(data: ImportData, options?: StoreOptions);
    dispose(): void;
    /** 清理全部数据／插件停用后旧 token 失效；创建新的 store 代次。 */
    private available;
    private checkpoint;
    private diskPreset;
    private state;
    /** 每一级拒绝联接，所有目标都是内部生成的相对路径。 */
    private path;
    private revision;
    private prepare;
    private signature;
    preview(payload: ImportPayload): Preview;
    commit(payload: ImportPayload, preview: Preview): SavedImport;
    private newId;
    private transactions;
    private rollback;
    recover(): void;
}
