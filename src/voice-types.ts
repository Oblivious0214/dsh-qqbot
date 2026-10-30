/**
 * 语音接口的约定，host 和浏览器端共用。不 import 任何东西，两端都能直接打包。
 * 设置、引擎和音色存 `<DSH_HOME>/qqbot/voice.json`；API key 存 DSH 的凭据库（ctx.credentials），不进这个文件。
 * 语音只在浏览器端朗读气泡，不进提示词，不影响前缀缓存。
 */

/** GET 读设置、引擎和音色（不含 key），POST 提交一个操作。 */
export const VOICE_PATH = '/api/qqbot/voice'
/** POST `{ voice, text }`，返回音频本身。 */
export const SPEAK_PATH = '/api/qqbot/voice/speak'

/** 引擎和音色的内部键，程序生成。角色卡的 `voice` 字段存音色的。 */
export const ENGINE_ID_PATTERN = /^e-[0-9a-f]{8}$/
export const VOICE_ID_PATTERN = /^v-[0-9a-f]{8}$/

/**
 * fish：Fish Audio 官方接口。openai：OpenAI 的 `/audio/speech` 格式，SiliconFlow、Kokoro-FastAPI 等本地或云端服务都用它。
 * gpt-sovits：GPT-SoVITS 自带的 api_v2.py（`/tts`）。
 */
export const ENGINE_KINDS = ['fish', 'openai', 'gpt-sovits'] as const
export type EngineKind = typeof ENGINE_KINDS[number]

export const ENGINE_KIND_LABELS: Record<EngineKind, string> = {
  fish: 'Fish Audio',
  openai: 'OpenAI 兼容接口',
  'gpt-sovits': 'GPT-SoVITS',
}

/** GPT-SoVITS 的语言代码。 */
export const SOVITS_LANGS = ['zh', 'ja', 'en', 'ko', 'yue', 'auto'] as const
export type SovitsLang = typeof SOVITS_LANGS[number]

export const SOVITS_LANG_LABELS: Record<SovitsLang, string> = {
  zh: '中文', ja: '日语', en: '英语', ko: '韩语', yue: '粤语', auto: '自动',
}

/** 引擎的连接设置。fish 不用填地址；model 留空时用各引擎的默认值。 */
export interface EngineConfig {
  readonly baseUrl: string
  readonly model: string
}

export const ENGINE_DEFAULTS: Record<EngineKind, EngineConfig> = {
  fish: { baseUrl: '', model: 's2.1-pro-free' },
  openai: { baseUrl: 'http://127.0.0.1:8880/v1', model: 'tts-1' },
  'gpt-sovits': { baseUrl: 'http://127.0.0.1:9880', model: '' },
}

/** fish 必须有 key；openai 本地服务一般不要；gpt-sovits 没有 key。 */
export const ENGINE_KEY: Record<EngineKind, 'required' | 'optional' | 'none'> = {
  fish: 'required',
  openai: 'optional',
  'gpt-sovits': 'none',
}

export interface VoiceEngine {
  /** 内部键，自动生成，界面上不显示。 */
  readonly id: string
  readonly name: string
  readonly kind: EngineKind
  readonly config: EngineConfig
}

/**
 * 音色参数，按引擎用不同字段：
 * fish 用 reference（reference_id）；openai 用 reference（voice 名称）；
 * gpt-sovits 用 reference（参考音频在 GPT-SoVITS 那台机器上的路径）、promptText、promptLang、textLang。
 */
export interface VoiceParams {
  readonly reference: string
  readonly promptText: string
  readonly promptLang: SovitsLang
  readonly textLang: SovitsLang
}

export interface VoiceEntry {
  /** 内部键，自动生成，界面上不显示。角色卡的 `voice` 字段存它。 */
  readonly id: string
  readonly name: string
  readonly engine: string
  readonly params: VoiceParams
}

/**
 * voice：只显示语音条，点开后显示文字。voice-only：只显示语音条。both：语音条和文字都显示。
 */
export const VOICE_DISPLAYS = ['voice', 'voice-only', 'both'] as const
export type VoiceDisplay = typeof VOICE_DISPLAYS[number]

export const VOICE_DISPLAY_LABELS: Record<VoiceDisplay, string> = {
  voice: '语音条，点开显示文字',
  'voice-only': '只有语音条',
  both: '语音条和文字',
}

export interface VoiceSettings {
  /** 关掉时所有角色都显示文字，不生成语音。 */
  readonly enabled: boolean
  readonly display: VoiceDisplay
  /** 新回复出现时就在后台生成；关掉时点了才生成（按字数计费的服务可以省钱）。 */
  readonly pregenerate: boolean
  /** 0–1。 */
  readonly volume: number
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  display: 'voice',
  pregenerate: true,
  volume: 0.8,
}

export interface VoiceEngineView extends VoiceEngine {
  /** 有没有存 key。key 本身不返回。 */
  readonly hasKey: boolean
}

export interface VoiceView {
  readonly settings: VoiceSettings
  readonly engines: readonly VoiceEngineView[]
  readonly voices: readonly VoiceEntry[]
  /** 凭据库不可用时为 false，界面上不让填 key。 */
  readonly keyStore: boolean
  /** engine.save 和 voice.save 成功后，保存的条目 id。 */
  readonly saved?: string
}

/** 新建时不带 id。apiKey：字符串表示换成这个，null 表示删掉，不写表示不变。 */
export interface EngineDraft {
  readonly id?: string
  readonly name: string
  readonly kind: EngineKind
  readonly config: EngineConfig
  readonly apiKey?: string | null
}

export type VoiceDraft = Omit<VoiceEntry, 'id'> & { readonly id?: string }

export type VoiceAction =
  | { readonly action: 'settings.save'; readonly settings: VoiceSettings }
  | { readonly action: 'engine.save'; readonly engine: EngineDraft }
  | { readonly action: 'engine.remove'; readonly id: string }
  | { readonly action: 'voice.save'; readonly voice: VoiceDraft }
  | { readonly action: 'voice.remove'; readonly id: string }

export interface VoiceError {
  readonly error: 'bad-request' | 'failed'
  readonly message: string
}

/** 一次朗读最多多少字。一个气泡一般几十字，超过的截断前面这部分。 */
export const SPEAK_TEXT_LIMIT = 500
/** 编辑器"试听"的默认句子。 */
export const PREVIEW_TEXT = '你好，很高兴见到你。这是我的声音。'

/**
 * 气泡文字转成朗读文字：去掉代码、链接、Markdown 记号，以及括号和星号里的动作描写（语音里念出来不像在说话）。
 * 剩下的为空时，这个气泡不做成语音条。
 */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '$1$2')
    .replace(/（[^）]*）|\([^)]*\)|\*[^*\n]+\*/g, ' ')
    .replace(/~~|[*_#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SPEAK_TEXT_LIMIT)
}
