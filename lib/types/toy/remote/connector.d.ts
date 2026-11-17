import type { SocketLike } from '../client/buttplug.ts';
import { RemoteExecutor } from './executor.ts';
export interface Credentials {
    token?: string;
    pairCode?: string;
}
/** 主动 WSS；不自动重连，用户重新接入时申请全新租约。 */
export declare class RemoteConnector {
    private readonly executor;
    private readonly saveToken;
    private readonly createSocket;
    private readonly allowLoopback;
    private socket;
    private epoch;
    private timeout;
    status: string;
    invalidated(): void;
    constructor(executor: RemoteExecutor, saveToken?: (token: string) => void, createSocket?: (url: string) => SocketLike, allowLoopback?: boolean);
    connect(address: string, name: string, credentials: Credentials): void;
    pause(): void;
    disconnect(): void;
    private fail;
}
