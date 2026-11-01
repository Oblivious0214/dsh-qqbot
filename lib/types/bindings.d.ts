/**
 * 会话和角色的绑定：`<数据目录>/sessions.json`。
 *
 * 一个会话有三种状态：没有记录（还没开始，或从没用过角色库）、绑定了某个角色、主动选了"不用角色"（null）。
 * 没有记录的会话第一次真实组装时取新会话默认角色并写下来，之后改默认角色不影响已有会话。
 * 不按时间清理记录：长期使用的会话不能丢角色，每条记录只有几十字节。
 *
 * 每个会话还记着各轮用的角色（`turns`），只在换人时追加一条，供界面按消息显示头像。不进提示词。
 * `memory` 是各角色在本会话第一次出场时的记忆快照，整个会话都用它，重新打开旧会话也不变（docs/architecture.md 第 6 节）。
 */
import { type Warn } from './storage.ts';
/** 会话主动选了不用角色。和"没有记录"不同：默认角色不能接管它。 */
export declare const NO_ROLE: null;
export type RoleChoice = string | typeof NO_ROLE;
/** 从 turn 这一轮起用 role，直到下一条。role 是当时组装用的角色 id，没有角色时为 null。 */
export interface TurnRole {
    readonly turn: number;
    readonly role: string | null;
}
export declare class SessionBindings {
    private readonly file;
    private readonly warn;
    private readonly now;
    private state;
    constructor(file: string | undefined, warn: Warn, now?: () => Date);
    /** 从磁盘重新读取；清理后不保留旧会话绑定。 */
    reload(): void;
    static at(dir: string, warn: Warn): SessionBindings;
    /** 会话的选择；没有记录时为 undefined。 */
    get(sessionId: string): RoleChoice | undefined;
    /** 记下会话的选择；值没变时不写盘。 */
    set(sessionId: string, role: RoleChoice): void;
    /** 会话各轮用的角色，按轮次升序；没有记录时为空。 */
    turnsOf(sessionId: string): readonly TurnRole[];
    /**
     * 记下第 turn 轮用的角色。和上一条相同时不写盘，所以每轮调用也只在换人时写。
     * 比 turn 晚的记录是撤回或重新生成前的旧轮次，一起去掉。会话还没有选择记录时不记。
     */
    recordTurn(sessionId: string, turn: number, role: string | null): void;
    /** 会话里这个角色的记忆快照；还没取过时为 undefined。 */
    memorySnapshot(sessionId: string, roleId: string): string | undefined;
    /** 记下快照。已经有了不覆盖；会话还没有选择记录时不记。 */
    setMemorySnapshot(sessionId: string, roleId: string, text: string): void;
    /** 有记录的全部会话 id。 */
    sessionIds(): readonly string[];
    /** 把新版记忆应用到这个会话时覆盖快照。会话还没有选择记录或内容相同时不写。 */
    replaceMemorySnapshot(sessionId: string, roleId: string, text: string): void;
    get defaultRole(): string | undefined;
    setDefaultRole(role: string | undefined): void;
    private commitSession;
    private commit;
    private load;
}
