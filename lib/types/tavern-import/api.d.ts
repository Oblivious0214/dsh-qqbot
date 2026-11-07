/** 第 06 步由根入口显式挂载；此模块不自动接入聊天或界面。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Maintenance } from '../maintenance.ts';
import { TavernImportStore, type ImportData } from './store.ts';
import { type ExtractInput, type Selection } from './types.ts';
export declare function createImportHandler(getStore: () => TavernImportStore, available?: () => boolean): (request: Request) => Promise<Response>;
/** 本地直接采用亦可被界面调用；不依赖模型。 */
export declare function directBody(input: ExtractInput, selections: Selection[]): string;
export declare function registerTavernImport(ctx: Context, data: ImportData, maintenance: Maintenance): void;
