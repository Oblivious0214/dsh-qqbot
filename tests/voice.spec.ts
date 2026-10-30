import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BadRequest } from '../src/ui.ts'
import { normalizeBaseUrl, normalizeProxyUrl, sniffAudio, synthesize, SynthError, type Fetch } from '../src/voice-engines.ts'
import { applyVoiceAction, AudioCache, credentialKeyStore, Speaker, VoiceStore, voiceView, type KeyStore } from '../src/voice.ts'
import { DEFAULT_VOICE_SETTINGS, speechText, type VoiceEngine } from '../src/voice-types.ts'

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0])
const WAV = new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WAVE'].map(c => c.charCodeAt(0))))

interface Call { url: string; init: RequestInit; body: Record<string, unknown>; headers: Record<string, string> }

/** 记下每次请求，按 respond 返回。 */
function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => new Response(MP3)) {
  const calls: Call[] = []
  const impl: Fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> }
    calls.push(call)
    return respond(call)
  }
  return { calls, impl }
}

function memoryKeys(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    read: engine => Promise.resolve(map.get(engine)),
    write: (engine, key) => { if (key === null) map.delete(engine); else map.set(engine, key); return Promise.resolve() },
  }
}

const params = { reference: 'ref-1', promptText: '', promptLang: 'zh' as const, textLang: 'zh' as const }
const fish: VoiceEngine = { id: 'e-00000001', name: 'Fish', kind: 'fish', config: { baseUrl: '', model: 's2.1-pro-free' } }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-voice-'))
  return { dir, store: new VoiceStore(dir, () => {}), keys: memoryKeys() }
}

describe('speech text', () => {
  it('drops markdown, links, code and action descriptions', () => {
    expect(speechText('**你好**，看[这里](https://x.y)。（摸摸头）*笑* `code` https://a.b/c 好的')).toBe('你好，看这里。 好的')
    expect(speechText('喵~ ~~删掉的~~')).toBe('喵~ 删掉的')
    expect(speechText('（转身离开）')).toBe('')
    expect(speechText('x'.repeat(600))).toHaveLength(500)
  })
})

describe('engine requests', () => {
  it('builds the Fish Audio request with the model header and bearer key', async () => {
    const { calls, impl } = fakeFetch()
    const audio = await synthesize({ engine: fish, apiKey: 'sk-1', params, text: '你好' }, impl)
    expect(audio.type).toBe('mp3')
    expect(calls[0]!.url).toBe('https://api.fish.audio/v1/tts')
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer sk-1', model: 's2.1-pro-free' })
    expect(calls[0]!.body).toMatchObject({ text: '你好', reference_id: 'ref-1', format: 'mp3' })
    expect(calls[0]!.init.redirect).toBe('manual')
    await expect(synthesize({ engine: fish, apiKey: undefined, params, text: '你好' }, impl)).rejects.toThrow('API key')
  })

  it('builds the OpenAI-compatible request without a key for local servers', async () => {
    const { calls, impl } = fakeFetch()
    const engine: VoiceEngine = { id: 'e-00000002', name: '本地', kind: 'openai', config: { baseUrl: 'http://127.0.0.1:8880/v1/', model: 'kokoro' } }
    await synthesize({ engine, apiKey: undefined, params: { ...params, reference: 'zf_xiaoxiao' }, text: '你好' }, impl)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8880/v1/audio/speech')
    expect(calls[0]!.headers['authorization']).toBeUndefined()
    expect(calls[0]!.body).toEqual({ model: 'kokoro', input: '你好', voice: 'zf_xiaoxiao', response_format: 'mp3' })
  })

  it('builds the GPT-SoVITS api_v2 request', async () => {
    const { calls, impl } = fakeFetch(() => new Response(WAV))
    const engine: VoiceEngine = { id: 'e-00000003', name: 'SoVITS', kind: 'gpt-sovits', config: { baseUrl: 'http://127.0.0.1:9880', model: '' } }
    const audio = await synthesize({ engine, apiKey: undefined, params: { reference: 'D:/ref.wav', promptText: '参考', promptLang: 'ja', textLang: 'zh' }, text: '你好' }, impl)
    expect(audio.type).toBe('wav')
    expect(calls[0]!.url).toBe('http://127.0.0.1:9880/tts')
    expect(calls[0]!.body).toMatchObject({ text: '你好', text_lang: 'zh', ref_audio_path: 'D:/ref.wav', prompt_text: '参考', prompt_lang: 'ja', media_type: 'wav' })
  })

  it('turns upstream failures into messages a user can act on', async () => {
    const reply = (response: Response) => fakeFetch(() => response).impl
    const run = (impl: Fetch) => synthesize({ engine: fish, apiKey: 'sk-1', params, text: '你好' }, impl)
    await expect(run(reply(Response.json({ message: 'invalid token' }, { status: 401 })))).rejects.toThrow('检查 API key：invalid token')
    await expect(run(reply(Response.json({ detail: 'no credit' }, { status: 402 })))).rejects.toThrow('余额不足')
    await expect(run(reply(new Response(null, { status: 302, headers: { location: 'http://evil' } })))).rejects.toThrow('跳转')
    await expect(run(reply(Response.json({ error: 'busy' })))).rejects.toThrow('返回的不是音频')
    const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    const local: VoiceEngine = { id: 'e-00000003', name: 'SoVITS', kind: 'gpt-sovits', config: { baseUrl: 'http://127.0.0.1:9880', model: '' } }
    await expect(synthesize({ engine: local, apiKey: undefined, params, text: '你好' }, refused)).rejects.toThrow('确认它已经启动')
  })

  it('passes a caller abort through instead of reporting a network error', async () => {
    const controller = new AbortController()
    const impl: Fetch = (_, init) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    })
    const pending = synthesize({ engine: fish, apiKey: 'sk-1', params, text: '你好', signal: controller.signal }, impl)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('checks base urls and audio headers', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:9880/ ')).toBe('http://127.0.0.1:9880')
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(SynthError)
    expect(() => normalizeBaseUrl('http://u:p@x')).toThrow('账号密码')
    expect(() => normalizeBaseUrl('127.0.0.1:9880')).toThrow()
    expect(sniffAudio(MP3)).toBe('mp3')
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90]))).toBe('mp3')
    expect(sniffAudio(new Uint8Array([0xff, 0xf1, 0x50]))).toBe('aac')
    expect(sniffAudio(new TextEncoder().encode('{"ok":false}'))).toBeUndefined()
  })
})

