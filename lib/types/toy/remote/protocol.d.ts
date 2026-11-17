import { type Intent } from '../core/intent.ts';
export declare const REMOTE_VERSION = "0.1.1";
export interface Route {
    adapter: 'astrbot' | 'qq-bridge';
    account: string;
    platform: string;
    conversation: string;
    user: string;
}
export interface Envelope {
    v: 1;
    type: string;
    leaseId: string;
    route: Route;
    seq: number;
    generation: number;
}
export interface Lease extends Envelope {
    type: 'lease' | 'heartbeat';
    serverTime: number;
    expiresAt: number;
}
export interface Command extends Envelope {
    type: 'command';
    commandId: string;
    turnId: string;
    segment: number;
    issuedAt: number;
    expiresAt: number;
    holdMs: number;
    motion: Intent | {
        stop: true;
    };
}
export interface Cancel extends Envelope {
    type: 'cancel';
    reason: string;
}
export type ServerFrame = Lease | Command | Cancel;
export declare function record(value: unknown): Record<string, unknown>;
export declare function string(value: unknown, max?: number): string;
export declare function integer(value: unknown, min?: number, max?: number): number;
export declare function parseRoute(value: unknown): Route;
export declare function sameRoute(a: Route, b: Route): boolean;
export declare function decode(text: string): Record<string, unknown>;
export declare function parseServerFrame(value: unknown): ServerFrame;
export declare function remoteAddress(raw: string, allowLoopback?: boolean): string;
