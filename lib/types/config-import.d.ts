import type { QqbotData } from './content.ts';
import { type ConfigPreview, type ConfigResult } from './config-types.ts';
export declare function previewConfiguration(data: QqbotData, value: unknown, options: unknown): ConfigPreview;
export declare function importConfiguration(data: QqbotData, value: unknown, options: unknown, revision: unknown): ConfigResult;
