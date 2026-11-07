import { type MemeFrequency, type MemePreferences, type MotionAction, type MotionRange, type RoleProactivity, type RoleProactivityTexts } from './library-types.ts';
import type { RoleDynamicsConfig } from './role-dynamics/types.ts';
export declare const ROLE_ID_PATTERN: RegExp;
export declare const isMemeFrequency: (value: unknown) => value is MemeFrequency;
export declare const isRoleProactivity: (value: unknown) => value is RoleProactivity;
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
    readonly dynamics?: RoleDynamicsConfig | null;
    readonly dynamicsBaseRevision?: string;
    readonly resetDynamics?: boolean;
    readonly dynamicsRenames?: Readonly<Record<string, string>>;
}
/** 校验编辑界面提交的角色；不合规时抛出可以直接展示给用户的错误。 */
export declare function validateRoleDraft(value: unknown): RoleDraft;
/** 偏好动作名：去重、保留顺序、最多 MOTION_ACTION_LIMIT 个；strict 时不合规的名称报错，否则丢掉。空列表当作没写。 */
export declare function actionNames(values: readonly unknown[] | undefined, strict: boolean): string[] | undefined;
