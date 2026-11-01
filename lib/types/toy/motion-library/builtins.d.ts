import { type MotionLibrary } from './library.ts';
import { type ActionLibrary } from './config.ts';
import type { PresetPool } from './catalog.ts';
import type { Tier } from '../core/config.ts';
export declare function defaultActionLibrary(): ActionLibrary;
export declare function builtinLibrary(): MotionLibrary;
export declare function defaultPresetPools(): Record<Tier, PresetPool>;
