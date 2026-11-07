import type { QqbotData } from './content.ts';
import { type ConfigPreview, type ConfigResult } from './config-types.ts';
export declare function previewConfiguration(data: QqbotData, value: unknown, options: unknown): ConfigPreview;
export declare function importConfiguration(data: QqbotData, value: unknown, options: unknown, revision: unknown, fault?: (stage: 'roles' | 'presets' | 'committed') => void): ConfigResult;
/** 数据对象已构造时同时刷新内存；构造前的角色库使用同一恢复函数。 */
export declare function recoverConfigurationImports(data: QqbotData): void;
