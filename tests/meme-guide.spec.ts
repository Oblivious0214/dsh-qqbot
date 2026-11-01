import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemeGuide, createMemeGuide } from '../src/client/meme-guide.ts'
import type { StandardGuideHost } from '../src/client/standard-guide.ts'
import { memeGuidePrompt } from '../src/meme-guide.ts'

function bench(preset = 'standard') {
  const release = vi.fn()
  const prompt = vi.fn(async () => ({ ok: true }))
  const beginSubmission = vi.fn(() => ({ requestId: 'meme-request' }))
  const session = { getSnapshot: () => ({ openState: 'open' }), projections: { faceOf: () => ({ getSnapshot: () => preset }) }, beginSubmission, prompt }
  const create = vi.fn(async (_: unknown) => 'new-meme-guide')
  const retain = vi.fn(() => ({ ready: Promise.resolve({ session }), release }))
  const host = { sessions: { create, retain }, open: vi.fn(), closeEditor: vi.fn() }
  return { guide: new MemeGuide(host as unknown as StandardGuideHost), host, create, retain, release, prompt, beginSubmission }
}

describe('meme setup guide', () => {
  it('creates and submits only on launch, with an explicit standard preset and no role data', async () => {
    const b = bench()
    expect(b.create).not.toHaveBeenCalled()
    const first = b.guide.launch('meme')
    expect(b.guide.launch('meme')).toBe(first)
    const result = await first
    expect(result).toEqual({ ok: true, sessionId: 'new-meme-guide' })
    expect(b.create).toHaveBeenCalledExactlyOnceWith({ agentPreset: 'standard' })
    expect(b.retain).toHaveBeenCalledWith('new-meme-guide', expect.objectContaining({ source: 'qqbotMemeGuide' }))
    expect(b.beginSubmission).toHaveBeenCalledExactlyOnceWith({ mode: 'queue', text: memeGuidePrompt(), attachments: [] })
    expect(b.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: memeGuidePrompt() }], 'queue', expect.any(AbortSignal), 'meme-request')
    expect(b.release).toHaveBeenCalledOnce()
    expect(b.host.open).not.toHaveBeenCalled()
    if (result.ok) b.guide.open(result.sessionId)
    expect(b.host.open).toHaveBeenCalledExactlyOnceWith('new-meme-guide')
    expect(b.host.closeEditor).toHaveBeenCalledOnce()
    await b.guide.launch('meme')
    expect(b.create).toHaveBeenCalledOnce()
    expect(b.prompt).toHaveBeenCalledOnce()
  })

  it('uses the host navigation adapter and can fall back when navigation is missing', () => {
    expect(createMemeGuide({ get: () => undefined } as unknown as Context, vi.fn())).toBeUndefined()
    const b = bench()
    const openSession = vi.fn()
    const close = vi.fn()
    const guide = createMemeGuide({ get: () => ({ openSession }), sessions: b.host.sessions } as unknown as Context, close)!
    guide.open('test' as never)
    expect(openSession).toHaveBeenCalledWith('test')
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a qqbot session before sending', async () => {
    const b = bench('qqbot')
    expect(await b.guide.launch('meme')).toMatchObject({ ok: false, prompt: memeGuidePrompt() })
    expect(b.prompt).not.toHaveBeenCalled()
    expect(b.release).toHaveBeenCalledOnce()
  })

  it('keeps a failed attempt copyable without leaking errors or resending', async () => {
    const b = bench()
    b.prompt.mockRejectedValue(new Error('private-host-path'))
    const result = await b.guide.launch('meme')
    expect(result).toMatchObject({ ok: false, sessionId: 'new-meme-guide', prompt: memeGuidePrompt() })
    expect(JSON.stringify(result)).not.toContain('private-host-path')
    await b.guide.launch('meme')
    expect(b.prompt).toHaveBeenCalledOnce()
  })

  it('unload prevents late creation from sending', async () => {
    const b = bench()
    let finish!: (id: string) => void
    b.create.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = b.guide.launch('meme')
    b.guide.dispose()
    expect((await pending).ok).toBe(false)
    finish('late')
    await Promise.resolve()
    expect(b.prompt).not.toHaveBeenCalled()
    expect(b.retain).not.toHaveBeenCalled()
  })
})
