import { describe, expect, it, vi } from 'vitest'
import { VoiceGuide, createVoiceGuide, type VoiceGuideHost } from '../src/client/voice-guide.ts'
import { voiceGuidePrompt } from '../src/voice-guide.ts'
import type { Context } from '@deepseek-ai/cordis'

function bench({ preset = 'standard', openState = 'open', accepted = true } = {}) {
  const release = vi.fn()
  const prompt = vi.fn(async () => accepted ? { ok: true, value: { accepted: true } } : { ok: false, error: { message: 'private rejection' } })
  const beginSubmission = vi.fn(() => ({ requestId: 'test-request', abandon: vi.fn() }))
  const session = { getSnapshot: () => ({ openState }), projections: { faceOf: () => ({ getSnapshot: () => preset }) }, beginSubmission, prompt }
  const create = vi.fn(async (_: unknown) => 'new-standard-session')
  const retain = vi.fn(() => ({ ready: Promise.resolve({ session }), release }))
  const host = { sessions: { create, retain }, open: vi.fn(), closeEditor: vi.fn() }
  const guide = new VoiceGuide(host as unknown as VoiceGuideHost)
  return { guide, host, session, create, retain, prompt, release, beginSubmission }
}

describe('standard voice setup guide', () => {
  it.each(['auto', 'fish', 'openai', 'gpt-sovits'] as const)('creates a new explicit standard session and sends the %s guide once', async kind => {
    const b = bench()
    expect(b.create).not.toHaveBeenCalled()
    const result = await b.guide.launch(kind)
    expect(result.ok).toBe(true)
    expect(b.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'standard' })
    expect(b.retain).toHaveBeenCalledWith('new-standard-session', expect.objectContaining({ source: 'qqbotVoiceGuide' }))
    expect(b.beginSubmission).toHaveBeenCalledWith({ mode: 'queue', text: voiceGuidePrompt(kind), attachments: [] })
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: voiceGuidePrompt(kind) }], 'queue', expect.any(AbortSignal), 'test-request')
    expect(b.release).toHaveBeenCalledOnce()
    expect(b.host.open).not.toHaveBeenCalled()
    if (result.ok) b.guide.open(result.sessionId)
    expect(b.host.open).toHaveBeenCalledWith('new-standard-session')
    expect(b.host.closeEditor).toHaveBeenCalledOnce()
  })

  it('coalesces duplicate clicks and reuses the result after reopening the editor', async () => {
    const b = bench()
    const first = b.guide.launch('fish')
    const second = b.guide.launch('fish')
    expect(first).toBe(second)
    await first
    await b.guide.launch('fish')
    expect(b.create).toHaveBeenCalledOnce()
    expect(b.prompt).toHaveBeenCalledOnce()
  })

  it('keeps failed attempts for copy fallback rather than blindly resending', async () => {
    const b = bench({ accepted: false })
    const result = await b.guide.launch('fish')
    expect(result).toMatchObject({ ok: false, sessionId: 'new-standard-session', prompt: voiceGuidePrompt('fish') })
    expect(result).not.toHaveProperty('error')
    expect(JSON.stringify(result)).not.toContain('private rejection')
    await b.guide.launch('fish')
    expect(b.prompt).toHaveBeenCalledOnce()
    expect(b.release).toHaveBeenCalledOnce()
    expect(b.host.closeEditor).not.toHaveBeenCalled()
  })

  it('returns a copyable guide without leaking create errors', async () => {
    const b = bench()
    b.create.mockRejectedValue(new Error('private-host-address-and-key'))
    const result = await b.guide.launch('openai')
    expect(result).toMatchObject({ ok: false, prompt: voiceGuidePrompt('openai') })
    expect(JSON.stringify(result)).not.toContain('private-host-address-and-key')
    expect(b.prompt).not.toHaveBeenCalled()
  })

  it.each([{ preset: 'qqbot' }, { openState: 'error' }])('does not send into a mismatched or failed session: %j', async options => {
    const b = bench(options)
    expect((await b.guide.launch('fish')).ok).toBe(false)
    expect(b.prompt).not.toHaveBeenCalled()
    expect(b.release).toHaveBeenCalledOnce()
  })

  it('unload prevents a late create response from submitting a deployment', async () => {
    const b = bench()
    let complete!: (id: string) => void
    b.create.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const pending = b.guide.launch('fish')
    b.guide.dispose()
    expect((await pending).ok).toBe(false)
    complete('late-session')
    await Promise.resolve()
    expect(b.retain).not.toHaveBeenCalled()
    expect(b.prompt).not.toHaveBeenCalled()
  })

  it('timeout provides fallback and a late create response never sends', async () => {
    vi.useFakeTimers()
    try {
      const b = bench()
      let complete!: (id: string) => void
      b.create.mockReturnValue(new Promise(resolve => { complete = resolve }))
      const pending = b.guide.launch('fish')
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await pending).ok).toBe(false)
      complete('late-session')
      await Promise.resolve()
      expect(b.prompt).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('does not bind when host navigation is unavailable', () => {
    const ctx = { get: vi.fn(() => undefined) }
    expect(createVoiceGuide(ctx as unknown as Context, vi.fn())).toBeUndefined()
  })

  it('gives Fish signup, key and voice-discovery links with proxy only as fallback', () => {
    const fish = voiceGuidePrompt('fish')
    expect(fish).toContain('https://fish.audio/zh-CN/app/developers/')
    expect(fish).toContain('https://fish.audio/zh-CN/app/discovery/')
    expect(fish).toContain('三个小点')
    expect(fish).toContain('试听连不上时')
    expect(voiceGuidePrompt('gpt-sovits')).toContain('api_v2')
    for (const kind of ['fish', 'openai', 'gpt-sovits'] as const) {
      const text = voiceGuidePrompt(kind)
      expect(text).toContain('“API 密钥”')
      expect(text).toContain('角色')
      expect(text).not.toContain('Bearer ')
    }
  })

  it('asks about prior experience first, reuses existing services and falls back to Fish', () => {
    const prompt = voiceGuidePrompt()
    expect(prompt).toBe(voiceGuidePrompt('auto'))
    expect(prompt).toContain('之前搞过 AI 语音吗？')
    expect(prompt).toContain('GPT-SoVITS')
    expect(prompt).toContain('第一次碰就走 Fish Audio')
    expect(prompt).not.toContain('非商业推广')
  })
})
