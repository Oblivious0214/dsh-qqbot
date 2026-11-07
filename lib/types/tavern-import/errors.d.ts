/** 可供两端共用的校验错误；不引入 Node 模块。 */
import type { ErrorCode } from './types.ts';
export declare class ImportError extends Error {
    readonly code: ErrorCode;
    readonly details?: unknown | undefined;
    constructor(code: ErrorCode, message: string, details?: unknown | undefined);
}
export declare function fail(code: ErrorCode, message: string): never;
export declare function record(value: unknown, path: string): Record<string, unknown>;
export declare function text(value: unknown, path: string): string;
