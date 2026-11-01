/** QQ Bot 自有数据维护接口，两端共用。 */
export declare const MAINTENANCE_PATH = "/api/qqbot/maintenance";
export type CleanupKind = 'cache' | 'all';
export interface MaintenanceView {
    readonly cacheEpoch: string;
    readonly dataEpoch: string;
}
