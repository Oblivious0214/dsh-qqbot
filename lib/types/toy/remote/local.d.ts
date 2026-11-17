import { RemoteExecutor } from './executor.ts';
import { RemoteConnector } from './connector.ts';
/** 独立本地服务；调用方显式选择模拟模式或真实 Buttplug，导入模块不会启动。 */
export declare function startLocal(options: {
    dataDir: string;
    port?: number;
    simulate?: boolean;
    allowLoopback?: boolean;
}): Promise<{
    url: string;
    executor: RemoteExecutor;
    connector: RemoteConnector;
    close(): Promise<void>;
}>;
