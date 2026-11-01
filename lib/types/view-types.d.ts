/**
 * 提示词查看器的接口约定，host 和浏览器端共用。不 import 任何东西，两端都能直接打包。
 * 数据来源见 work/prompt-viewer-source-20261029/README.md。
 */
export declare const PRESET_ID = "qqbot";
/** `/api` 下的精确路由，由 DSH 的 connection 做认证；只有 owner 能读。 */
export declare const PROMPT_VIEW_PATH = "/api/qqbot/prompt-view";
/** 系统提示词里的一段。start 和 length 按 JS 字符串（UTF-16）计。 */
export interface PromptViewPart {
    readonly name: string;
    readonly order: number;
    /** `qqbot`：dsh-qqbot 自己的段落；`extension`：外部插件登记的槽位。 */
    readonly owner: 'qqbot' | 'extension';
    /** 登记它的插件；dsh-qqbot 自己的段落和取不到时为空。 */
    readonly source?: string;
    /** 在拼好的系统提示词里的起始位置。 */
    readonly start: number;
    readonly text: string;
}
/** 上一轮真实发出的系统提示词和当前要发的比较结果。 */
export type PromptViewLastSent = {
    readonly state: 'none';
} | {
    readonly state: 'same';
}
/** firstDiff：第一个不同字符的位置，下一轮前缀缓存从这里开始失效。 */
 | {
    readonly state: 'changed';
    readonly firstDiff: number;
    readonly previousLength: number;
};
export interface PromptViewContextItem {
    readonly name: string;
    readonly text: string;
    readonly source?: string;
}
export interface PromptViewTool {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
}
export interface PromptView {
    readonly sessionId: string;
    /** 当前角色；没有角色时为空。查看器据此跳到角色编辑。 */
    readonly roleId?: string;
    /** 当前使用的破限预设。查看器据此跳到预设编辑。 */
    readonly presetId: string;
    readonly system: {
        readonly length: number;
        readonly parts: readonly PromptViewPart[];
    };
    readonly lastSent: PromptViewLastSent;
    /** runtime context：工作目录（DSH）和 qqbot:runtime 的各条登记。 */
    readonly contexts: readonly PromptViewContextItem[];
    /** 上一次请求头里的工具；还没有请求时为空。 */
    readonly tools: readonly PromptViewTool[];
}
export type PromptViewError = 'bad-request' | 'not-loaded' | 'not-qqbot';
