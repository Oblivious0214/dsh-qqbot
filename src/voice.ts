/**
 * 语音：引擎（连接哪家服务）、音色（角色卡选的就是它）和朗读设置存 `<数据目录>/voice.json`。
 * API key 存 DSH 的凭据库（`ctx.credentials`，记录键 `dsh-qqbot/tts-<引擎 id>`），不进 voice.json，GET 也不返回。
 * 接口：VOICE_PATH 读写设置，SPEAK_PATH 合成一句返回音频。都走 DSH 的认证，只有 owner 能访问。
 * 语音由浏览器端朗读气泡；仅可用状态进入 qqbot 的 runtime，不改稳定提示词。
 */

import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from './index.ts'
import { isRecord, readJson, writeJson, type Warn } from './storage.ts'
import { BadRequest } from './ui.ts'
import { toneOf } from './vendor/dialogue-timing/protocol.js'
import { AUDIO_CONTENT_TYPES, effectiveTone, normalizeBaseUrl, normalizeProxyUrl, synthesize, SynthError, type Audio, type Fetch } from './voice-engines.ts'
import {
  DEFAULT_PROXY_URL, DEFAULT_VOICE_SETTINGS, ENGINE_DEFAULTS, FISH_SOUND_TAGS, FISH_TONE_TAGS, toneStyle, ENGINE_KEY, ENGINE_KINDS, SOVITS_LANGS, ENGINE_ID_PATTERN, SPEAK_PATH, SPEAK_TEXT_LIMIT, VOICE_DISPLAYS, VOICE_MODES, VOICE_ID_PATTERN, VOICE_PATH,
  type EngineConfig, type ProxyConfig, type VoiceEngine, type VoiceEntry, type VoiceError, type VoiceParams, type VoiceMode, type VoiceSettings, type VoiceView,
} from './voice-types.ts'

/**
 * 语气说明按当前音色所属服务的写法进入 runtime，各服务一段，互不影响；稳定 section 保持原文。
 * 不支持语气的服务不给说明，模型就不写 tone。
 */
function tonePrompt(engine: VoiceEngine, mode: VoiceMode): string {
  const style = toneStyle(engine)
  if (style === undefined) return ''
  const scope = mode === 'all' ? '段落' : 'voice:true 的段落'
  const voiceKey = mode === 'all' ? '' : '"voice":true,'
  if (style === 'tags') {
    return `语音语气：${scope}可加 "tone"，从 ${FISH_TONE_TAGS.join('、')} 中选一个；语气平常时不写。喘息、呻吟等声音写在 text 中发生的位置，用 ${FISH_SOUND_TAGS.map(tag => `[${tag}]`).join('、')}。例如：{${voiceKey}"tone":"happy","text":"终于等到你了！"}、{${voiceKey}"tone":"breathy","text":"慢一点[panting]……再慢一点。"}。`
  }
  const free = `语音语气：${scope}可加 "tone"，用几个字描述这段怎么说，如"轻声安慰，语速稍慢""压低声音，带点笑意""喘着气，声音发颤""贴着耳边低语，带点挑逗"；语气平常时不写。`
  if (style === 'free') return `${free}例如：{${voiceKey}"tone":"轻声安慰","text":"我在这里，慢慢说。"}。`
  return `${free}叹气、喘息、呻吟、停顿等声音写在 text 中发生的位置，如 [叹气]、[喘息]、[呻吟]、[短暂停顿]。例如：{${voiceKey}"tone":"轻声安慰","text":"我在这里。[短暂停顿]慢慢说。"}。`
}

export const name = 'qqbot-voice'

/** 存 key 的地方。生产环境是 DSH 凭据库，测试用内存。 */
export interface KeyStore {
  read(engine: string): Promise<string | undefined>
  /** null 表示删掉。 */
  write(engine: string, key: string | null): Promise<void>
}

/** ctx.credentials 里本插件用到的部分。记录键是带品牌的字符串，这里只按字符串传，不引入凭据包的运行时。 */
interface CredentialRecords {
  readRecord(key: never): Promise<{ readonly kind: string; readonly key?: string } | undefined>
  modifyRecord(key: never, mutate: (current: unknown) => Promise<{ kind: 'api-key'; key: string } | undefined>): Promise<unknown>
  deleteRecord(key: never): Promise<void>
}

/** 记录键 `<scope>/<id>`，两段都要匹配 `^[a-z][a-z0-9-]*$`。 */
function recordKey(engine: string): never {
  if (!ENGINE_ID_PATTERN.test(engine)) throw new BadRequest('引擎 id 无效')
  return `dsh-qqbot/tts-${engine}` as never
}

