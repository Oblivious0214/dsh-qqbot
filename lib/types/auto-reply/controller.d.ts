import { type AutoReplyView } from './types.ts';
export declare const LEASE_MS = 8000;
export interface Availability {
    allowed: boolean;
    busy: boolean;
    started: boolean;
}
export interface AutoReplyPort {
    now(): number;
    availability(session: string): Availability;
    send(session: string): void;
    /** Remove only this module's still-pending notice, never user input or a running turn. */
    cancelPending(session: string): void;
}
/** One host-owned entry per session. Only live, sequential client pulses can wake it.
 * There is no autonomous host timer that can send after a tab closes or disconnects. */
export declare class AutoReplyController {
    private readonly port;
    private readonly entries;
    private disposed;
    constructor(port: AutoReplyPort);
    enable(session: string, owner: string, options: unknown): AutoReplyView;
    pulse(session: string, owner: string, input: {
        blocked: boolean;
        activity: number;
    }): AutoReplyView;
    userInput(session: string): void;
    busy(session: string): void;
    completed(session: string): void;
    disable(session: string, owner: string): void;
    stop(session: string, message: string, status?: 'stopped' | 'limit'): AutoReplyView;
    view(session: string): AutoReplyView;
    forget(session: string): void;
    sweep(): void;
    clear(): void;
    dispose(): void;
}
