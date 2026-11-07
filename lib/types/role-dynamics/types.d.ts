export type StateValue = number | string | boolean;
export type Values = Record<string, StateValue>;
export type StateField = {
    name: string;
    visible: boolean;
    aiWritable: boolean;
    pluginWritable?: boolean;
    updateRule?: string;
} & ({
    type: 'number';
    initial: number;
    min?: number;
    max?: number;
} | {
    type: 'text';
    initial: string;
} | {
    type: 'boolean';
    initial: boolean;
} | {
    type: 'choice';
    initial: string;
    options: string[];
});
export type Condition = {
    field: string;
    op: 'eq' | 'ne';
    value: StateValue;
} | {
    field: string;
    op: 'gt' | 'gte' | 'lt' | 'lte';
    value: number;
} | {
    all: Condition[];
} | {
    any: Condition[];
};
export interface RoleDynamicsConfig {
    version: 1;
    enabled: boolean;
    fields: StateField[];
    entries: {
        name: string;
        when: Condition;
        text: string;
    }[];
}
export interface ModelProjection {
    fields: ({
        name: string;
        type: StateField['type'];
        value: StateValue;
    } & ({
        writable: false;
    } | {
        writable: true;
        updateRule: string;
        min?: number;
        max?: number;
        options?: string[];
    }))[];
    texts: string[];
}
export declare class DynamicsError extends Error {
    readonly code: string;
    readonly path: string;
    constructor(code: string, path: string, message: string);
}
export declare const fail: (path: string, message: string, code?: string) => never;
