/** Shared data contracts; this file has no host or Node dependencies. */
import type { ModelProjection, StateValue, Values } from './types.ts'
export interface Target { sessionId: string; roleId: string }
export interface Snapshot extends Target {
  progressId: string; generation: string; revision: number; configRevision: string; dataEpoch: string; values: Values
}
export interface SourceHandle { readonly token: string; readonly name: string }
export interface Operation {
  operationId: string; baseRevision: number; configRevision: string; dataEpoch: string; source: SourceHandle
  progressId: string; generation: string
  changes: { name: string; value: StateValue }[]
}
export type CommitStatus = 'committed' | 'no-change' | 'discarded' | 'conflict' | 'pending'
export interface CommitResult { status: CommitStatus; snapshot: Snapshot; error?: string }
export interface TurnHandle { readonly token: string; readonly snapshot: Snapshot; readonly projection: ModelProjection; readonly source: SourceHandle }
