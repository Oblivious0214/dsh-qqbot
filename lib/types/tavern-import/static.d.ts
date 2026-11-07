import type { Extraction, Selection } from './types.ts';
/** 已知运行机制检查，不是自然语言语义证明；普通 XML 人设标签可保留。 */
export declare function hasDynamic(value: string): boolean;
export declare function substitute(value: string, name: string): string;
export declare function conditionsOf(value: string): string[];
export declare function defaultSelections(extraction: Extraction): Selection[];
export interface Adopted {
    materialId: string;
    sourceId: string;
    title: string;
    category: Selection['category'];
    excerpt: string;
    conditions: string[];
}
export declare function selectedExcerpts(extraction: Extraction, selections: Selection[]): Adopted[];
export declare function adoptStatic(extraction: Extraction, selections: Selection[]): string;
export declare function validateBody(value: unknown, kind: Extraction['kind']): string;
