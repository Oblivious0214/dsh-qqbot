import type { Context } from '@deepseek-ai/cordis';
import { type CleanupKind, type MaintenanceView } from './maintenance-types.ts';
interface CleanupHooks {
    cache?(): void;
    prepare?(): void;
    credentials?(): Promise<void>;
    reload?(): void;
}
export declare class Maintenance {
    private readonly home;
    private readonly hooks;
    private busy;
    private disposed;
    private writes;
    private cacheEpoch;
    private dataEpoch;
    private readonly marker;
    constructor(home: string, warn: (message: string) => void);
    register(hooks: CleanupHooks): () => void;
    get active(): boolean;
    dispose(): void;
    assertAvailable(): void;
    view(): MaintenanceView;
    /** 清理期间拒绝写入，已有保存未结束时拒绝开始清理。 */
    route(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>;
    clear(kind: CleanupKind): Promise<MaintenanceView>;
}
/** 可选 qqbot 的内置模块和独立模拟夹具共用同一路由。 */
export declare function guardWrites(ctx: Context, handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export {};
