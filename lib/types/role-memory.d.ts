/**
 * 跨会话的角色记忆：每个角色一份，存在 `<数据目录>/memories/<角色 id>.json`，不写进角色卡，
 * 编辑器保存角色时不会覆盖它。格式见 memory-format.ts，设计见 docs/architecture.md 第 6 节。
 */
import { type Warn } from './storage.ts';
/**
 * 角色记忆的读写。每次现读文件：读的地方只有取快照、编辑器和整理，次数很少，
 * 用户直接改了文件也能马上生效。dir 为空时只存在内存里（测试用）。
 */
export declare class MemoryStore {
    readonly dir: string | undefined;
    private readonly warn;
    private readonly memory;
    /** 已经警告过的坏文件内容，同样的内容不重复警告。 */
    private readonly warned;
    constructor(dir: string | undefined, warn: Warn);
    /** 释放旧资料副本，后续现读磁盘。 */
    clearCache(): void;
    static at(dataDir: string, warn: Warn): MemoryStore;
    /** 角色记忆的当前文本；没有记忆时为空串。 */
    text(roleId: string): string;
    revision(roleId: string): number;
    /** 会话已整理到第几轮；没整理过时为 undefined。 */
    consolidatedTurn(roleId: string, sessionId: string): number | undefined;
    /** 用户手动修改。格式不对抛 MemoryFormatError；内容没变时不写盘。返回规范化后的文本。 */
    save(roleId: string, text: string): string;
    /**
     * 写回一次整理的结果，并记下会话整理到的轮次。revision 和整理开始时不同（期间用户改过或另一次整理写过）时
     * 不写，返回 false。text 为 undefined 表示这次没有可用结果（超长等），只推进轮次，避免同一段内容反复整理。
     */
    commitConsolidation(roleId: string, expectedRevision: number, sessionId: string, turn: number, text: string | undefined): boolean;
    /** 删角色时把记忆一起移进回收站，和角色卡用同一个时间戳。 */
    trash(roleId: string, trashDir: string, stamp: string): void;
    /** 手写角色卡的 id 可能含路径字符，这时文件名用 id 的散列。 */
    private file;
    private load;
    private commit;
}
