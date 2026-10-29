/**
 * dsh-qqbot host 层入口：提供 `ctx.qqbot` 登记服务。
 * 本插件不注册任何提示词，不写 agent-preset-registry 的设置；
 * 提示词由 qqbot 预设内的 dsh-qqbot/prompt 组装。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createDefaultContent, type QqbotContent } from './content.ts'
import { QqbotRegistryStore, type QqbotRegistry } from './registry.ts'

export type { QqbotExtensionEntry, QqbotRegistry, QqbotSession, QqbotText } from './registry.ts'

/** `ctx.qqbot`：外部插件只用 QqbotRegistry 部分；其余字段供本插件的预设内组件读取。 */
export interface QqbotService extends QqbotRegistry {
  readonly store: QqbotRegistryStore
  readonly content: QqbotContent
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qqbot: QqbotService
  }
}

export const name = 'qqbot'

export function apply(ctx: Context): void {
  const store = new QqbotRegistryStore()
  const service: QqbotService = {
    store,
    content: createDefaultContent(),
    extension: entry => store.extension(entry),
    runtime: (key, text) => store.runtime(key, text),
  }
  ctx.provide('qqbot', service)
}
