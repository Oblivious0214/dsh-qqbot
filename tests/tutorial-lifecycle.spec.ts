import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { inject } from '../src/client/index.tsx'
import { createVoiceGuide } from '../src/client/voice-guide.ts'
import { createMemeGuide } from '../src/client/meme-guide.ts'
import { createPhoneGuide } from '../src/client/phone-guide.ts'

vi.mock('virtual:qqbot-version', () => ({ default: 'test-version' }))
vi.mock('virtual:cropper-css', () => ({ default: '' }))

describe('tutorial navigation dependency', () => {
  it('waits for late navigation and recreates all guides when its provider is replaced', async () => {
    const ctx = new Context()
    const create = vi.fn()
    const retain = vi.fn()
    for (const service of inject.filter(name => name !== 'uiWorkspace')) {
      ctx.provide(service, service === 'sessions' ? { create, retain } : {})
    }
    const factories = [createVoiceGuide, createMemeGuide, createPhoneGuide]
    const close = vi.fn()
    const initialized = vi.fn()
    const disposed = vi.fn()
    let current: ReturnType<typeof createVoiceGuide | typeof createMemeGuide | typeof createPhoneGuide>[] = []
    const feature = ctx.plugin({ inject, apply(context) {
      current = factories.map(factory => factory(context, close))
      initialized()
      context.effect(() => () => { current.forEach(guide => guide?.dispose()); current = []; disposed() })
    } })
    try {
      await Promise.resolve()
      expect(initialized).not.toHaveBeenCalled()
      const firstOpen = vi.fn()
      const navigation = ctx.plugin({ apply(context) { context.provide('uiWorkspace', { openSession: firstOpen }) } })
      await navigation.await()
      await feature.await()
      expect(current).toHaveLength(3)
      expect(current.every(Boolean)).toBe(true)
      current.forEach(guide => guide!.open('guide-session' as never))
      expect(firstOpen).toHaveBeenCalledTimes(3)
      const oldGuides = [...current]
      await navigation.dispose()
      expect(disposed).toHaveBeenCalledOnce()
      expect(current).toEqual([])
      oldGuides.forEach(guide => expect(() => guide!.open('stale' as never)).toThrow())
      const secondOpen = vi.fn()
      const replacement = ctx.plugin({ apply(context) { context.provide('uiWorkspace', { openSession: secondOpen }) } })
      await replacement.await()
      await feature.await()
      expect(initialized).toHaveBeenCalledTimes(2)
      current.forEach(guide => guide!.open('replacement-session' as never))
      expect(secondOpen).toHaveBeenCalledTimes(3)
      expect(firstOpen).toHaveBeenCalledTimes(3)
      expect(create).not.toHaveBeenCalled()
      expect(retain).not.toHaveBeenCalled()
      await replacement.dispose()
    } finally { await feature.dispose() }
  })
})
