import { type ExtractInput, type Extraction } from './types.ts';
export declare function cardData(value: unknown): {
    data: Record<string, unknown>;
    prefix: string;
    format: string;
};
export declare function extract(input: ExtractInput): Extraction;
/** 输入快照指纹包含组选择、源原件与所有编辑。 */
export declare const extractionFingerprint: (input: unknown) => string;
