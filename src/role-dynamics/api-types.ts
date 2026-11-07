import type { ModelProjection, RoleDynamicsConfig, StateValue } from './types.ts'
import type { CommitResult, Operation, Snapshot, Target } from './contracts.ts'
export const STATE_PATH = '/api/qqbot/role-state'
export const LIBRARY_STATE_PATH = '/api/qqbot/role-state/library'
export type StateChanges = { name: string; value: StateValue }[]
export type PublicOperation = Omit<Operation, 'source'>
export interface DynamicsSource {
  readSnapshot(target: Target): Promise<Snapshot | undefined>
  commit(target: Target, operation: PublicOperation): Promise<CommitResult>
  projectModel(target: Target): Promise<ModelProjection | undefined>
  readExtension(target: Target): Promise<unknown>
  commitExtension(target: Target, definition: RoleDynamicsConfig, operation: PublicOperation): Promise<unknown>
  subscribe(target: Target, listener: (snapshot: Snapshot) => void): () => void
  dispose(): void
}
export interface DynamicsPublic {
  registerSource(name: string): DynamicsSource
  readSnapshot(target: Target): Promise<Snapshot | undefined>
  commit(target: Target, operation: PublicOperation): Promise<CommitResult>
  projectModel(target: Target): Promise<ModelProjection | undefined>
  subscribe(target: Target, listener: (snapshot: Snapshot) => void): () => void
}
export interface StateView {
  roleId: string; name: string; config: RoleDynamicsConfig; snapshot: Snapshot
  diagnosis: unknown
}
