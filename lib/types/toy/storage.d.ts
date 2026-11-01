/**
 * 数据目录和 JSON 读写。数据放在 `<DSH_HOME>/toy-buttplug/`。
 * 写法和 dsh-qqbot 的 storage.ts 相同：同步 I/O，先写临时文件再改名。
 */
/** DSH 的数据根目录。空的 DSH_HOME 视为未设置。 */
export declare function dshHome(): string;
export declare function dataDir(home?: string): string;
export type Warn = (message: string) => void;
/** 读 JSON。不存在时返回 undefined；坏文件改名为 `.corrupt` 留给用户检查。 */
export declare function readJson(file: string, warn: Warn): unknown;
export declare function writeJson(file: string, value: unknown): void;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
