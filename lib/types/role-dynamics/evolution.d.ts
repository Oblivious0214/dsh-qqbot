import { type RoleDynamicsConfig, type Values } from './types.ts';
export interface EvolutionSnapshot {
    progressId: string;
    values: Values;
}
export declare function planEvolution(old: RoleDynamicsConfig, next: RoleDynamicsConfig, snapshots: EvolutionSnapshot[], renames?: Record<string, string>): {
    compatible: boolean;
    config: RoleDynamicsConfig;
    issues: {
        field: string;
        progressIds: string[];
        reason: string;
    }[];
    migrate: (values: Values) => Values;
};
