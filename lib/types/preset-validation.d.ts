import type { LibraryPreset } from './library-types.ts';
export declare const PRESET_ID_PATTERN: RegExp;
/** 编辑界面提交的预设。修改时带 id；新建时不带，由 save() 生成。 */
export type PresetDraft = Omit<LibraryPreset, 'id'> & {
    readonly id?: string;
};
/** 校验一份预设；不合规时抛出可以直接展示给用户的错误。id 是内部键，用户看不到，只在格式不对时报"无效"。 */
export declare function validatePreset(value: unknown): LibraryPreset;
export declare function validatePreset(value: unknown, optionalId: true): PresetDraft;
