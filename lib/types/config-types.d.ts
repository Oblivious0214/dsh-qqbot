/** 可分享配置包只使用名称；本机内部键、凭据和授权不进入配置包。 */
export declare const CONFIG_PATH = "/api/qqbot/config";
export declare const CONFIG_MAX_BYTES: number;
export interface ConfigOptions {
    readonly presets: boolean;
    readonly roles: boolean;
    readonly conflict: 'skip' | 'copy';
}
export interface ConfigEntry {
    readonly kind: 'preset' | 'role';
    readonly name: string;
    readonly target: string;
    readonly status: 'add' | 'skip';
}
export interface ConfigPreview {
    readonly entries: readonly ConfigEntry[];
    readonly revision: string;
}
export type ConfigRequest = {
    readonly action: 'preview' | 'import';
    readonly config: unknown;
    readonly options: ConfigOptions;
    readonly revision?: string;
};
export interface ConfigResult {
    readonly presets: number;
    readonly roles: number;
    readonly skipped: number;
}
