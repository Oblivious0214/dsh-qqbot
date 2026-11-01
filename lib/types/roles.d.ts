/**
 * 角色库：`<数据目录>/roles/` 下每个角色一个目录 `<id>/ROLE.md`，或单个文件 `<id>.md`。
 * 文件格式：frontmatter（id、name、description、memeFrequency、proactivity、motionActions、motionRanges、voice 等）+ 正文。格式参考 dsh-persona-switcher（MIT，yupaoa）。
 * id 是内部键（会话绑定、头像、预设选择都按它记），界面上不显示，也不让用户填：编辑器新建时自动生成，
 * 手写的文件不写 id 时用文件名。用户按名称认角色，所以编辑器保存时要求名称不重复。
 */
import { type MemeFrequency } from './format.ts';
import { type MotionAction, type MotionRange, type RoleProactivity } from './library-types.ts';
import { type Warn } from './storage.ts';
import type { MemePreferences } from './library-types.ts';
import type { RoleProactivityTexts } from './library-types.ts';
export interface Role extends MemePreferences {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** 角色正文，进入 `qqbot:persona`。 */
    readonly persona: string;
    /** 表情频率（`memeFrequency: low|medium|high|off`）；没写或写错时为空，用默认档。 */
    readonly memeFrequency?: MemeFrequency;
    /** 设备主动性上限（`proactivity: follow|situational|high`）；没写或写错时为空，表示不限。 */
    readonly proactivity?: RoleProactivity;
    readonly proactivityTexts?: RoleProactivityTexts;
    /** 偏好的设备动作和范围（`motionActions: slide, steady`）；不认识的值丢掉，全丢掉或没写时为空。 */
    readonly motionActions?: readonly MotionAction[];
    readonly motionRanges?: readonly MotionRange[];
    /** 音色（`voice: v-xxxxxxxx`，语音设置里音色的内部键）；没写或格式不对时为空，这个角色的回复显示文字。 */
    readonly voice?: string;
}
/** 接口和头像文件名接受的 id 格式。扫描时更宽松，手写的文件名不合规也能读到。 */
export declare const ROLE_ID_PATTERN: RegExp;
export declare function isRoleProactivity(value: unknown): value is RoleProactivity;
/** 解析一个角色文件；没有正文时返回 undefined。 */
export declare function parseRole(text: string, fallbackId: string): Role | undefined;
/** 角色库条目：目录里有 ROLE.md，或 `.md` 文件。返回 [条目名, 文件路径, 默认 id]。 */
export declare function roleEntries(dir: string): [entry: string, file: string, fallbackId: string][];
/** 编辑界面提交的角色内容。修改时带 id；新建时不带，由 save() 生成。 */
export interface RoleDraft extends MemePreferences {
    readonly id?: string;
    readonly name: string;
    readonly description: string;
    readonly persona: string;
    /** 为空表示用默认档，保存时去掉这一行。 */
    readonly memeFrequency?: MemeFrequency;
    /** 为空表示使用低自主性，保存时去掉这一行。 */
    readonly proactivity?: RoleProactivity;
    readonly proactivityTexts?: RoleProactivityTexts;
    /** 为空表示没有偏好，保存时去掉这一行。 */
    readonly motionActions?: readonly MotionAction[];
    readonly motionRanges?: readonly MotionRange[];
    /** 为空表示不用语音，保存时去掉这一行。 */
    readonly voice?: string;
}
/** 校验编辑界面提交的角色；不合规时抛出可以直接展示给用户的错误。 */
export declare function validateRoleDraft(value: unknown): RoleDraft;
/** 把编辑结果写成角色文件文本。existing 为原文件内容；新建时为空，id 写进 frontmatter，用户改目录名也不丢绑定。 */
export declare function renderRole(draft: RoleDraft & {
    readonly id: string;
}, existing: string | undefined): string;
export declare class RoleLibrary {
    readonly dir: string;
    private readonly warn;
    private roles;
    /** 角色 id → 文件路径。frontmatter 里的 id 可以和文件名不同，写回时按这里找文件。 */
    private files;
    constructor(dir: string, warn: Warn);
    /** 重新扫描目录。用户在文件里改了角色卡，下次 `/role` 时生效。 */
    reload(): void;
    /**
     * 新建或修改一个角色。新建时编辑器不带 id，生成一个没用过的；带了 id（测试等内部调用）时不能已存在。
     * 修改时 id 必须已存在。名称不能和别的角色重复。
     * 修改只换 name、description、memeFrequency、proactivity、motionActions、motionRanges、voice 和正文，frontmatter 其他字段保留。新建写成 `<id>/ROLE.md`。
     */
    save(value: unknown, create: boolean): Role;
    /** 新角色的 id：`r-` 加 8 位十六进制，避开已有的角色和同名的文件、目录（不覆盖读不出角色的手写文件）。 */
    private freshId;
    /** 按名称找角色，给 `/role <名称>` 用；名称重复（手写的文件）时取第一个。也认 id，兼容直接改文件的用户。 */
    find(nameOrId: string): Role | undefined;
    /**
     * 删除角色：移到 `<数据目录>/roles-trash/`，不真正删除文件，用户可以手动放回。
     * 目录形式的角色整个目录一起移走。alsoMove 用同一个时间戳把相关文件（头像）也移进回收站。
     */
    remove(id: string, alsoMove?: (trashDir: string, stamp: string) => void): void;
    get(id: string): Role | undefined;
    list(): Role[];
}