export function credentialKeyStore(credentials: CredentialRecords): KeyStore {
  return {
    async read(engine) {
      const record = await credentials.readRecord(recordKey(engine))
      return record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '' ? record.key : undefined
    },
    async write(engine, key) {
      if (key === null) await credentials.deleteRecord(recordKey(engine))
      else await credentials.modifyRecord(recordKey(engine), () => Promise.resolve({ kind: 'api-key', key }))
    },
  }
}

const NAME_LIMIT = 40
const FIELD_LIMIT = 500
const KEY_LIMIT = 1000

function entryName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > NAME_LIMIT || /[\r\n]/.test(value)) {
    throw new BadRequest(`${label}不能为空，不能换行，最多 ${NAME_LIMIT} 个字符`)
  }
  return value.trim()
}

function field(value: unknown, label: string, required: boolean): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > FIELD_LIMIT || /[\r\n]/.test(value)) throw new BadRequest(`${label}不能换行，最多 ${FIELD_LIMIT} 个字符`)
  if (required && value.trim() === '') throw new BadRequest(`${label}不能为空`)
  return value.trim()
}

function oneOf<T extends string>(value: unknown, label: string, options: readonly T[]): T {
  const found = options.find(option => option === value)
  if (found === undefined) throw new BadRequest(`${label}无效`)
  return found
}

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!isRecord(value)) throw new BadRequest('语音设置格式无效')
  const { enabled, display, pregenerate, volume } = value
  if (typeof enabled !== 'boolean' || typeof pregenerate !== 'boolean') throw new BadRequest('开关必须是开或关')
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new BadRequest('音量必须在 0–1 之间')
  const mode = value['mode'] === undefined ? DEFAULT_VOICE_SETTINGS.mode : oneOf(value['mode'], '发送方式', VOICE_MODES)
  return { enabled, mode, display: oneOf(display, '显示方式', VOICE_DISPLAYS), pregenerate, volume }
}

function validateConfig(kind: VoiceEngine['kind'], value: unknown): EngineConfig {
  if (!isRecord(value)) throw new BadRequest('连接设置格式无效')
  const model = field(value['model'], '模型', false) || ENGINE_DEFAULTS[kind].model
  if (kind === 'fish') return { baseUrl: '', model, proxy: validateProxy(value['proxy']) }
  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(field(value['baseUrl'], '地址', true))
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error))
  }
  if (kind === 'gpt-sovits') return { baseUrl, model: '' }
  return { baseUrl, model, tone: value['tone'] === true }
}

/** 没写时是关闭。只在打开时检查地址，关着的时候填了一半也能保存。 */
function validateProxy(value: unknown): ProxyConfig {
  if (value === undefined) return { enabled: false, url: DEFAULT_PROXY_URL }
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean') throw new BadRequest('代理设置格式无效')
  const url = field(value['url'], '代理地址', value['enabled'])
  if (!value['enabled']) return { enabled: false, url: url || DEFAULT_PROXY_URL }
  try {
    return { enabled: true, url: normalizeProxyUrl(url) }
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error))
  }
}

function validateParams(kind: VoiceEngine['kind'], value: unknown): VoiceParams {
  if (!isRecord(value)) throw new BadRequest('音色设置格式无效')
  const label = kind === 'fish' ? '音色 ID' : kind === 'openai' ? '音色名称' : '参考音频路径'
  const reference = field(value['reference'], label, true)
  if (kind !== 'gpt-sovits') return { reference, promptText: '', promptLang: 'zh', textLang: 'zh' }
  return {
    reference,
    promptText: field(value['promptText'], '参考音频的文字', false),
    promptLang: oneOf(value['promptLang'], '参考音频的语言', SOVITS_LANGS),
    textLang: oneOf(value['textLang'], '朗读语言', SOVITS_LANGS),
  }
}

interface VoiceFile {
  readonly settings: VoiceSettings
  readonly engines: readonly VoiceEngine[]
  readonly voices: readonly VoiceEntry[]
}

