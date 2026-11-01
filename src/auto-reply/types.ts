/** Shared wire contract; runtime activation is deliberately never persisted. */
export const AUTO_REPLY_PATH = '/api/qqbot/auto-reply'
export const AUTO_REPLY_SOURCE = 'qqbot-auto-reply'
export const DEFAULT_OPTIONS = { waitSeconds: 120, maxReplies: 6 } as const
export const AUTO_REPLY_PROMPT_LIMIT = 6000
export const QUICK_REPLY_PROMPT_LIMIT = 6000
export interface AutoReplyOptions { waitSeconds: number; maxReplies: number }
export interface AutoReplyView {
  enabled: boolean
  count: number
  remainingSeconds: number | null
  status: 'off' | 'waiting' | 'busy' | 'input' | 'limit' | 'stopped'
  message: string
}
export function parseOptions(value: unknown): AutoReplyOptions {
  const row = value as Partial<AutoReplyOptions> | null
  if (!row || !Number.isInteger(row.waitSeconds) || row.waitSeconds! < 10 || row.waitSeconds! > 3600
    || !Number.isInteger(row.maxReplies) || row.maxReplies! < 1 || row.maxReplies! > 20) {
    throw new Error('等待时间应为 10–3600 秒，连续次数应为 1–20 次。')
  }
  return { waitSeconds: row.waitSeconds!, maxReplies: row.maxReplies! }
}

/** Appended as an attributed notice, never inserted into a system prefix. */
export { AUTO_REPLY_TEXT } from './prompts.ts'

export type QuickReplyClickMode = 'send' | 'draft'
export const DEFAULT_QUICK_REPLY_CLICK_MODE: QuickReplyClickMode = 'send'
export interface QuickReplyView { enabled: boolean; clickMode?: QuickReplyClickMode }
export interface AutoReplyPromptView { prompt: string; defaultPrompt: string }
