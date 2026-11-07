import { type Diagnostic } from './types.ts';
export declare function isPng(bytes: Buffer): boolean;
export declare function crc32(bytes: Buffer): number;
interface Chunk {
    type: string;
    data: Buffer;
}
export declare function chunks(bytes: Buffer): Chunk[];
export declare function readCardPng(bytes: Buffer, sourceId: string, validate: (value: unknown) => void): {
    value: unknown;
    diagnostics: Diagnostic[];
};
/** 仅接收裁剪流程的 8 位、非隔行小 PNG；完整解压并验证每行 filter 和数据长度。 */
export declare function validateAvatar(value: string): Buffer;
export {};
