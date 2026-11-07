/**
 * 破限预设存储：`<数据目录>/presets.json`。插件只存储和插入，文本由用户完全编辑（架构文档第 4 节）。
 * 文件不存在时用内置默认预设，第一次修改时才写盘。
 * id 是内部键（当前预设按它记），界面上不显示：编辑器新建时自动生成，用户只按名称认预设。
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
export { PRESET_ID_PATTERN, validatePreset, type PresetDraft } from './preset-validation.ts';
export interface PresetFile {
    readonly version: 2;
    readonly current: string;
    readonly presets: readonly JailbreakPreset[];
}
export declare class JailbreakStore {
    private readonly file;
    private readonly warn;
    private state;
    private commits;
    get commitRevision(): number;
    private loadedDisk;
    constructor(file: string | undefined, warn: Warn);
    /** 清理后读取新的初始预设。 */
    reload(): void;
    private diskText;
    /** Import must compare the complete real file and current choice.
     * Invalid/deleted files never become a writable default through permissive load. */
    importBaseline(): {
        state: PresetFile;
        disk: string | null;
    };
    static at(dir: string, warn: Warn): JailbreakStore;
    /** 全部 QQ 会话共用同一份当前预设。 */
    current(): JailbreakPreset;
    get(id: string): JailbreakPreset | undefined;
    list(): readonly JailbreakPreset[];
    /** 完整副本，包含当前选择和全部预设；调用者不能修改存储状态。 */
    snapshot(): PresetFile;
    get currentId(): string;
    /**
     * 新建或修改一份预设。新建时编辑器不带 id，生成 `p-<8 位十六进制>`；带了 id（测试等内部调用）时不能已存在。
     * 修改时 id 必须已存在。名称不能和别的预设重复：用户只按名称认预设。
     */
    save(value: unknown, create: boolean): JailbreakPreset;
    private freshId;
    /** 配置导入一次提交新增预设，不改变已有内容和当前选择。 */
    appendImported(presets: readonly JailbreakPreset[]): void;
    /** 删除预设。不能删最后一份；删的是当前预设时，改为剩下的第一份。 */
    remove(id: string): void;
    setCurrent(id: string): void;
    private commit;
    /** 无效文件保留证据并显示内置默认；有效 v1 原子迁移。 */
    private load;
}
