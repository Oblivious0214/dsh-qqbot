/** 酒馆资料导入共享契约；原件、来源配置和本次采用文本分别保存。 */
export const TAVERN_IMPORT_PATH = '/api/qqbot/tavern-import'
export const LIMITS = { file: 10 * 1024 ** 2, total: 24 * 1024 ** 2, files: 8,
  normalized: 64 * 1024 ** 2, archive: 128 * 1024 ** 2,
  envelope: 64 * 1024 ** 2, pngText: 10 * 1024 ** 2, chunks: 10_000, materials: 10_000, depth: 64 } as const
export type ImportKind = 'role' | 'preset'
export const CATEGORIES = ['persona', 'world', 'rule', 'example', 'opening', 'runtime', 'author', 'mixed', 'unknown'] as const
export type Category = typeof CATEGORIES[number]
export type ErrorCode = 'malformed' | 'unsupported' | 'too-large' | 'needs-excerpt' | 'stale-preview' | 'conflict'
  | 'model-unavailable' | 'model-failed' | 'cancelled' | 'invalid-output' | 'storage-failed'
export interface Diagnostic { code: string; message: string; sourceId: string; materialId?: string }
export interface SourceInput { name: string; originalBase64: string; /** 可选关联外部书引用，不以名称合并。 */ supplements?: string }
export interface SourceFile extends SourceInput { sourceId: string; format: string; sha256: string; originalJson: unknown }
export interface Material {
  id: string; sourceId: string; pointer: string; title: string; originalText: string
  metadata: Record<string, unknown>; category: Category; classificationReason: string
  defaultSelected: boolean; staticState: 'ready' | 'needs-excerpt'; diagnostics: Diagnostic[]
  /** 确定性宏替换后的候选，原文单独保存。 */ staticText: string; conditions: string[]
}
export interface Selection { materialId: string; selected: boolean; category: Category; excerpt: string; conditions: string[]; reviewed: boolean }
export interface Extraction { kind: ImportKind; name: string; sources: SourceFile[]; materials: Material[]; diagnostics: Diagnostic[];
  books: { id: string; sourceId: string; pointer: string; configuration: Record<string, unknown> }[];
  groups: { sourceId: string; selected: number; choices: { index: number; characterId: unknown }[] }[] }
export interface ExtractInput { kind: ImportKind; sources: SourceInput[]; /** sourceId → 顺序组下标 */ groups?: Record<string, number> }
export interface ImportPayload extends ExtractInput { name: string; selections: Selection[]; body: string; conflict?: 'error' | 'copy';
  /** 浏览器裁剪生成的小 PNG，不接受原卡图直接入头像槽。 */ avatarBase64?: string; resultMetadata?: Record<string, unknown> }
export interface Preview { name: string; kind: ImportKind; count: number; currentPreset: string; libraryRevision: string; payloadHash: string; commitToken: string }
export interface SavedImport { kind: ImportKind; id: string; name: string; archive: string }
