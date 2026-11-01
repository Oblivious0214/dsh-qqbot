import type { ReleaseUpdate } from './update-types.ts';
export declare const REPOSITORY = "Oblivious0214/dsh-qqbot";
export declare const INSTALL_URL = "https://github.com/Oblivious0214/dsh-qqbot";
export declare function newer(version: string, current: string): boolean;
export declare function releaseUpdate(input: unknown, current: string): ReleaseUpdate | undefined;
export interface InstallResult {
    application: string;
    error?: {
        message?: string;
        diagnostic?: string;
        code?: string;
    };
    version?: string;
}
export interface NativeManager {
    listBundles(): Promise<{
        name: string;
        version?: string;
        source?: string;
        enabled: boolean;
        availability: string;
    }[]>;
    removeBundle(name: string): Promise<InstallResult>;
    installBundle(spec: string, options: {
        enabled: boolean;
    }): Promise<InstallResult>;
}
export declare function installUpdate(manager: NativeManager, release: ReleaseUpdate, hmr: boolean, backup: () => Promise<void | string>, progress: (message: string) => void): Promise<InstallResult>;