describe('fish proxy', () => {
  /** 假代理：记下 CONNECT 的目标，按 reply 回应；不转发，所以不会连到真的 Fish Audio。 */
  async function fakeProxy(reply: string): Promise<{ server: Server; url: string; seen: string[] }> {
    const seen: string[] = []
    const server = createServer((_, response) => { response.writeHead(502); response.end() })
    server.on('connect', (request, socket) => { seen.push(request.url ?? ''); socket.end(reply) })
    const address = await new Promise<AddressInfo>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) }) })
    return { server, url: `127.0.0.1:${address.port}`, seen }
  }
  const close = (server: Server) => new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  const via = (url: string, enabled = true): VoiceEngine => ({ ...fish, config: { ...fish.config, proxy: { enabled, url } } })

  it('tunnels through the proxy when enabled and skips it when off', async () => {
    const proxy = await fakeProxy('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    try {
      const { calls, impl } = fakeFetch()
      await expect(synthesize({ engine: via(proxy.url), apiKey: 'sk-1', params, text: '你好' }, impl)).rejects.toThrow('通过代理连不上 Fish Audio')
      expect(proxy.seen).toEqual(['api.fish.audio:443'])
      expect(calls).toEqual([])
      await synthesize({ engine: via(proxy.url, false), apiKey: 'sk-1', params, text: '你好' }, impl)
      expect(calls).toHaveLength(1)
      expect(proxy.seen).toHaveLength(1)
    } finally {
      await close(proxy.server)
    }
  })

  it('says so when the proxy itself is not running', async () => {
    const proxy = await fakeProxy('')
    const url = proxy.url
    await close(proxy.server)
    await expect(synthesize({ engine: via(url), apiKey: 'sk-1', params, text: '你好' })).rejects.toThrow(`连不上代理 ${url}`)
  })

  it('checks proxy addresses and only when the proxy is on', async () => {
    expect(normalizeProxyUrl(' 127.0.0.1:7897 ')).toBe('http://127.0.0.1:7897')
    expect(normalizeProxyUrl('http://localhost:7890/')).toBe('http://localhost:7890')
    expect(() => normalizeProxyUrl('socks5://127.0.0.1:7897')).toThrow('只支持 HTTP 代理')
    expect(() => normalizeProxyUrl('127.0.0.1')).toThrow('要带端口')
    expect(() => normalizeProxyUrl('http://u:p@127.0.0.1:7897')).toThrow('账号密码')
    const { store } = setup()
    expect(() => store.saveEngine({ name: 'Fish', kind: 'fish', config: { baseUrl: '', model: '', proxy: { enabled: true, url: '127.0.0.1' } } })).toThrow(BadRequest)
    const off = store.saveEngine({ name: 'Fish', kind: 'fish', config: { baseUrl: '', model: '', proxy: { enabled: false, url: '' } } })
    expect(off.config.proxy).toEqual({ enabled: false, url: 'http://127.0.0.1:7897' })
    const on = store.saveEngine({ id: off.id, name: 'Fish', kind: 'fish', config: { baseUrl: '', model: '', proxy: { enabled: true, url: '127.0.0.1:7890' } } })
    expect(on.config.proxy).toEqual({ enabled: true, url: 'http://127.0.0.1:7890' })
    const local = store.saveEngine({ name: '本地', kind: 'openai', config: { baseUrl: 'http://127.0.0.1:8880/v1', model: '', proxy: { enabled: true, url: '127.0.0.1:7890' } } })
    expect(local.config.proxy).toBeUndefined()
    expect(AudioCache.key(on, params, '你好')).toBe(AudioCache.key(off, params, '你好'))
  })
})

