/**
 * 角色和破限预设编辑接口：GET `/api/qqbot/library` 读全部，POST 提交一个操作。
 * 改动写进 `<DSH_HOME>/qqbot/`，下一轮组装时生效；所有会话都按 id 现读，不需要通知。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { QqbotData } from './content.ts';
import { type LibraryView } from './library-types.ts';
import type { UiStore } from './ui.ts';
export declare const name = "qqbot-library";
/** 编辑界面需要的全部数据。顺带重新扫描角色库，用户直接改过的文件由此生效。 */
export declare function libraryView(data: QqbotData, saved?: string, features?: LibraryView['features']): LibraryView;
/** 请求格式不对，和"操作本身失败"区分开。 */
export declare class BadRequest extends Error {
}
/**
 * 执行一个操作。格式错误抛 BadRequest，操作失败（重名、找不到、写不了盘）抛 Error。
 * 保存角色或预设时返回保存的 id。
 */
export declare function applyLibraryAction(data: QqbotData, body: unknown, ui?: UiStore): string | undefined | Promise<string | undefined>;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
