export type TailscaleRun = (args: string[]) => Promise<string>;
export interface TailscaleEntry {
    origin: string;
    start(): Promise<void>;
    close(): Promise<void>;
}
/** 仅管理本入口的 443 根路径，不重置已有 Serve，也不启用 Funnel。 */
export declare function prepareTailscale(port: number, execute?: TailscaleRun): Promise<TailscaleEntry>;