describe('voice store', () => {
  it('saves engines and voices with generated ids and keeps keys out of voice.json', async () => {
    const { dir, store, keys } = setup()
    const engine = await applyVoiceAction(store, keys, { action: 'engine.save', engine: { name: 'Fish', kind: 'fish', config: { baseUrl: '', model: '' }, apiKey: ' sk-secret ' } })
    expect(engine).toMatch(/^e-[0-9a-f]{8}$/)
    expect(keys.map.get(engine!)).toBe('sk-secret')
    const voice = await applyVoiceAction(store, keys, { action: 'voice.save', voice: { name: '小雅', engine, params } })
    expect(voice).toMatch(/^v-[0-9a-f]{8}$/)
    const file = readFileSync(join(dir, 'voice.json'), 'utf8')
    expect(file).not.toContain('sk-secret')
    const view = await voiceView(new VoiceStore(dir, () => {}), keys)
    expect(view.engines).toEqual([{ id: engine, name: 'Fish', kind: 'fish', config: { baseUrl: '', model: 's2.1-pro-free', proxy: { enabled: false, url: 'http://127.0.0.1:7897' } }, hasKey: true }])
    expect(view.voices).toEqual([{ id: voice, name: '小雅', engine, params: { reference: 'ref-1', promptText: '', promptLang: 'zh', textLang: 'zh' } }])
    expect(JSON.stringify(view)).not.toContain('sk-secret')
  })

  it('changes or removes a key only when asked', async () => {
    const { store, keys } = setup()
    const draft = { name: 'Fish', kind: 'fish', config: { baseUrl: '', model: '' } }
    const id = await applyVoiceAction(store, keys, { action: 'engine.save', engine: { ...draft, apiKey: 'sk-1' } })
    await applyVoiceAction(store, keys, { action: 'engine.save', engine: { ...draft, id, name: 'Fish 2' } })
    expect(keys.map.get(id!)).toBe('sk-1')
    await applyVoiceAction(store, keys, { action: 'engine.save', engine: { ...draft, id, apiKey: null } })
    expect(keys.map.has(id!)).toBe(false)
    await expect(applyVoiceAction(store, keys, { action: 'engine.save', engine: { ...draft, id, apiKey: 'a b' } })).rejects.toThrow(BadRequest)
    await expect(applyVoiceAction(store, undefined, { action: 'engine.save', engine: { ...draft, apiKey: 'sk' } })).rejects.toThrow('凭据库')
  })

  it('refuses duplicate names, kind changes and removing an engine still in use', async () => {
    const { store, keys } = setup()
    const engine = store.saveEngine({ name: '本地', kind: 'gpt-sovits', config: { baseUrl: 'http://127.0.0.1:9880', model: '' } })
    expect(() => store.saveEngine({ name: '本地', kind: 'openai', config: { baseUrl: 'http://x', model: '' } })).toThrow('已经有叫')
    expect(() => store.saveEngine({ id: engine.id, name: '本地', kind: 'openai', config: { baseUrl: 'http://x', model: '' } })).toThrow('不能改连接的类型')
    expect(() => store.saveEngine({ name: '坏', kind: 'openai', config: { baseUrl: 'localhost', model: '' } })).toThrow(BadRequest)
    store.saveVoice({ name: '小雅', engine: engine.id, params })
    expect(() => store.saveVoice({ name: '小雅', engine: engine.id, params })).toThrow('已经有叫')
    expect(() => store.saveVoice({ name: '无连接', engine: 'e-99999999', params })).toThrow('先选一个连接')
    expect(() => store.saveVoice({ name: '坏语言', engine: engine.id, params: { ...params, textLang: 'fr' } })).toThrow('朗读语言')
    await expect(applyVoiceAction(store, keys, { action: 'engine.remove', id: engine.id })).rejects.toThrow('还有音色在用这个连接：小雅')
    await applyVoiceAction(store, keys, { action: 'voice.remove', id: store.voices[0]!.id })
    await applyVoiceAction(store, keys, { action: 'engine.remove', id: engine.id })
    expect(store.engines).toEqual([])
  })

  it('keeps the readable entries of a hand-edited file', () => {
    const { dir } = setup()
    writeFileSync(join(dir, 'voice.json'), JSON.stringify({
      settings: { display: 'both', volume: 3 },
      engines: [fish, { id: 'bad', name: 'x', kind: 'fish', config: {} }],
      voices: [{ id: 'v-00000001', name: 'A', engine: fish.id, params }, { id: 'v-00000002', name: 'B', engine: 'e-99999999', params }],
    }))
    const warnings: string[] = []
    const store = new VoiceStore(dir, (message) => { warnings.push(message) })
    expect(store.settings).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(store.engines.map(item => item.id)).toEqual([fish.id])
    expect(store.voices.map(item => item.id)).toEqual(['v-00000001'])
    expect(warnings).toHaveLength(2)
  })
})

