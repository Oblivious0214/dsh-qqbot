import { MotionPlayer, type Clock } from '../client/player.ts';
import type { Transport } from '../client/transport.ts';
import { type MotionConfig } from '../core/config.ts';
import type { ActionLibrary } from '../motion-library/config.ts';
export type Ack = {
    v: 1;
    type: 'ack';
    leaseId: string;
    commandId: string;
    status: 'accepted' | 'duplicate' | 'rejected';
    code?: string;
};
/** 单 owner 本地执行端。guard 同时放在每次实际发包前，覆盖休眠后计时器乱序。 */
export declare class RemoteExecutor {
    private readonly transport;
    private readonly clock;
    private readonly wallNow;
    private readonly onInvalidated;
    private readonly locallyPresent;
    readonly player: MotionPlayer;
    paused: boolean;
    private lease;
    private seq;
    private generation;
    private turn;
    private segment;
    private seen;
    private leaseDeadline;
    private motionDeadline;
    private anchorMono;
    private anchorWall;
    private serverOffset;
    private armedAt;
    private timer;
    constructor(transport: Transport, config: MotionConfig, library: ActionLibrary, clock?: Clock, wallNow?: () => number, onInvalidated?: () => void, locallyPresent?: () => boolean);
    configure(config: MotionConfig): void;
    get activeLeaseId(): string | undefined;
    get online(): boolean;
    arm(): void;
    pause(): void;
    disconnect(): void;
    dispose(): void;
    private invalidate;
    private live;
    private watch;
    receive(raw: unknown): Ack | undefined;
    private ack;
}