/** 读文件时逐条兜底：手改坏了一条，其他照常生效。 */
function looseFile(value: unknown, warn: Warn): VoiceFile {
  if (!isRecord(value)) return { settings: DEFAULT_VOICE_SETTINGS, engines: [], voices: [] }
  let settings = DEFAULT_VOICE_SETTINGS
  try { settings = validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, ...isRecord(value['settings']) ? value['settings'] : {} }) } catch { /* 用默认值 */ }
  const engines: VoiceEngine[] = []
  for (const raw of Array.isArray(value['engines']) ? value['engines'] : []) {
    try {
      if (!isRecord(raw) || typeof raw['id'] !== 'string' || !ENGINE_ID_PATTERN.test(raw['id'])) throw new BadRequest('id 无效')
      const kind = oneOf(raw['kind'], '引擎类型', ENGINE_KINDS)
      engines.push({ id: raw['id'], name: entryName(raw['name'], '名称'), kind, config: validateConfig(kind, raw['config']) })
    } catch (error) {
      warn(`qqbot: voice.json 里有一个引擎读不出来，已跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const voices: VoiceEntry[] = []
  for (const raw of Array.isArray(value['voices']) ? value['voices'] : []) {
    try {
      if (!isRecord(raw) || typeof raw['id'] !== 'string' || !VOICE_ID_PATTERN.test(raw['id'])) throw new BadRequest('id 无效')
      const engine = engines.find(item => item.id === raw['engine'])
      if (engine === undefined) throw new BadRequest('引擎不存在')
      voices.push({ id: raw['id'], name: entryName(raw['name'], '名称'), engine: engine.id, params: validateParams(engine.kind, raw['params']) })
    } catch (error) {
      warn(`qqbot: voice.json 里有一个音色读不出来，已跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { settings, engines, voices }
}
function freshId(prefix: 'e' | 'v', taken: readonly { readonly id: string }[]): string {
  for (;;) {
    const id = `${prefix}-${randomBytes(4).toString('hex')}`
    if (!taken.some(item => item.id === id)) return id
  }
}

export class VoiceStore {
  private cache: VoiceFile | undefined
  private actions: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string, private readonly warn: Warn) {}

  /** 同一份资料的界面写操作排队，凭据写入期间不被另一页面覆盖。 */
  action<T>(run: () => Promise<T>): Promise<T> {
    const next = this.actions.then(run, run)
    this.actions = next.catch(() => {})
    return next
  }

  clearCache(): void { this.cache = undefined }

  private get file(): string { return join(this.dir, 'voice.json') }

  private get data(): VoiceFile {
    this.cache ??= looseFile(readJson(this.file, this.warn), this.warn)
    return this.cache
  }

  private write(next: VoiceFile): void {
    writeJson(this.file, { version: 1, ...next })
    this.cache = next
  }

  get settings(): VoiceSettings { return this.data.settings }
  get engines(): readonly VoiceEngine[] { return this.data.engines }
  get voices(): readonly VoiceEntry[] { return this.data.voices }

  engine(id: string): VoiceEngine | undefined { return this.data.engines.find(item => item.id === id) }
  voice(id: string): VoiceEntry | undefined { return this.data.voices.find(item => item.id === id) }

  /** 和浏览器 playable() 使用相同条件，不请求上游服务，也不读取或暴露密钥、地址和音色内部键。 */
  promptStatus(id: string | undefined): string {
    if (!this.settings.enabled) return '已关闭；需在 QQ Bot 的语音设置中启用语音。'
    if (id === undefined) return '未配置：当前角色未选择音色；需在角色设置中选择音色。'
    const voice = this.voice(id)
    if (voice === undefined || this.engine(voice.engine) === undefined) return '未配置：当前角色的音色或语音服务已失效；需在角色设置中重新选择音色。'
    const engine = this.engine(voice.engine)!
    const delivery = tonePrompt(engine, this.settings.mode)
    const status = this.settings.mode === 'all'
      ? '已启用（全部转语音）：当前角色已配置音色，所有可朗读回复均由界面转成语音条。'
      : '已启用（由 AI 决定）：当前角色已配置音色，仅 voice:true 的段落生成语音条，其余保持文字。'
    return status + (delivery ? `\n${delivery}` : '')
  }

  saveSettings(value: unknown): void {
    this.write({ ...this.data, settings: validateVoiceSettings(value) })
  }

  /** 新建或修改引擎，返回 id。修改时不能换类型：音色参数按类型解释，换了就对不上。 */
  saveEngine(value: unknown): VoiceEngine {
    return this.commitEngine(this.draftEngine(value))
  }

  /** 仅校验并分配内部键；凭据成功保存后才提交配置。 */
  draftEngine(value: unknown): VoiceEngine {
    if (!isRecord(value)) throw new BadRequest('引擎格式无效')
    const kind = oneOf(value['kind'], '引擎类型', ENGINE_KINDS)
    const engineName = entryName(value['name'], '连接名称')
    const config = validateConfig(kind, value['config'])
    const { engines } = this.data
    let id: string
    if (value['id'] === undefined) {
      id = freshId('e', engines)
    } else {
      const existing = typeof value['id'] === 'string' ? this.engine(value['id']) : undefined
      if (existing === undefined) throw new Error('这个连接已经不在了，可能已在别处删除')
      if (existing.kind !== kind) throw new BadRequest('不能改连接的类型，请新建一个')
      id = existing.id
    }
    if (engines.some(item => item.id !== id && item.name === engineName)) throw new Error(`已经有叫"${engineName}"的连接，换个名称`)
    return { id, name: engineName, kind, config }
  }

  commitEngine(engine: VoiceEngine): VoiceEngine {
    const { engines } = this.data
    const index = engines.findIndex(item => item.id === engine.id)
    this.write({ ...this.data, engines: index < 0 ? [...engines, engine] : engines.with(index, engine) })
    return engine
  }

  /** 还有音色用它时不能删，免得角色的音色悄悄失效。 */
  removeEngine(id: string): void {
    if (this.engine(id) === undefined) throw new Error('这个连接已经不在了')
    const users = this.data.voices.filter(item => item.engine === id)
    if (users.length > 0) throw new Error(`还有音色在用这个连接：${users.map(item => item.name).join('、')}，先删掉或改用别的连接`)
    this.write({ ...this.data, engines: this.data.engines.filter(item => item.id !== id) })
  }

  /** 校验音色草稿，不保存。试听没保存的音色时也用它。 */
  draftVoice(value: unknown): Omit<VoiceEntry, 'id'> & { readonly id?: string } {
    if (!isRecord(value)) throw new BadRequest('音色格式无效')
    const engine = typeof value['engine'] === 'string' ? this.engine(value['engine']) : undefined
    if (engine === undefined) throw new BadRequest('先选一个连接')
    const id = value['id']
    if (id !== undefined && (typeof id !== 'string' || !VOICE_ID_PATTERN.test(id))) throw new BadRequest('音色 id 无效')
    return { ...id === undefined ? {} : { id }, name: entryName(value['name'], '音色名称'), engine: engine.id, params: validateParams(engine.kind, value['params']) }
  }

  saveVoice(value: unknown): VoiceEntry {
    const draft = this.draftVoice(value)
    const { voices } = this.data
    if (draft.id !== undefined && this.voice(draft.id) === undefined) throw new Error('这个音色已经不在了，可能已在别处删除')
    const id = draft.id ?? freshId('v', voices)
    if (voices.some(item => item.id !== id && item.name === draft.name)) throw new Error(`已经有叫"${draft.name}"的音色，换个名称`)
    const voice: VoiceEntry = { ...draft, id }
    const index = voices.findIndex(item => item.id === id)
    this.write({ ...this.data, voices: index < 0 ? [...voices, voice] : voices.with(index, voice) })
    return voice
  }

  /** 选了这个音色的角色之后显示文字；角色卡里的 voice 字段留着，同 id 的音色不会再生成。 */
  removeVoice(id: string): void {
    if (this.voice(id) === undefined) throw new Error('这个音色已经不在了')
    this.write({ ...this.data, voices: this.data.voices.filter(item => item.id !== id) })
  }
}

/** 编辑器要的全部数据。hasKey 逐个问凭据库，key 本身不出 host。 */
export async function voiceView(store: VoiceStore, keys: KeyStore | undefined, saved?: string): Promise<VoiceView> {
  const engines = await Promise.all(store.engines.map(async engine => ({
    ...engine,
    hasKey: keys === undefined || ENGINE_KEY[engine.kind] === 'none' ? false : await keys.read(engine.id).then(key => key !== undefined, () => false),
  })))
  return {
    settings: store.settings,
    engines,
    voices: store.voices,
    keyStore: keys !== undefined,
    ...saved === undefined ? {} : { saved },
  }
}

/** 执行一个操作，保存引擎或音色时返回 id。格式错误抛 BadRequest，操作失败抛 Error。 */
export async function applyVoiceAction(store: VoiceStore, keys: KeyStore | undefined, body: unknown): Promise<string | undefined> {
  return store.action(() => performVoiceAction(store, keys, body))
}

async function performVoiceAction(store: VoiceStore, keys: KeyStore | undefined, body: unknown): Promise<string | undefined> {
  if (!isRecord(body)) throw new BadRequest('请求格式无效')
  const id = () => {
    const value = body['id']
    if (typeof value !== 'string' || value === '') throw new BadRequest('缺少 id')
    return value
  }
  switch (body['action']) {
    case 'settings.save':
      store.saveSettings(body['settings'])
      return
    case 'engine.save': {
      const draft = body['engine']
      const apiKey = isRecord(draft) ? draft['apiKey'] : undefined
      if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || apiKey.trim() === '' || apiKey.length > KEY_LIMIT || /\s/.test(apiKey.trim()))) {
        throw new BadRequest('API key 格式不对')
      }
      if (apiKey !== undefined && keys === undefined) throw new Error('DSH 没有可用的凭据库，存不了 key')
      // 先校验、再存 key、最后写连接：key 存失败时不留下一个没有 key 的新连接。
      const engine = store.draftEngine(draft)
      const changeKey = apiKey !== undefined && ENGINE_KEY[engine.kind] !== 'none'
      let oldKey: string | undefined
      if (changeKey) {
        try {
          oldKey = await keys!.read(engine.id)
          await keys!.write(engine.id, apiKey === null ? null : (apiKey as string).trim())
        } catch {
          throw new Error('密钥未能保存，服务设置未更改。请检查 DSH 凭据库后重试')
        }
      }
      try { store.commitEngine(engine) } catch {
        if (changeKey) {
          try { await keys!.write(engine.id, oldKey ?? null) } catch {
            throw new Error('服务设置未能保存，密钥也未能恢复。请检查 DSH 数据目录和凭据库后重新保存密钥')
          }
        }
        throw new Error('服务设置未能保存，请检查 DSH 数据目录是否可写后重试')
      }
      return engine.id
    }
    case 'engine.remove': {
      const engine = id()
      store.removeEngine(engine)
      // 连接已删，凭据库里的旧 key 删不掉也不影响使用。
      try { await keys?.write(engine, null) } catch { /* 同上 */ }
      return
    }
    case 'voice.save':
      return store.saveVoice(body['voice']).id
    case 'voice.remove':
      store.removeVoice(id())
      return
    default:
      throw new BadRequest('不认识的操作')
  }
}