describe('speaker', () => {
  function ready() {
    const { store, keys } = setup()
    const engine = store.saveEngine({ name: 'Fish', kind: 'fish', config: { baseUrl: '', model: '' } })
    void keys.write(engine.id, 'sk-1')
    const voice = store.saveVoice({ name: '小雅', engine: engine.id, params })
    return { store, keys, engine, voice }
  }

  it('synthesizes saved voices once and serves repeats from the cache', async () => {
    const { store, keys, voice } = ready()
    const { calls, impl } = fakeFetch()
    const speaker = new Speaker(store, () => keys, new AudioCache(), impl)
    await speaker.speak({ voice: voice.id, text: ' 你好 ' })
    await speaker.speak({ voice: voice.id, text: '你好' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-1')
  })

  it('previews an unsaved voice and explains deleted voices', async () => {
    const { store, keys, engine } = ready()
    const { calls, impl } = fakeFetch()
    const speaker = new Speaker(store, () => keys, new AudioCache(), impl)
    await speaker.speak({ draft: { name: '试听', engine: engine.id, params: { ...params, reference: 'ref-2' } }, text: '你好' })
    expect(calls[0]!.body['reference_id']).toBe('ref-2')
    await expect(speaker.speak({ voice: 'v-99999999', text: '你好' })).rejects.toThrow('已经删掉')
    await expect(speaker.speak({ voice: 'v-99999999', text: ' ' })).rejects.toThrow(BadRequest)
  })

  it('limits concurrent synthesis', async () => {
    const { store, keys, voice } = ready()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { impl } = fakeFetch(async () => { await gate; return new Response(MP3) })
    const speaker = new Speaker(store, () => keys, new AudioCache(), impl)
    const pending = [1, 2, 3].map(n => speaker.speak({ voice: voice.id, text: `第${n}句` }))
    await expect(speaker.speak({ voice: voice.id, text: '第4句' })).rejects.toThrow('太多')
    release()
    await Promise.all(pending)
  })

  it('evicts the oldest audio past the limits', () => {
    const cache = new AudioCache(2, 100)
    const audio = (size: number) => ({ type: 'mp3' as const, bytes: new Uint8Array(size) })
    cache.set('a', audio(10))
    cache.set('b', audio(10))
    cache.get('a')
    cache.set('c', audio(10))
    expect([cache.get('a'), cache.get('b'), cache.get('c')].map(item => item !== undefined)).toEqual([true, false, true])
    cache.set('d', audio(95))
    expect(cache.get('a')).toBeUndefined()
  })
})

describe('credential records', () => {
  it('stores keys as api-key records under dsh-qqbot/tts-<engine>', async () => {
    const records = new Map<string, unknown>()
    const credentials = {
      readRecord: (key: never) => Promise.resolve(records.get(key) as { kind: string; key?: string } | undefined),
      modifyRecord: async (key: never, mutate: (current: unknown) => Promise<unknown>) => { records.set(key, await mutate(records.get(key))); return records.get(key) },
      deleteRecord: (key: never) => { records.delete(key); return Promise.resolve() },
    }
    const keys = credentialKeyStore(credentials)
    await keys.write('e-0000000a', 'sk-1')
    expect([...records]).toEqual([['dsh-qqbot/tts-e-0000000a', { kind: 'api-key', key: 'sk-1' }]])
    expect(await keys.read('e-0000000a')).toBe('sk-1')
    await keys.write('e-0000000a', null)
    expect(await keys.read('e-0000000a')).toBeUndefined()
    await expect(keys.read('../x')).rejects.toThrow(BadRequest)
  })
})
