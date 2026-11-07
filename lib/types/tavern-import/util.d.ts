export { fail, ImportError, record, text } from './errors.ts';
export declare const hash: (value: string | Uint8Array) => string;
/** 排序只用于指纹，不改变原件与材料顺序。 */
export declare function canonical(value: unknown): string;
export declare function base64(value: unknown, limit?: number): Buffer;
export declare function utf8(bytes: Uint8Array): string;
export declare function json(text: string): unknown;
export declare const pointer: (key: string) => string;
/** 先逐值计量 JSON UTF-8 字节，超限即停；避免先构造整份响应／缩进档案字符串。 */
export declare function jsonBytes(value: unknown, pretty?: boolean, limit?: number): number;
