/**
 * 右栏“高潮”流程投递给 AI 的消息（用户 2026-11-01 要求）。
 * 设备由程序按高潮设置运行，消息只让 AI 用角色口吻配合流程出字：
 * 按下时投“高潮”，只写高潮过程；刺激结束转入温存时再投“温存”，单独写事后温存。
 * 段数按阶段秒数估算，时间越长写得越多。两条文本用户可在高潮设置里改写，{秒数}、{段数} 发送时填入。
 * 作为带来源标记的历史消息追加，不改 section，不影响前缀缓存。
 */

import type { BurstSettings } from './api-types.ts'

export const CLIMAX_SOURCE = 'qqbot-toy-climax'
export const CLIMAX_SUMMARY = '高潮'
export const AFTERCARE_SUMMARY = '温存'

export const CLIMAX_PROMPT_KEYS = ['climax', 'aftercare'] as const
export type ClimaxPromptKey = typeof CLIMAX_PROMPT_KEYS[number]
/** 用户改写过的通知；没改的不出现，用内置默认。 */
export type ClimaxPrompts = Partial<Record<ClimaxPromptKey, string>>
export const MAX_CLIMAX_PROMPT_LENGTH = 2000
export const CLIMAX_PLACEHOLDERS = ['{秒数}', '{段数}'] as const

export const DEFAULT_CLIMAX_PROMPTS: Readonly<Record<ClimaxPromptKey, string>> = Object.freeze({
  climax: '用户已经开始高潮：设备正在高强度刺激，持续 {秒数} 秒。用角色口吻陪用户冲到高潮，写约 {段数} 段，一路把节奏推到最高，在最后一段陪用户射出来。这条只写高潮过程。设备由程序控制，这条回复只写文字，不写 motion。',
  aftercare: '高潮刺激已经结束，设备转入 {秒数} 秒的舒缓温存。用角色口吻写事后的温存，写约 {段数} 段，陪用户慢慢平复下来。设备由程序控制，这条回复只写文字，不写 motion。',
})

/** 这一阶段大约写几段：高潮期间段落按普通打字节奏显示，每段约 2–4 秒。 */
export function stageCount(seconds: number, perStage: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(seconds / perStage)))
}

const fill = (template: string, seconds: number, count: number) =>
  template.replaceAll('{秒数}', String(seconds)).replaceAll('{段数}', String(count))

/** 按下高潮时的消息正文。 */
export function climaxText(settings: BurstSettings, prompts?: ClimaxPrompts): string {
  return fill(prompts?.climax ?? DEFAULT_CLIMAX_PROMPTS.climax, settings.seconds, stageCount(settings.seconds, 3, 4, 30))
}

/** 刺激结束、转入温存时的消息正文。 */
export function aftercareText(settings: BurstSettings, prompts?: ClimaxPrompts): string {
  return fill(prompts?.aftercare ?? DEFAULT_CLIMAX_PROMPTS.aftercare, settings.aftercareSeconds, stageCount(settings.aftercareSeconds, 4, 3, 30))
}
