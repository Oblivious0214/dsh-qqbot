import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneSettingsState } from '../src/client/phone-settings-state.ts'
import { VoiceState } from '../src/client/voice-state.ts'
import { DEFAULT_VOICE_SETTINGS, type VoiceView } from '../src/voice-types.ts'
import type { PhoneAction, PhoneView } from '../src/phone-types.ts'

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const initialPhone = (): PhoneView => ({ mode: 'local', enabled: false, running: false, address: '192.168.1.20', port: 3088, accessCode: 'test-code', revision: '0', url: '', error: '', networks: [{ name: 'Wi-Fi', address: '192.168.1.20' }] })
function phone() {
  let view = initialPhone(), fail = false, hold: Promise<void> | undefined
  const actions: PhoneAction[] = []
  const state = new PhoneSettingsState(async action => {
    if (!action) return { ...view }
    actions.push(action); await hold
    if (fail) throw Object.assign(new Error('保存失败'), { state: { ...view, revision: 'retry' } })
    if (action.action === 'save') view = { ...view, ...action, mode: action.mode ?? 'local', address: action.mode === 'tailscale' ? '' : action.address, revision: String(actions.length) }
    else view = { ...view, running: action.action === 'start', revision: String(actions.length) }
    return { ...view }
  })
  return { state, actions, setFail: (value: boolean) => { fail = value }, hold: (promise: Promise<void>) => { hold = promise } }
}
afterEach(() => vi.unstubAllGlobals())
describe('phone parameter autosave', () => {
  it('serializes patches using each returned revision, never starts implicitly', async () => {
    const p = phone(); await p.state.load(); const gate = deferred<void>(); p.hold(gate.promise)
    p.state.edit({ mode: 'tailscale' }); const pending = p.state.commit({ mode: 'tailscale' })
    p.state.edit({ port: '3090' }); void p.state.commit({ port: '3090' })
    expect(p.actions).toHaveLength(1); gate.resolve(); await pending
    expect(p.actions.map(a => a.action)).toEqual(['save', 'save'])
    expect(p.actions[1]!.revision).toBe('1'); expect(p.state.view?.port).toBe(3090); expect(p.state.dirty).toBe(false)
  })
  it('keeps invalid input without transmitting it and preserves it across another save', async () => {
    const p = phone(); await p.state.load(); p.state.edit({ port: '' })
    expect(await p.state.commit({ port: '' })).toBe(false); expect(p.actions).toHaveLength(0)
    p.state.edit({ mode: 'tailscale' }); await p.state.commit({ mode: 'tailscale' })
    expect(p.state.draft.port).toBe(''); expect(p.state.dirty).toBe(true)
    await p.state.run('start'); expect(p.actions.every(a => a.action === 'save')).toBe(true)
  })
  it('retains failed draft, updates revision, retries once and starts only explicitly', async () => {
    const p = phone(); await p.state.load(); p.setFail(true); p.state.edit({ accessCode: 'new-code' })
    await p.state.commit({ accessCode: 'new-code' }); expect(p.state.draft.accessCode).toBe('new-code'); expect(p.state.status).toBe('')
    p.setFail(false); await p.state.commit(); expect(p.actions[1]!.revision).toBe('retry'); expect(p.state.dirty).toBe(false)
    await p.state.run('start'); expect(p.actions.at(-1)?.action).toBe('start')
  })
  it('deduplicates start clicks while waiting for a save', async () => {
    const p = phone(); await p.state.load(); const gate = deferred<void>(); p.hold(gate.promise)
    p.state.edit({ port: '3091' }); const save = p.state.commit(); const start = p.state.run('start'); const second = p.state.run('start')
    gate.resolve(); await Promise.all([save, start, second]); expect(p.actions.filter(a => a.action === 'start')).toHaveLength(1)
  })
  it('blocks old backends without resetting the selected remote mode', async () => {
    const state = new PhoneSettingsState(async () => { const { mode: _, ...rest } = initialPhone(); return rest as PhoneView })
    await state.load(); state.edit({ mode: 'tailscale' }); await state.commit(); expect(state.error).toContain('重启 DSH'); expect(state.draft.mode).toBe('tailscale')
  })
  it('rejects parameter saves while running', async () => {
    const p = phone(); await p.state.load(); await p.state.run('start'); p.state.edit({ port: '3091' }); expect(await p.state.commit()).toBe(false)
    expect(p.actions.map(a => a.action)).toEqual(['start'])
  })
})
describe('voice autosave', () => {
  const initial = (): VoiceView => ({ settings: { ...DEFAULT_VOICE_SETTINGS }, voices: [], engines: [], keyStore: true })
  it('serializes rapid preferences and retains the latest combined values', async () => {
    const state = new VoiceState(); let view = initial(); state.adopt(view)
    const gate = deferred<void>(), calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); await gate.promise; view = { ...view, settings: body.settings }; return Response.json(view) }))
    const pending = state.saveSettings({ enabled: true }); await tick(); void state.saveSettings({ mode: 'all' }); void state.saveSettings({ volume: 0.3 })
    expect(calls).toHaveLength(1); gate.resolve(); await pending
    expect(state.settings).toMatchObject({ enabled: true, mode: 'all', volume: 0.3 }); expect(state.settingsDirty).toBe(false)
    expect(calls).toHaveLength(2)
  })
  it('keeps intermediate slider values uncommitted while another save completes', async () => {
    const state = new VoiceState(), view = initial(); state.adopt(view); const gate = deferred<void>(); const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); await gate.promise; return Response.json({ ...view, settings: body.settings }) }))
    const saving = state.saveSettings({ enabled: true }); await tick(); state.editSettings({ volume: 0.15 }); gate.resolve(); await saving
    expect(calls).toHaveLength(1); expect(state.settings.volume).toBe(view.settings.volume); expect(state.draftSettings.volume).toBe(0.15); expect(state.settingsStatus).toBe('')
    await state.saveSettings(); expect(state.settings.volume).toBe(0.15)
  })
  it('retains failed preferences and allows retry', async () => {
    const state = new VoiceState(), view = initial(); state.adopt(view); let fail = true
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => fail ? Response.json({ message: '磁盘写入失败' }, { status: 500 }) : Response.json({ ...view, settings: JSON.parse(init.body).settings })))
    await state.saveSettings({ volume: 0.2 }); expect(state.settingsError).toBe('磁盘写入失败'); expect(state.draftSettings.volume).toBe(0.2); expect(state.settingsStatus).toBe('')
    fail = false; await state.saveSettings(); expect(state.settings.volume).toBe(0.2); expect(state.settingsDirty).toBe(false)
  })
  it('ignores stale reads arriving after a write', async () => {
    const state = new VoiceState(), old = initial(); state.adopt(old); const gate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init.method ? Response.json({ ...old, settings: JSON.parse(init.body).settings }) : gate.promise))
    const reload = state.reload(); await state.saveSettings({ volume: 0.4 }); gate.resolve(Response.json(old)); await reload
    expect(state.settings.volume).toBe(0.4)
  })
  it('does not restore old settings after data invalidation', async () => {
    const state = new VoiceState(), view = initial(); state.adopt(view); const gate = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => gate.promise)); const saving = state.saveSettings({ volume: 0.4 }); await tick(); state.invalidate(); gate.resolve(Response.json({ ...view, settings: { ...view.settings, volume: 0.4 } })); await saving
    expect(state.ready).toBe(false); expect(state.settingsDirty).toBe(false); expect(state.settingsError).toBe('')
  })
})
