/**
 * 持久化设置：`<DSH_HOME>/toy-buttplug/settings.json`。没有文件时用默认值（未授权），第一次保存时才写盘。
 * 文件坏了或字段不合法时按未授权的默认值运行，坏文件留给用户检查，不自动修复。
 */
import { type ToySettings } from './api-types.ts';
import { type Warn } from './storage.ts';
export declare function defaultSettings(): ToySettings;
/** 校验并规整设置。不合法时抛出中文错误。 */
export declare function parseSettings(value: unknown): ToySettings;
export declare class SettingsStore {
    private readonly file;
    private current;
    constructor(file: string, warn: Warn);
    static at(dir: string, warn: Warn): SettingsStore;
    reset(): void;
    get value(): ToySettings;
    /** 校验后写盘。不合法时抛出，原设置不变。 */
    save(value: unknown): ToySettings;
}