/** 合成过的句子留在内存里：同一个气泡反复点、换会话再回来都不用再花钱。重启后清空。 */
export class AudioCache {
  private readonly entries = new Map<string, Audio>()
  private bytes = 0

  constructor(private readonly maxEntries = 64, private readonly maxBytes = 32 * 1024 * 1024) {}

  static key(engine: VoiceEngine, params: VoiceParams, text: string, tone = ''): string {
    // 代理只改路线，不改声音，不算进键里。tone 用实际发出的值：不支持的服务同一句只合成一次。
    const { proxy: _, ...config } = engine.config
    return createHash('sha256').update(JSON.stringify([engine.kind, config, params, text, effectiveTone(engine, tone)])).digest('hex')
  }

  clear(): void { this.entries.clear(); this.bytes = 0 }

  get(key: string): Audio | undefined {
    const found = this.entries.get(key)
    if (found !== undefined) { this.entries.delete(key); this.entries.set(key, found) }
    return found
  }

  set(key: string, audio: Audio): void {
    if (audio.bytes.length > this.maxBytes) return
    const old = this.entries.get(key)
    if (old !== undefined) { this.entries.delete(key); this.bytes -= old.bytes.length }
    this.entries.set(key, audio)
    this.bytes += audio.bytes.length
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldest, entry] = this.entries.entries().next().value!
      this.entries.delete(oldest)
      this.bytes -= entry.bytes.length
    }
  }
}

