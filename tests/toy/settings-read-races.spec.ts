import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToyHost } from '../../src/toy/index.ts'
import { ToyController } from '../../src/toy/client/controller.ts'
import { defaultSettings } from '../../src/toy/settings.ts'
import type { ToyView } from '../../src/toy/api-types.ts'
import { FakeClock, MockTransport, flush } from './fakes.ts'

describe('older toy reads after autosave', () => {
  for (const mode of ['load', 'watch'] as const) {
    it(`does not roll back settings or action library after a delayed ${mode}`, async () => {
      const host = new ToyHost(mkdtempSync(join(tmpdir(), 'qqbot-read-race-')), () => {})
      host.settings.save({ ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true })
      const clock = new FakeClock(), transport = new MockTransport(clock)
      transport.setPhase('disconnected')
      let delayed = false, finish!: (view: ToyView) => void
      const controller = new ToyController({ kind: 'buttplug', clock, transport: () => transport, api: {
        get: async () => delayed ? new Promise<ToyView>(resolve => { finish = resolve }) : host.view(),
        watch: async () => new Promise<ToyView>(resolve => { finish = resolve }),
        post: async action => host.view(host.apply(action)), beacon() {},
      } })
      await controller.load()
      const old = structuredClone(host.view())
      delayed = true
      const pending = mode === 'load' ? controller.load() : controller.watch()
      const base = controller.getSnapshot().actionLibrary!
      await controller.updateSettings(latest => ({ ...latest, motion: { ...latest.motion, maxSpeed: 400 } }))
      await controller.saveActionLibrary({ ...base, library: { ...base.library, clips: base.library.clips.map((c, i) => i ? c : { ...c, description: '已保存的新说明' }) } }, base)
      finish(old)
      await flush()
      if (mode === 'load') await pending
      expect(controller.getSnapshot().settings?.motion.maxSpeed).toBe(400)
      expect(controller.getSnapshot().actionLibrary?.library.clips[0]?.description).toBe('已保存的新说明')
      await controller.updateSettings(latest => ({ ...latest, hotkey: 'Ctrl+KeyM' }))
      expect(host.settings.value.motion.maxSpeed).toBe(400)
      expect(transport.moves).toEqual([])
      controller.dispose()
      if (mode === 'watch') { finish(host.view()); await pending }
    })
  }
})
