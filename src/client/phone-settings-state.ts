import type { PhoneAction, PhoneView } from '../phone-types.ts'
import { checkPhoneMode } from './phone-mode.ts'

export interface PhoneDraft { mode: 'local' | 'tailscale'; address: string; port: string; accessCode: string }
const fields = (view: PhoneView): PhoneDraft => ({ mode: view.mode ?? 'local', address: view.address, port: String(view.port), accessCode: view.accessCode })
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Only save patches enter this queue. Starting the gateway is a separate explicit operation. */
export class PhoneSettingsState {
  view: PhoneView | undefined
  draft: PhoneDraft = { mode: 'local', address: '', port: '3088', accessCode: '' }
  error = ''
  status = ''
  busy = false
  operating = false
  private pending: Partial<PhoneDraft> = {}
  private task: Promise<boolean> | undefined
  private runLock = false
  private version = 0
  private readonly listeners = new Set<() => void>()
  constructor(private readonly request: (action?: PhoneAction) => Promise<PhoneView>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version
  private changed() { this.version++; for (const listener of this.listeners) listener() }
  get dirty(): boolean {
    return this.view !== undefined && (Object.keys(this.draft) as (keyof PhoneDraft)[]).some(key => this.draft[key] !== fields(this.view!)[key])
  }
  async load(): Promise<void> {
    const version = this.version
    try { const view = await this.request(); if (this.version !== version) return; this.view = view; this.draft = fields(view); this.error = '' }
    catch (error) { if (this.version !== version) return; this.error = message(error) }
    this.changed()
  }
  edit(patch: Partial<PhoneDraft>): void { this.draft = { ...this.draft, ...patch }; this.status = ''; this.changed() }
  private validate(draft: PhoneDraft): void {
    if (!draft.port.trim() || !Number.isInteger(Number(draft.port)) || Number(draft.port) < 1024 || Number(draft.port) > 65535) throw new Error('端口需在 1024–65535 之间。')
    if (!/^[\x21-\x7e]{8,128}$/.test(draft.accessCode)) throw new Error('访问码需为 8–128 位字母、数字或符号，不含空格。')
  }
  commit(patch: Partial<PhoneDraft> = this.draft): Promise<boolean> {
    if (!this.view || this.view.running || this.operating) return Promise.resolve(false)
    try { this.validate({ ...fields(this.view), ...this.pending, ...patch }) }
    catch (error) { this.error = message(error); this.changed(); return Promise.resolve(false) }
    this.pending = { ...this.pending, ...patch }
    this.error = ''; this.status = '保存中…'; this.busy = true; this.changed()
    if (!this.task) this.task = this.drain().finally(() => { this.task = undefined; this.busy = false; this.changed() })
    return this.task
  }
  private async drain(): Promise<boolean> {
    while (Object.keys(this.pending).length) {
      const patch = this.pending; this.pending = {}
      const current = this.view!
      const desired = { ...fields(current), ...patch }
      try {
        if (desired.mode === 'tailscale' && current.mode === undefined) checkPhoneMode(current, desired.mode)
        const next = await this.request({ action: 'save', revision: current.revision, ...desired, port: Number(desired.port) })
        // Advance revision even when an old backend returns an incompatible mode.
        this.view = next
        checkPhoneMode(next, desired.mode)
        for (const key of Object.keys(desired) as (keyof PhoneDraft)[]) {
          if (this.draft[key] === desired[key] && this.pending[key] === undefined) Object.assign(this.draft, { [key]: fields(next)[key] })
        }
        this.changed()
      } catch (error) {
        const state = (error as { state?: PhoneView }).state
        if (state) this.view = state
        this.pending = { ...patch, ...this.pending }; this.error = message(error); this.status = ''; this.changed(); return false
      }
    }
    this.status = ''; return true
  }
  async run(action: 'start' | 'stop'): Promise<void> {
    if (!this.view || this.runLock) return
    this.runLock = true
    try { await this.operate(action) } finally { this.runLock = false }
  }
  private async operate(action: 'start' | 'stop'): Promise<void> {
    if (this.task && !await this.task && action === 'start') return
    if (action === 'start' && this.dirty && !await this.commit()) return
    if (action === 'start') {
      try { checkPhoneMode(this.view!, this.draft.mode) }
      catch (error) { this.error = message(error); this.changed(); return }
    }
    this.operating = true; this.error = ''; this.status = ''; this.changed()
    try {
      const next = await this.request({ action, revision: this.view!.revision })
      this.view = next
      if (action === 'start') checkPhoneMode(next, this.draft.mode)
      this.draft = fields(next); this.pending = {}
    } catch (error) {
      const state = (error as { state?: PhoneView }).state
      if (state) this.view = state
      this.error = message(error)
    } finally { this.operating = false; this.changed() }
  }
}
