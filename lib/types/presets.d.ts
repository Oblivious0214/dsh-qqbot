/**
 * 破限预设存储：`<数据目录>/presets.json`。插件只存储和插入，文本由用户完全编辑（架构文档第 4 节）。
 * 文件不存在时用内置默认预设，第一次修改时才写盘。
 * id 是内部键（默认预设、角色的单独选择都按它记），界面上不显示：编辑器新建时自动生成，用户只按名称认预设。
 */
import { type Warn } from './storage.ts';
/** 一份破限预设：开头、中间、结尾三段。 */
export interface JailbreakPreset {
    readonly id: string;
    readonly name: string;
    readonly head: string;
    readonly mid: string;
    readonly tail: string;
}
/** 默认预设使用用户提供的通用规范，仍可在编辑器里修改。 */
export declare const DEFAULT_JAILBREAK: JailbreakPreset;
export declare const PRESET_ID_PATTERN: RegExp;
/** 编辑界面提交的预设。修改时带 id；新建时不带，由 save() 生成。 */
export type PresetDraft = Omit<JailbreakPreset, 'id'> & {
    readonly id?: string;
};
/** 校验一份预设；不合规时抛出可以直接展示给用户的错误。id 是内部键，用户看不到，只在格式不对时报"无效"。 */
export declare function validatePreset(value: unknown): JailbreakPreset;
export declare function validatePreset(value: unknown, optionalId: true): PresetDraft;
export declare class JailbreakStore {
    private readonly file;
    private readonly warn;
    private state;
    constructor(file: string | undefined, warn: Warn);
    /** 清理后读取新的初始预设。 */
    reload(): void;
    static at(dir: string, warn: Warn): JailbreakStore;
    /** 角色使用的预设：角色单独选的 → 全局默认 → 内置默认。roleId 为空表示会话没有角色。 */
    forRole(roleId: string | undefined): JailbreakPreset;
    get(id: string): JailbreakPreset | undefined;
    list(): readonly JailbreakPreset[];
    get defaultId(): string;
    /** 角色单独选的预设 id；跟随默认时为空。 */
    roleChoice(roleId: string): string | undefined;
    /**
     * 新建或修改一份预设。新建时编辑器不带 id，生成 `p-<8 位十六进制>`；带了 id（测试等内部调用）时不能已存在。
     * 修改时 id 必须已存在。名称不能和别的预设重复：用户只按名称认预设。
     */
    save(value: unknown, create: boolean): JailbreakPreset;
    private freshId;
    /** 配置导入一次提交新增预设及新角色的绑定，不改变已有内容和默认选择。 */
    appendImported(presets: readonly JailbreakPreset[], roles: Readonly<Record<string, string>>): void;
    /** 删除预设。不能删最后一份；删的是默认预设时，默认改为剩下的第一份；选了它的角色改回跟随默认。 */
    remove(id: string): void;
    setDefault(id: string): void;
    /** 为角色选择预设；presetId 为空表示跟随默认。 */
    assign(roleId: string, presetId: string | undefined): void;
    private commit;
    /** 宽松读取：跳过不合规的预设；一份都没有时回到内置默认。 */
    private load;
}
