/**
 * dsh-qqbot 的数据目录和 JSON 读写。数据放在 `<DSH_HOME>/qqbot/`，不和旧插件共用文件。
 * 用同步 I/O：文件都很小，读只在启动和用户命令时发生；提示词组装是同步的，不能等异步加载。
 */
/** DSH 的数据根目录。空的 DSH_HOME 视为未设置，否则路径会相对于进程工作目录。 */
export declare function dshHome(): string;
/** 本插件的数据目录：`<DSH_HOME>/qqbot`。 */
export declare function dataDir(home?: string): string;
export type Warn = (message: string) => void;
/**
 * 读一个 JSON 文件。不存在时返回 undefined；读不了或格式错时警告，
 * 坏文件改名为 `.corrupt` 留给用户检查，下次写入从空状态开始。
 */
export declare function readJson(file: string, warn: Warn): unknown;
export declare function writeJson(file: string, value: unknown): void;
/** 写到同目录的临时文件再改名，读者不会看到写了一半的文件。 */
export declare function writeText(file: string, text: string): void;
/** Windows 上目标文件被杀毒或编辑器短暂占用时 rename 会报 EPERM/EACCES/EBUSY，稍等重试几次。 */
export declare function renameWithRetry(from: string, to: string): void;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
