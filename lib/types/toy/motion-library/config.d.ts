import { type Tier } from '../core/config.ts';
import { type PresetPool } from './catalog.ts';
import { type MotionLibrary } from './library.ts';
export interface ActionLibrary {
    readonly revision: number;
    readonly library: MotionLibrary;
    readonly pools: Readonly<Record<Tier, PresetPool>>;
    /** 未单独配置时，高潮沿用当前可用速度档的动作池。 */
    readonly burstPool?: PresetPool;
    /** 未单独配置时，温存沿用当前最低可用速度档的动作池。 */
    readonly aftercarePool?: PresetPool;
}
/** 一次提交整个动作库和引用，重命名、删除不会留下半份有效的配置。 */
export declare function parseActionLibrary(value: unknown): ActionLibrary;
/**
 * 可选动作：每个动作一行“名称：描述”，不是三档都能用的在后面标“（仅 low、medium）”。
 * 每档只取池里前 40 项，超出的名称在该档视为不可用。权重、轨迹、内部标识和随机状态留在程序里。
 */
export declare function presetRuntime(config: ActionLibrary): string;
