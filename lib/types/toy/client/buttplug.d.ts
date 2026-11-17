/**
 * Buttplug v3 客户端，只控制一台单轴位移设备（例如 ServeUCentral 的 Intiface 模式）。
 * 没有扫描循环、心跳、重试或自动重连；连接出错就断开，由用户手动重连。
 *
 * 迁移自 dsh-serveu 的 device.js（ButtplugConnection）。协议依据见旧仓库 DEVICE-PROTOCOL.md：
 * 握手 RequestServerInfo（MessageVersion 3）→ RequestDeviceList；位移用 LinearCmd，停止用 StopDeviceCmd。
 * 改动：设备的 StepCount 精度检查从运动生成移到选设备时；时钟可注入，便于测试。
 */
import { type MoveLimits, type MoveResult, type Transport, type TransportState } from './transport.ts';
export declare const DEFAULT_ADDRESS = "ws://127.0.0.1:12345";
export interface SocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: {
        data?: unknown;
    }) => void, options?: {
        once?: boolean;
    }): void;
}
export interface ButtplugOptions {
    readonly createSocket?: (url: string) => SocketLike;
    readonly timeoutMs?: number;
    readonly now?: () => number;
}
/** 规整服务地址：只接受 ws:// 或 wss://，不带用户名密码。 */
export declare function normalizeAddress(raw: string): string;
export declare class ButtplugConnection implements Transport {
    readonly kind = "buttplug";
    readonly profile: {};
    state: TransportState;
    /** 当前服务地址；未连接时为空串。 */
    address: string;
    private readonly createSocket;
    private readonly timeoutMs;
    private readonly now;
    private readonly listeners;
    private socket;
    private connecting;
    private cancelOpen;
    private readonly pending;
    /** 只保存近期指令类别用于拒绝提示，不保存设备名或命令内容。 */
    private readonly sentCommands;
    private readonly devices;
    private target;
    private handshaken;
    private nextId;
    /** 上一包的终点和预计结束时间。没有位置反馈，只能靠它估算下一包的最短时长。 */
    private lastMotion;
    constructor(options?: ButtplugOptions);
    subscribe(listener: (state: TransportState) => void): () => void;
    private setState;
    connect(raw?: string): Promise<TransportState>;
    private request;
    private receive;
    private addDevice;
    private select;
    private selectTarget;
    move(position: number, durationMs: number, limits: MoveLimits): Promise<MoveResult>;
    stop(): Promise<void>;
    /** 运动和停止发出即返回，不等服务端的 Ok；连接出错时由 close/error 事件断开。 */
    private send;
    disconnect(): void;
    private end;
}
