/**
 * 调用各家语音合成接口，返回音频字节。只在 host 端运行：key 不进浏览器，本地服务的地址也不用对浏览器开放。
 * 请求格式：
 * - fish：POST https://api.fish.audio/v1/tts，`model` 放在请求头（参考 dsh-fish-tts，MIT，MaRi23333 的 synthesize()）。
 * - openai：POST `<baseUrl>/audio/speech`，`{ model, input, voice, response_format }`。
 * - gpt-sovits：POST `<baseUrl>/tts`，api_v2.py 的请求体。
 */

import type { EngineKind, VoiceEngine, VoiceParams } from './voice-types.ts'

export const FISH_API_URL = 'https://api.fish.audio/v1/tts'
/** 合成一句一般几秒；本地 GPT-SoVITS 第一次加载模型会慢一些。 */
export const SYNTH_TIMEOUT_MS = 60_000
export const AUDIO_BYTE_LIMIT = 10 * 1024 * 1024

export type AudioType = 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac'

export const AUDIO_CONTENT_TYPES: Record<AudioType, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
}

export interface Audio {
  readonly type: AudioType
  readonly bytes: Uint8Array
}

/** 合成失败，message 可以直接展示给用户。 */
export class SynthError extends Error {}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface SynthRequest {
  readonly engine: VoiceEngine
  readonly apiKey: string | undefined
  readonly params: VoiceParams
  readonly text: string
  readonly signal?: AbortSignal
}

/** 用户填的地址：只认 http/https，不带账号密码，去掉末尾的斜杠。不合规时抛出可以展示的错误。 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new SynthError('地址格式不对，例如 http://127.0.0.1:9880')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SynthError('地址要以 http:// 或 https:// 开头')
  if (url.username !== '' || url.password !== '') throw new SynthError('地址里不要带账号密码，key 填在下面')
  if (url.search !== '' || url.hash !== '') throw new SynthError('地址里不要带 ? 或 # 后面的部分')
  return url.href.replace(/\/+$/, '')
}

function buildRequest(request: SynthRequest): { url: string; init: RequestInit } {
  const { engine, apiKey, params, text } = request
  const json = (body: unknown, headers: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const bearer: Record<string, string> = apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }
  switch (engine.kind) {
    case 'fish':
      if (bearer['authorization'] === undefined) throw new SynthError('还没有填 Fish Audio 的 API key')
      return {
        url: FISH_API_URL,
        init: json({ text, reference_id: params.reference, format: 'mp3', normalize: true, latency: 'balanced' },
          { ...bearer, model: engine.config.model }),
      }
    case 'openai':
      return {
        url: `${normalizeBaseUrl(engine.config.baseUrl)}/audio/speech`,
        init: json({ model: engine.config.model, input: text, voice: params.reference, response_format: 'mp3' }, bearer),
      }
    case 'gpt-sovits':
      return {
        url: `${normalizeBaseUrl(engine.config.baseUrl)}/tts`,
        init: json({
          text, text_lang: params.textLang,
          ref_audio_path: params.reference, prompt_text: params.promptText, prompt_lang: params.promptLang,
          media_type: 'wav', streaming_mode: false, text_split_method: 'cut5',
        }, {}),
      }
  }
}

/** 按文件头认音频格式，不信任响应声明的类型（有的服务出错时也返回 200 和一段 JSON）。 */
export function sniffAudio(bytes: Uint8Array): AudioType | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav'
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg'
  if (bytes.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac'
  if (bytes.length >= 3 && ascii(0, 3) === 'ID3') return 'mp3'
  // ADTS（AAC）的同步字是 12 位 1、layer 为 0；MP3 帧同步是 11 位 1、layer 不为 0。
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return 'aac'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0) return 'mp3'
  return undefined
}

const KIND_NAMES: Record<EngineKind, string> = { fish: 'Fish Audio', openai: '语音服务', 'gpt-sovits': 'GPT-SoVITS' }

function statusMessage(kind: EngineKind, status: number): string {
  const who = KIND_NAMES[kind]
  if (status === 401 || status === 403) return `${who}拒绝了请求，检查 API key`
  if (status === 402) return `${who}账户余额不足`
  if (status === 404) return kind === 'fish' ? '找不到这个音色，检查音色 ID' : `${who}没有这个接口，检查地址`
  if (status === 429) return `${who}请求太频繁，稍后再试`
  if (status === 400 || status === 422) return `${who}不接受这个请求，检查音色设置`
  return `${who}出错了（${status}）`
}

/** 上游返回的错误详情，截短后附在提示后面；只取文本，不会带出 key。 */
async function detail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  let message = text
  try {
    const body: unknown = JSON.parse(text)
    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const found = [record['message'], record['detail'], record['error'], record['Exception']].find(v => typeof v === 'string')
      if (typeof found === 'string') message = found
      else if (record['error'] !== null && typeof record['error'] === 'object') {
        const nested = (record['error'] as Record<string, unknown>)['message']
        if (typeof nested === 'string') message = nested
      }
    }
  } catch { /* 不是 JSON，用原文 */ }
  return message.length > 160 ? `${message.slice(0, 160)}…` : message
}

/** 读响应体，超过上限就停。 */
async function readLimited(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > AUDIO_BYTE_LIMIT) throw new SynthError('返回的音频太大')
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > AUDIO_BYTE_LIMIT) {
      await reader.cancel().catch(() => {})
      throw new SynthError('返回的音频太大')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

function networkMessage(kind: EngineKind, error: unknown, timedOut: boolean): string {
  if (timedOut) return `${KIND_NAMES[kind]}超过 ${SYNTH_TIMEOUT_MS / 1000} 秒没有返回`
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code
  if (code === 'ECONNREFUSED') return kind === 'fish' ? '连不上 Fish Audio' : `连不上${KIND_NAMES[kind]}，确认它已经启动，地址和端口没填错`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '找不到这个地址，检查网络或地址'
  return `连不上${KIND_NAMES[kind]}，检查网络或地址`
}

/** 合成一句。失败时抛 SynthError；调用方取消时抛 AbortError。 */
export async function synthesize(request: SynthRequest, fetchImpl: Fetch = fetch): Promise<Audio> {
  const { url, init } = buildRequest(request)
  const timeout = AbortSignal.timeout(SYNTH_TIMEOUT_MS)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  let response: Response
  try {
    // 不跟随跳转：地址是用户填的，跳转后 key 可能被带到别的地方。
    response = await fetchImpl(url, { ...init, signal, redirect: 'manual' })
  } catch (error) {
    if (request.signal?.aborted === true) throw error
    throw new SynthError(networkMessage(request.engine.kind, error, timeout.aborted))
  }
  if (response.status >= 300 && response.status < 400) throw new SynthError('语音服务要求跳转到别的地址，请直接填最终地址')
  if (!response.ok) {
    const more = await detail(response)
    throw new SynthError(`${statusMessage(request.engine.kind, response.status)}${more === '' ? '' : `：${more}`}`)
  }
  let bytes: Uint8Array
  try {
    bytes = await readLimited(response)
  } catch (error) {
    if (error instanceof SynthError || request.signal?.aborted === true) throw error
    throw new SynthError(networkMessage(request.engine.kind, error, timeout.aborted))
  }
  const type = sniffAudio(bytes)
  if (type === undefined) {
    const text = new TextDecoder().decode(bytes.subarray(0, 160)).replace(/\s+/g, ' ').trim()
    throw new SynthError(`返回的不是音频${text === '' ? '' : `：${text}`}`)
  }
  return { type, bytes }
}
