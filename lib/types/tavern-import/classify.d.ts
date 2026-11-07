import type { ImportKind, Material } from './types.ts';
export declare function classify(material: Omit<Material, 'category' | 'classificationReason' | 'defaultSelected' | 'staticState' | 'staticText' | 'conditions'>, kind: ImportKind, character: string): Material;
