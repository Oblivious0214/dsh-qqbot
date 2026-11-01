import { join } from 'node:path'
import { isRecord, readJson, writeJson, type Warn } from '../storage.ts'
import { QUICK_REPLY_PROMPT } from './prompts.ts'
import { DEFAULT_QUICK_REPLY_CLICK_MODE, QUICK_REPLY_PROMPT_LIMIT, type AutoReplyPromptView, type QuickReplyClickMode } from './types.ts'

/** Per-session preference; unlike automatic wakeup, this is safe to remember across restarts. */
export class QuickReplySettings {
  private readonly enabled = new Map<string, boolean>()
  private readonly prompts = new Map<string, string>()
  private readonly clickModes = new Map<string, QuickReplyClickMode>()
  private readonly file: string
  constructor(dir: string, warn: Warn) {
    this.file = join(dir, 'quick-replies.json')
    const stored = readJson(this.file, warn)
    if (isRecord(stored) && stored['version'] === 1 && Array.isArray(stored['sessions'])) {
      for (const id of stored['sessions']) if (typeof id === 'string' && id && id.length <= 200) this.enabled.set(id, true)
    } else if (isRecord(stored) && stored['version'] === 2) {
      if (isRecord(stored['clickModes'])) for (const [id, mode] of Object.entries(stored['clickModes'])) {
        if (id && id.length <= 200 && (mode === 'send' || mode === 'draft')) this.clickModes.set(id, mode)
      }
      if (isRecord(stored['sessions'])) for (const [id, enabled] of Object.entries(stored['sessions'])) {
        if (id && id.length <= 200 && typeof enabled === 'boolean') this.enabled.set(id, enabled)
      }
      if (isRecord(stored['prompts'])) for (const [id, prompt] of Object.entries(stored['prompts'])) {
        if (id && id.length <= 200 && typeof prompt === 'string' && prompt.trim() && prompt.length <= QUICK_REPLY_PROMPT_LIMIT) this.prompts.set(id, prompt)
      }
    }
  }
  clear(): void { this.enabled.clear(); this.prompts.clear(); this.clickModes.clear() }
  get(session: string): boolean { return this.enabled.get(session) ?? true }
  clickMode(session: string): QuickReplyClickMode { return this.clickModes.get(session) ?? DEFAULT_QUICK_REPLY_CLICK_MODE }
  setClickMode(session: string, value: unknown): void {
    if (value !== 'send' && value !== 'draft') throw new Error('快捷回复点击方式无效。')
    if (value === this.clickMode(session)) return
    const next = new Map(this.clickModes).set(session, value)
    this.save(this.enabled, this.prompts, next)
    this.clickModes.set(session, value)
  }
  private save(enabled: ReadonlyMap<string, boolean>, prompts: ReadonlyMap<string, string>, clickModes: ReadonlyMap<string, QuickReplyClickMode> = this.clickModes): void {
    writeJson(this.file, { version: 2, sessions: Object.fromEntries(enabled), prompts: Object.fromEntries(prompts), clickModes: Object.fromEntries(clickModes) })
  }
  set(session: string, enabled: boolean): void {
    if (enabled === this.get(session)) return
    const next = new Map(this.enabled).set(session, enabled)
    this.save(next, this.prompts)
    this.enabled.set(session, enabled)
  }
  promptView(session: string): AutoReplyPromptView {
    return { prompt: this.prompts.get(session) ?? QUICK_REPLY_PROMPT, defaultPrompt: QUICK_REPLY_PROMPT }
  }
  setPrompt(session: string, value: unknown): AutoReplyPromptView {
    if (typeof value !== 'string' || !value.trim() || value.length > QUICK_REPLY_PROMPT_LIMIT) {
      throw new Error(`回复建议提示词应为 1–${QUICK_REPLY_PROMPT_LIMIT} 个字符。`)
    }
    const next = new Map(this.prompts)
    if (value === QUICK_REPLY_PROMPT) next.delete(session)
    else next.set(session, value)
    this.save(this.enabled, next)
    this.prompts.clear()
    for (const [id, text] of next) this.prompts.set(id, text)
    return this.promptView(session)
  }
  prompt(session: string): string { return this.get(session) ? this.promptView(session).prompt : '' }
}
