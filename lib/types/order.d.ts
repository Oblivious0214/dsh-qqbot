/**
 * qqbot 预设内全部提示词段落和 context 的 order，只在这里定义。
 * 其他文件和插件不写数字；外部插件统一落在 EXT 位置，同位置按名称排序。
 * 布局和缓存影响见 docs/architecture.md 第 3 节。
 */
/**
 * 各段在 `qqbot:prompt` 内的拼接顺序。这些段落不单独注册成 DSH section：
 * 它们拼成一个 complete section，DSH 自带段落因此不会进入 qqbot 会话。
 */
export declare const SECTION_ORDER: {
    readonly JB_HEAD: 100;
    readonly PERSONA: 200;
    readonly JB_MID: 300;
    readonly FORMAT_SEGMENT: 400;
    readonly FORMAT_MEME: 410;
    readonly FORMAT_VOICE: 420;
    readonly EXT: 500;
    readonly ROLE_MEMORY: 800;
    readonly JB_TAIL: 900;
};
/** 唯一注册给 DSH 的 section 的 order。complete section 是唯一的段落，数值只影响诊断显示。 */
export declare const PROMPT_ORDER = 0;
/** DSH 自带 context 在 100–210，qqbot:runtime 排在它们之后。 */
export declare const CONTEXT_ORDER: {
    readonly RUNTIME: 1000;
};
export declare const SECTION_NAME: {
    readonly PROMPT: "qqbot:prompt";
    readonly JB_HEAD: "qqbot:jb-head";
    readonly PERSONA: "qqbot:persona";
    readonly JB_MID: "qqbot:jb-mid";
    readonly FORMAT_SEGMENT: "qqbot:format-segment";
    readonly FORMAT_MEME: "qqbot:format-meme";
    readonly FORMAT_VOICE: "qqbot:format-voice";
    readonly JB_TAIL: "qqbot:jb-tail";
    readonly EXT_PREFIX: "qqbot:ext:";
    readonly ROLE_MEMORY: "qqbot:role-memory";
};
export declare const CONTEXT_NAME: {
    readonly RUNTIME: "qqbot:runtime";
};
