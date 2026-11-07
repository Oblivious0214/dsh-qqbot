import { type MotionScript } from './script.ts';
export interface MotionClip extends MotionScript {
    readonly source: 'builtin' | 'custom';
    readonly kind: 'loop' | 'segment';
    readonly legacyAiRepeat?: true;
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly playback: 'once' | 'loop';
    /** 循环动作第二遍起从这个时间点开始（须是一个动作点，位置与终点相同）；不写则从头循环。 */
    readonly loopFromMs?: number;
}
export interface ClipMetadata {
    readonly kind?: 'loop' | 'segment';
    readonly description?: string;
    readonly playback?: 'once' | 'loop';
}
export interface SceneMapping {
    readonly scene: string;
    readonly clipId: string;
}
export interface MotionLibrary {
    readonly format: 'dsh-motion-library-preview';
    readonly version: 2;
    readonly clips: readonly MotionClip[];
    readonly mappings: readonly SceneMapping[];
}
export declare function emptyLibrary(): MotionLibrary;
/** 校验并复制快照。片段名、情景名在 NFKC/去空格/大小写归一化后唯一。 */
export declare function parseLibrary(value: unknown): MotionLibrary;
/** 纯数据保存：生成内部标识并返回新快照；调用者另行负责持久化。循环动作首尾位置不同时自动补点闭合。 */
export declare function saveClip(library: MotionLibrary, label: string, script: MotionScript, fromMs: number, toMs: number, metadata?: ClipMetadata): MotionLibrary;
/** 编辑名称、描述、播放方式；id 不变，因此情景引用保持。改截取或改为循环时，首尾位置不同则自动补点闭合。 */
export declare function updateClip(library: MotionLibrary, clipName: string, patch: ClipMetadata & {
    readonly name?: string;
    readonly points?: MotionScript['points'];
}): MotionLibrary;
/** 用户按名称选择片段。重复情景拒绝，不偷偷覆盖旧映射。 */
export declare function mapScene(library: MotionLibrary, scene: string, clipName: string): MotionLibrary;
/** 只解析明确选择的情景名，不扫描聊天、不推断情绪、不触发播放。 */
export declare function resolveScene(library: MotionLibrary, scene: string): MotionClip | undefined;
export declare function serializeLibrary(library: MotionLibrary): string;
export declare function deserializeLibrary(text: string): MotionLibrary;
