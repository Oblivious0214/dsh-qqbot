import { join } from 'node:path'
import { isRecord, readJson, writeJson, type Warn } from '../storage.ts'
import { AUTO_REPLY_TEXT } from './prompts.ts'
import { AUTO_REPLY_PROMPT_LIMIT, type AutoReplyPromptView } from './types.ts'

/** Custom notices belong to one conversation; activation is never persisted. */
export class AutoReplyPromptSettings {
  private readonly values = new Map<string, string>()
  private readonly file: string
  constructor(dir: string, warn: Warn) {
    this.file = join(dir, 'auto-reply-prompts.json')
    const stored = readJson(this.file, warn)
    if (isRecord(stored) && stored['version'] === 1 && isRecord(stored['sessions'])) {
      for (const [id, text] of Object.entries(stored['sessions'])) {
        if (id.length <= 200 && typeof text === 'string' && text.trim() && text.length <= AUTO_REPLY_PROMPT_LIMIT) this.values.set(id, text)
      }
    }
  }
  clear(): void { this.values.clear() }
  get(session: string): AutoReplyPromptView {
    return { prompt: this.values.get(session) ?? AUTO_REPLY_TEXT, defaultPrompt: AUTO_REPLY_TEXT }
  }
  set(session: string, value: unknown): AutoReplyPromptView {
    if (typeof value !== 'string' || !value.trim() || value.length > AUTO_REPLY_PROMPT_LIMIT) {
      throw new Error(`自动接话提示词应为 1–${AUTO_REPLY_PROMPT_LIMIT} 个字符。`)
    }
    const next = new Map(this.values)
    if (value === AUTO_REPLY_TEXT) next.delete(session)
    else next.set(session, value)
    writeJson(this.file, { version: 1, sessions: Object.fromEntries(next) })
    this.values.clear()
    for (const [id, text] of next) this.values.set(id, text)
    return this.get(session)
  }
}
