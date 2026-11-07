import { type Condition, type ModelProjection, type RoleDynamicsConfig, type Values } from './types.ts';
export declare function evaluateCondition(config: RoleDynamicsConfig, values: Values, when: Condition): boolean;
export declare function projectModel(config: RoleDynamicsConfig, values: Values): ModelProjection;
export declare function diagnose(config: RoleDynamicsConfig, values: Values): {
    name: string;
    matched: boolean;
    reason: unknown;
}[];
