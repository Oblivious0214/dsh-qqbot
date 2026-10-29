/**
 * qqbot 预设内全部 section 和 context 的 order，只在这里定义。
 * 其他文件和插件不写数字；外部插件统一落在 EXT 位置，同位置按名称排序。
 * 布局和缓存影响见 docs/architecture.md 第 3 节。
 */
export const SECTION_ORDER = {
  JB_HEAD: 100,
  PERSONA: 200,
  JB_MID: 300,
  FORMAT_SEGMENT: 400,
  FORMAT_MEME: 410,
  FORMAT_VOICE: 420,
  EXT: 500,
  MEMORY_HINT: 800,
  JB_TAIL: 900,
} as const

/** DSH 自带 context 在 100–210，qqbot:runtime 排在它们之后。 */
export const CONTEXT_ORDER = {
  RUNTIME: 1000,
} as const

export const SECTION_NAME = {
  JB_HEAD: 'qqbot:jb-head',
  PERSONA: 'qqbot:persona',
  JB_MID: 'qqbot:jb-mid',
  MEMORY_HINT: 'qqbot:memory-hint',
  JB_TAIL: 'qqbot:jb-tail',
  EXT_PREFIX: 'qqbot:ext:',
} as const

export const CONTEXT_NAME = {
  RUNTIME: 'qqbot:runtime',
} as const
