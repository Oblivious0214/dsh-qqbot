/**
 * qqbot 预设内全部提示词段落和 context 的 order，只在这里定义。
 * 其他文件和插件不写数字；外部插件统一落在 EXT 位置，同位置按名称排序。
 * 布局和缓存影响见 docs/architecture.md 第 3 节。
 */

/**
 * 各段在 `qqbot:prompt` 内的拼接顺序。这些段落不单独注册成 DSH section：
 * 它们拼成一个 complete section，DSH 自带段落因此不会进入 qqbot 会话。
 */
export const SECTION_ORDER = {
  JB_HEAD: 100,
  PERSONA: 200,
  JB_MID: 300,
  FORMAT_SEGMENT: 400,
  FORMAT_MEME: 410,
  FORMAT_VOICE: 420,
  EXT: 500,
  JB_TAIL: 900,
} as const

/** 唯一注册给 DSH 的 section 的 order。complete section 是唯一的段落，数值只影响诊断显示。 */
export const PROMPT_ORDER = 0

/** DSH 自带 context 在 100–210，qqbot:runtime 排在它们之后。 */
export const CONTEXT_ORDER = {
  RUNTIME: 1000,
} as const

export const SECTION_NAME = {
  PROMPT: 'qqbot:prompt',
  JB_HEAD: 'qqbot:jb-head',
  PERSONA: 'qqbot:persona',
  JB_MID: 'qqbot:jb-mid',
  FORMAT_SEGMENT: 'qqbot:format-segment',
  FORMAT_MEME: 'qqbot:format-meme',
  FORMAT_VOICE: 'qqbot:format-voice',
  JB_TAIL: 'qqbot:jb-tail',
  EXT_PREFIX: 'qqbot:ext:',
} as const

export const CONTEXT_NAME = {
  RUNTIME: 'qqbot:runtime',
} as const
