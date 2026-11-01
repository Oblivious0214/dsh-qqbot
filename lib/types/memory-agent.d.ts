/**
 * qqbot 预设内的角色记忆插件，由 dsh-qqbot/prompt 加载，每个 qqbot 会话一份，标准会话没有。
 * 把本会话登记给 host 层的 `ctx.qqbot.memory`，并负责两种触发：
 * - 空闲：AI 回复完 IDLE_MS 内没有新消息；
 * - 开新会话：新建时让同一角色其他还开着的会话先整理。
 * 压缩触发在 dsh-qqbot/compaction，手动触发在角色编辑接口。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "qqbot-memory";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
