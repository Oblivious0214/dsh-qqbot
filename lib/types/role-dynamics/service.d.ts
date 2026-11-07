import { type HistoryView } from './history.ts';
import type { JournalStore } from './store.ts';
import { DynamicsError, type ModelProjection, type RoleDynamicsConfig, type Values } from './types.ts';
import type { Target, Snapshot, SourceHandle, Operation, CommitResult, TurnHandle } from './contracts.ts';
export type { Target, Snapshot, SourceHandle, Operation, CommitStatus, CommitResult, TurnHandle } from './contracts.ts';
export interface DynamicsOptions {
    store: JournalStore;
    history: HistoryView;
    config(roleId: string): unknown | undefined;
    isSelected(target: Target): boolean;
    epoch: string;
    clock?: () => number;
    id?: () => string;
}
export interface RolePersistencePort {
    guard(): void;
    prepare(): Promise<void>;
    plan(next: RoleDynamicsConfig, renames?: Record<string, string>): ReturnType<RoleDynamicsService['planConfiguration']>;
    approve(next: RoleDynamicsConfig, renames?: Record<string, string>): void;
    reset(next?: RoleDynamicsConfig): Promise<void>;
    invalidate(): void;
    detach(stamp: string): void;
    restore(stamp: string): void;
    release(): void;
}
/** No host imports. All mutations reload the authoritative journal inside the queue. */
export declare class RoleDynamicsService {
    private readonly options;
    private epoch;
    private disposed;
    private lifecycle;
    private queue;
    private active;
    private readonly blockedRoles;
    private readonly knownRoles;
    private readonly sources;
    private readonly handles;
    private readonly stoppedTurns;
    private readonly listeners;
    private ai;
    constructor(options: DynamicsOptions);
    private id;
    private now;
    private guard;
    private run;
    private source;
    /** Called by trusted owner/host adapters; never expose source registration over model/HTTP JSON. */
    createOwnerSource(): SourceHandle;
    registerSource(pluginIdentity: string, displayName: string): {
        handle: SourceHandle;
        dispose: () => void;
    };
    private authorize;
    private config;
    private load;
    private save;
    private record;
    private newProgress;
    private snapshot;
    private migrate;
    private validCandidate;
    /** Replay records and durable candidates against a precise cut without changing the parent. */
    private fold;
    private ensure;
    private seal;
    private sealSession;
    private asOf;
    private current;
    private durable;
    private settle;
    private notify;
    private context;
    readSnapshot(target: Target): Promise<Snapshot | undefined>;
    /** Owner UI preview: derive the current values without creating or updating a journal. */
    inspectSnapshot(target: Target): Promise<Snapshot | undefined>;
    private stableContext;
    projectModel(target: Target): Promise<ModelProjection | undefined>;
    beginTurn(target: Target, turnStart: number): Promise<TurnHandle | undefined>;
    private resolve;
    private changes;
    private operation;
    propose(handle: TurnHandle, operation: Operation, call: {
        seq: number;
        callId: string;
    }): Promise<{
        accepted: true;
    }>;
    settleTurn(handle: TurnHandle): Promise<CommitResult>;
    commit(target: Target, operation: Operation): Promise<CommitResult>;
    subscribe(target: Target, listener: (snapshot: Snapshot) => void): () => void;
    planConfiguration(roleId: string, next: RoleDynamicsConfig, renames?: Record<string, string>): {
        compatible: boolean;
        config: RoleDynamicsConfig;
        issues: {
            field: string;
            progressIds: string[];
            reason: string;
        }[];
        migrate: (values: Values) => Values;
    };
    /** Persist migration evidence before the outer ROLE.md transaction publishes its new definition. */
    approveEvolution(roleId: string, next: RoleDynamicsConfig, renames?: Record<string, string>): Promise<void>;
    private approveEvolutionNow;
    resetRole(roleId: string, next?: RoleDynamicsConfig): Promise<void>;
    private resetRoleNow;
    /** Trusted data-layer boundary: ROLE.md and journal recovery share the existing queue.
     * The scoped port expires before queued model/user operations can resume. */
    withRolePersistence<T>(roleId: string, body: (port: RolePersistencePort) => Promise<T>): Promise<T>;
    /** Freeze the operation boundary before any flush. Keep completed history recoverable
     * even if preparation fails, and persist it before the outer rollback backup. */
    private preparePersistence;
    private invalidateHandles;
    /** Stop an adapter without discarding rounds already closed before unload. */
    invalidateOpenTarget(target: Target): void;
    invalidateTarget(roleId: string, sessionId?: string): void;
    clearCaches(): void;
    invalidate(epoch: string): void;
    dispose(): void;
    detachRole(roleId: string, stamp: string): Promise<void>;
    restoreRole(roleId: string, stamp: string): Promise<void>;
    readExtension(source: SourceHandle, target: Target): Promise<{
        revision: number;
        values: Values;
    } | undefined>;
    commitExtension(source: SourceHandle, target: Target, definition: RoleDynamicsConfig, operation: Omit<Operation, 'source'>): Promise<{
        revision: number;
        values: Values;
    }>;
}
export { DynamicsError };
