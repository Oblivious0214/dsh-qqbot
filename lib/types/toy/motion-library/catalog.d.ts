import { type MotionConfig, type Tier } from '../core/config.ts';
import { type MotionClip, type MotionLibrary } from './library.ts';
import { type MotionPreview, type PreviewOptions } from './preview.ts';
export interface CatalogItem {
    readonly name: string;
    readonly description: string;
    readonly playback: 'once' | 'loop';
    readonly durationMs: number;
}
/** 给模型/界面使用的精简数据目录，不提供点数组、内部 id 或路径。 */
export declare function queryCatalog(library: MotionLibrary, page?: {
    readonly offset?: number;
    readonly limit?: number;
}): readonly CatalogItem[];
export declare const POOL_WEIGHTS: {
    readonly low: 1;
    readonly medium: 2;
    readonly high: 3;
};
export type PoolWeight = keyof typeof POOL_WEIGHTS;
/** 一档的动作池：该档能用的动作及 auto 抽取权重。 */
export type PresetPool = readonly {
    readonly name: string;
    readonly weight: PoolWeight;
}[];
/** 池里的动作对应的片段；名称不在池里返回 undefined。 */
export declare function poolClip(library: MotionLibrary, pool: PresetPool, name: string): MotionClip | undefined;
/** 校验一档动作池：至少一个动作，名称在库里且不重复，权重有效。 */
export declare function checkPool(library: MotionLibrary, pool: unknown, label: string): PresetPool;
/**
 * 从一档动作池选动作：名称在池里时就用它，否则（含 auto）按权重抽一个。
 * 同一个种子总是抽到同一个，气泡、暂停、快调不重新抽。
 */
export declare function selectAction(library: MotionLibrary, pool: PresetPool, seed: number, name?: string): MotionClip;
/** 保留形状及相对时长；原速只套档位上限，按档变速则匹配该档 nominal 后整体拉伸限速。 */
export declare function previewPreset(clip: MotionClip, tier: Tier, config: MotionConfig, options?: Omit<PreviewOptions, 'minPosition' | 'maxPosition' | 'maxSpeed' | 'speedScale'> & {
    readonly tempo?: 'original' | 'tier';
}): MotionPreview;
