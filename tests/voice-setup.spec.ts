import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AUDIO_BYTE_LIMIT, speechEndpoint, synthesize, type SynthRequest } from '../src/voice-engines.ts'
import { applyVoiceAction, VoiceStore, type KeyStore } from '../src/voice.ts'

const params = { reference: 'test-voice', promptText: '参考文字', promptLang: 'zh' as const, textLang: 'zh' as const }
const request: SynthRequest = {
  engine: { id: 'e-00000001', name: '测试服务', kind: 'openai', config: { baseUrl: 'http://127.0.0.1:8880/v1', model: 'test-model' } },
  apiKey: 'test-secret-key', params, text: '你好',
}

describe('voice setup diagnostics', () => {
  it('accepts full endpoints, preserves gateway prefixes and never guesses /v1', () => {
    expect(speechEndpoint('openai', 'https://example.test/gateway/v1/audio/speech/')).toBe('https://example.test/gateway/v1/audio/speech')
    expect(speechEndpoint('openai', 'https://example.test/api/')).toBe('https://example.test/api/audio/speech')
    expect(speechEndpoint('gpt-sovits', 'http://localhost:9880/tts/')).toBe('http://localhost:9880/tts')
    expect(speechEndpoint('gpt-sovits', 'http://localhost:9880/')).toBe('http://localhost:9880/tts')
  })

  it.each([400, 200])('redacts echoed keys before truncating a status %i error', async status => {
    const key = 'test-secret-key'
    const result = synthesize(request, async () => Response.json({ error: { message: `${'x'.repeat(150)} ${key} Bearer other-test-key` } }, { status }))
    const error = await result.catch(e => e as Error)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).not.toContain(key)
    expect(message).not.toContain('test-secre')
    expect(message).not.toContain('other-test-key')
  })

  it('does not present an HTML login page as audio or raw markup', async () => {
    await expect(synthesize(request, async () => new Response('<html>private login page</html>'))).rejects.toThrow('网页地址或登录入口')
    await expect(synthesize(request, async () => new Response('<html>private login page</html>', { status: 403 }))).rejects.not.toThrow('<html>')
  })

  it('limits error response streams and cancels the remainder', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(9000).fill(65)) }, cancel,
    })
    await expect(synthesize(request, async () => new Response(stream, { status: 500 }))).rejects.toThrow('暂时无法合成（500）')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels an audio response rejected by its declared size', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    await expect(synthesize(request, async () => new Response(stream, { headers: { 'content-length': String(AUDIO_BYTE_LIMIT + 1) } }))).rejects.toThrow('音频太大')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reports body-read timeouts and preserves caller cancellation', async () => {
    const timeout = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    try {
      const run = (signal?: AbortSignal) => synthesize({ ...request, ...signal === undefined ? {} : { signal } }, async (_, init) => {
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true })
        } })
        return new Response(stream, { status: 503 })
      })
      const pending = run()
      timeout.abort(new DOMException('timeout', 'TimeoutError'))
      await expect(pending).rejects.toThrow('60 秒')
      spy.mockReturnValue(new AbortController().signal)
      const caller = new AbortController()
      const cancelled = run(caller.signal)
      caller.abort()
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    } finally { spy.mockRestore() }
  })

  it('gives GPT-SoVITS relevant access and parameter guidance', async () => {
    const sovits: SynthRequest = { ...request, apiKey: undefined, engine: { ...request.engine, kind: 'gpt-sovits' } }
    await expect(synthesize(sovits, async () => Response.json({ detail: 'denied' }, { status: 403 }))).rejects.toThrow('本连接不支持密钥认证')
    await expect(synthesize(sovits, async () => Response.json({ message: 'bad language' }, { status: 400 }))).rejects.toThrow('参考音频路径、语言和已加载的模型')
    await expect(synthesize(sovits, async () => Response.json({ message: 'tts failed', Exception: 'reference audio missing' }, { status: 400 }))).rejects.toThrow('tts failed：reference audio missing')
  })

  it('uses the real HTTP stack against local OpenAI-compatible and GPT-SoVITS mocks only', async () => {
    const seen: { url?: string; auth?: string; body: Record<string, unknown> }[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      seen.push({ ...req.url === undefined ? {} : { url: req.url }, ...req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> })
      res.setHeader('content-type', 'audio/wav')
      res.end(Buffer.from('RIFF\0\0\0\0WAVE'))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      for (const kind of ['openai', 'gpt-sovits'] as const) {
        const endpoint = kind === 'openai' ? '/v1/audio/speech' : '/tts'
        const audio = await synthesize({ ...request, engine: { ...request.engine, kind, config: { baseUrl: `${base}${endpoint}`, model: 'test-model' } } })
        expect(audio.type).toBe('wav')
      }
      expect(seen[0]).toMatchObject({ url: '/v1/audio/speech', auth: 'Bearer test-secret-key', body: { model: 'test-model', voice: 'test-voice', response_format: 'mp3' } })
      expect(seen[1]).toMatchObject({ url: '/tts', body: { ref_audio_path: 'test-voice', prompt_text: '参考文字', text_lang: 'zh', media_type: 'wav', streaming_mode: false } })
      expect(seen[1]!.auth).toBeUndefined()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('voice configuration save failures', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-voice-setup-'))
    const store = new VoiceStore(dir, () => {})
    const map = new Map<string, string>()
    const keys: KeyStore = { read: async id => map.get(id), write: async (id, key) => { if (key === null) map.delete(id); else map.set(id, key) } }
    const draft = { name: '测试', kind: 'fish', config: { baseUrl: '', model: '' }, apiKey: 'test-secret' }
    return { dir, store, map, keys, draft }
  }

  it('does not leave a phantom service after credential failure; retry succeeds', async () => {
    const { store, keys, draft } = setup()
    const failing: KeyStore = { ...keys, write: async () => { throw new Error('private credential error') } }
    await expect(applyVoiceAction(store, failing, { action: 'engine.save', engine: draft })).rejects.toThrow('密钥未能保存，服务设置未更改')
    expect(store.engines).toEqual([])
    await applyVoiceAction(store, keys, { action: 'engine.save', engine: draft })
    expect(store.engines).toHaveLength(1)
  })

  it('keeps previous configuration and credentials when a key update fails', async () => {
    const { dir, store, keys, draft, map } = setup()
    const id = await applyVoiceAction(store, keys, { action: 'engine.save', engine: draft })
    const before = readFileSync(join(dir, 'voice.json'), 'utf8')
    const failing: KeyStore = { ...keys, write: async () => { throw new Error('private credential error') } }
    await expect(applyVoiceAction(store, failing, { action: 'engine.save', engine: { ...draft, id, name: '修改名称', apiKey: 'new-test-secret' } })).rejects.toThrow('服务设置未更改')
    expect(readFileSync(join(dir, 'voice.json'), 'utf8')).toBe(before)
    expect(map.get(id!)).toBe('test-secret')
  })

  it('restores credentials if configuration persistence fails', async () => {
    const { store, keys, draft, map } = setup()
    const id = await applyVoiceAction(store, keys, { action: 'engine.save', engine: draft })
    const fail = vi.spyOn(store, 'commitEngine').mockImplementation(() => { throw new Error('disk full') })
    await expect(applyVoiceAction(store, keys, { action: 'engine.save', engine: { ...draft, id, apiKey: 'new-test-secret' } })).rejects.toThrow('数据目录是否可写')
    expect(map.get(id!)).toBe('test-secret')
    fail.mockRestore()
  })

  it('serializes overlapping saves so they cannot create duplicate services', async () => {
    const { store, keys, draft } = setup()
    const results = await Promise.allSettled([
      applyVoiceAction(store, keys, { action: 'engine.save', engine: draft }),
      applyVoiceAction(store, keys, { action: 'engine.save', engine: draft }),
    ])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(store.engines).toHaveLength(1)
  })
})
