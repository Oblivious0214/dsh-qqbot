/**
 * `/role` 命令。由 dsh-qqbot/prompt 在 qqbot 预设内加载，命令因此只在 qqbot 会话里出现。
 * 命令输入和输出都不进模型请求；切换后下一轮组装时角色正文和 `qqbot:runtime` 的 role 行随之更新。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { QqbotData } from './content.ts';
import type { QqbotSession } from './registry.ts';
export declare const name = "qqbot-role-command";
export declare const inject: string[];
/** 当前会话的状态：角色、破限预设、新会话默认角色和角色列表。 */
export declare function overview(data: QqbotData, session: QqbotSession): string;
/** 执行一次 `/role`。纯逻辑，便于测试；写盘失败时抛出，由调用方转成错误结果。 */
export declare function runRole(data: QqbotData, session: QqbotSession, rawInput: string, busy?: boolean): CommandResult;
export declare function apply(ctx: Context): void;
