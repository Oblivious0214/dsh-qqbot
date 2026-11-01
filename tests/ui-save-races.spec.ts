import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiState } from '../src/client/ui-state.ts'
import { DEFAULT_UI_SETTINGS } from '../src/ui-types.ts'

afterEach(() => vi.unstubAllGlobals())

describe('settings saved while older UI reads are pending', () => {
  for (const read of ['reload', 'refreshRole', 'setRole'] as const) {
    it(`does not roll back settings or images after ${read}`, async () => {
      let finish!: (response: Response) => void
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
      const ui = new UiState()
      const pending = read === 'reload' ? ui.reload() : read === 'setRole' ? ui.setRole('chat', 'alice') : ui.refreshRole('chat')
      ui.adopt({ settings: { ...DEFAULT_UI_SETTINGS, chatMaxWidth: 1040 }, avatars: { alice: 123 }, background: 456 })
      finish(new Response(JSON.stringify({ settings: DEFAULT_UI_SETTINGS, avatars: {}, session: {
        role: { id: 'alice', name: '爱丽丝' }, roster: [], turns: [],
      } })))
      await pending
      if (read === 'refreshRole') await vi.waitFor(() => expect(ui.session('chat')?.role?.id).toBe('alice'))
      expect(ui.settings.chatMaxWidth).toBe(1040)
      expect(ui.avatarVersion('alice')).toBe(123)
      expect(ui.background).toBe(456)
      if (read === 'setRole') expect(ui.session('chat')?.role?.id).toBe('alice')
      ui.dispose()
    })
  }
})
