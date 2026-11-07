import type { Context } from '@deepseek-ai/cordis';
import type { QqbotData } from './content.ts';
/** 历史回复按当轮角色取图库；最早记录之前的身份未知时不借用后来的角色。 */
export declare function memeRoleAt(data: QqbotData, session: string, turn?: number): import("./roles.ts").Role | undefined;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