/** 同时最多几个合成请求。浏览器端自己也排队，这里兜底，免得一个页面把本地服务压垮。 */
const MAX_CONCURRENT = 3

export class Speaker {
  private running = 0
  private lifetime = new AbortController()
  clearCache(): void { this.lifetime.abort(); this.lifetime = new AbortController(); this.cache.clear() }

  constructor(
    private readonly store: VoiceStore,
    private readonly keys: () => KeyStore | undefined,
    private readonly cache = new AudioCache(),
    private readonly fetchImpl?: Fetch,
  ) {}

  /**
   * body：`{ voice: <id>, text, tone? }` 读已保存的音色；`{ draft: <音色草稿>, text }` 试听还没保存的音色。
   * 格式错误抛 BadRequest，合成失败抛 SynthError。
   */
  async speak(body: unknown, signal?: AbortSignal): Promise<Audio> {
    const cleanupSignal = this.lifetime.signal
    signal = signal === undefined ? cleanupSignal : AbortSignal.any([signal, cleanupSignal])
    if (!isRecord(body)) throw new BadRequest('请求格式无效')
    const text = body['text']
    if (typeof text !== 'string' || text.trim() === '') throw new BadRequest('没有要朗读的文字')
    if (text.length > SPEAK_TEXT_LIMIT) throw new BadRequest(`一次最多朗读 ${SPEAK_TEXT_LIMIT} 个字`)
    let voice: Omit<VoiceEntry, 'id'>
    if (body['draft'] !== undefined) {
      voice = this.store.draftVoice(body['draft'])
    } else {
      const found = typeof body['voice'] === 'string' ? this.store.voice(body['voice']) : undefined
      if (found === undefined) throw new SynthError('这个音色已经删掉了，在角色里重新选一个')
      voice = found
    }
    const engine = this.store.engine(voice.engine)
    if (engine === undefined) throw new SynthError('这个音色的连接已经删掉了')
    const tone = toneOf(body['tone'])
    const key = AudioCache.key(engine, voice.params, text.trim(), tone)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    if (this.running >= MAX_CONCURRENT) throw new SynthError('正在生成的语音太多，稍后再试')
    this.running++
    try {
      const keys = this.keys()
      let apiKey: string | undefined
      if (ENGINE_KEY[engine.kind] !== 'none' && keys !== undefined) {
        try {
          apiKey = await keys.read(engine.id)
        } catch {
          throw new SynthError('读不了 DSH 凭据库里的 key')
        }
      }
      const audio = await synthesize({ engine, apiKey, params: voice.params, text: text.trim(), ...tone === '' ? {} : { tone }, ...signal === undefined ? {} : { signal } }, this.fetchImpl)
      signal.throwIfAborted()
      this.cache.set(key, audio)
      return audio
    } finally {
      this.running--
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(status: number, error: VoiceError['error'], message: string): Response {
  return json(status, { error, message } satisfies VoiceError)
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new BadRequest('请求不是有效的 JSON')
  }
}

export function audioResponse(audio: Audio): Response {
  return new Response(audio.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { 'content-type': AUDIO_CONTENT_TYPES[audio.type], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}

export const inject = ['qqbot', 'connection']

export function apply(ctx: Context): void {
  const store = ctx.qqbot.voice
  // 凭据库不注入、每次现取（和 DSH 的 session-controller 一样）：没有时照常能用不要 key 的本地服务。
  const keys = (): KeyStore | undefined => {
    const credentials = ctx.get('credentials' as never) as CredentialRecords | undefined
    return credentials === undefined ? undefined : credentialKeyStore(credentials)
  }
  const speaker = new Speaker(store, keys)
  ctx.effect(() => ctx.qqbot.maintenance.register({
    cache: () => speaker.clearCache(),
    prepare: () => speaker.clearCache(),
    credentials: async () => {
      const records = ctx.get('credentials' as never) as (CredentialRecords & { listRecords(): Promise<readonly { key: string }[]> }) | undefined
      if (records === undefined) {
        if (store.engines.length > 0) throw new Error('DSH 凭据库尚未就绪，无法清理语音凭据。')
        return
      }
      for (const entry of await records.listRecords()) {
        if (/^dsh-qqbot\/tts-[a-z][a-z0-9-]*$/.test(entry.key)) await records.deleteRecord(entry.key as never)
      }
    },
  }), 'qqbot: reset voice')
  ctx.effect(() => ctx.connection.fetch.register({
    path: VOICE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async (request) => {
      let saved: string | undefined
      try {
        if (request.method === 'POST') saved = await applyVoiceAction(store, keys(), await readBody(request))
      } catch (error) {
        if (error instanceof BadRequest) return fail(400, 'bad-request', error.message)
        return fail(409, 'failed', error instanceof Error ? error.message : String(error))
      }
      return json(200, await voiceView(store, keys(), saved))
    }),
  }), 'qqbot: voice route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: SPEAK_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        ctx.qqbot.maintenance.assertAvailable()
        return audioResponse(await speaker.speak(await readBody(request), request.signal))
      } catch (error) {
        if (error instanceof BadRequest) return fail(400, 'bad-request', error.message)
        if (error instanceof SynthError) return fail(502, 'failed', error.message)
        if (request.signal.aborted) return fail(499, 'failed', '已取消')
        ctx.logger.warn('qqbot voice: %s', error)
        return fail(500, 'failed', '语音生成失败')
      }
    },
  }), 'qqbot: speak route')
}
