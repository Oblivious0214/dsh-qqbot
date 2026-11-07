import { type Warn } from '../storage.ts';
import { type ActionLibrary } from './config.ts';
/** 单个配置索引原子切换；轨迹按内容生成文件名且写入后不再修改。 */
export declare class ActionLibraryStore {
    private readonly file;
    private readonly warn;
    private current;
    private diskText;
    private lastGoodText;
    private lastGood;
    private loadFailed;
    private readonly tracks;
    constructor(file: string, warn: Warn);
    static at(dir: string, warn: Warn): ActionLibraryStore;
    get value(): ActionLibrary;
    /** 全部清理由宿主先删除 toy 数据域，再重新写入内置库。 */
    reset(): void;
    save(value: unknown): ActionLibrary;
    private readIndex;
    private decode;
    private recover;
    private commit;
    private collectTracks;
}
