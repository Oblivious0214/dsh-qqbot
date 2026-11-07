export interface ImportManifest {
    version: 2;
    state: 'prepared' | 'committed' | 'rolled-back';
    presetsExisted: boolean;
    commitReceipt?: boolean;
    before: unknown;
    after: unknown;
    addedRoles: string[];
    roleFiles: {
        id: string;
        path: string;
        textDigest: string;
        configRevision: string;
    }[];
    addedPresets: string[];
}
export declare function presetStateMatches(root: string, expected: unknown): boolean;
/** Immediate failure and startup recovery use the same whole-unit ownership check. */
export declare function reconcileConfigurationImport(rolesDir: string, manifest: ImportManifest, file: string): boolean;
/** 首次库读取／预览时恢复中断导入，不触及既有角色、绑定、默认、记忆。 */
export declare function recoverConfigurationFiles(rolesDir: string): boolean;
