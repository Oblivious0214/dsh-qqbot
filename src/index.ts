/**
 * dsh-qqbot host 层入口：提供 `ctx.qqbot` 登记服务和提示词查看器接口。
 * 本插件不注册任何提示词，不写 agent-preset-registry 的设置；
 * 提示词由 qqbot 预设内的 dsh-qqbot/prompt 组装。
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createDefaultContent, type QqbotContent } from './content.ts'
import { QqbotRegistryStore, type QqbotExtensionEntry, type QqbotRegistry, type QqbotText } from './registry.ts'
import * as viewer from './viewer.ts'

export type { QqbotExtensionEntry, QqbotRegistry, QqbotSession, QqbotText } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    qqbot: QqbotService
  }
}

/**
 * `ctx.qqbot`：外部插件只用 QqbotRegistry 部分；其余成员供本插件的预设内组件和查看器读取。
 * 是 cordis Service，所以方法里的 `this.ctx` 是调用方的 Context，登记时能记下来源插件。
 */
export class QqbotService extends Service implements QqbotRegistry {
  readonly store = new QqbotRegistryStore()
  readonly content: QqbotContent = createDefaultContent()
  /**
   * 每个 agent 上一次真实组装出的系统提示词，供查看器对比"上一轮发出的"和"下一轮要发的"。
   * 以 agent 对象为键，agent 释放后自动回收；重启后为空。
   */
  readonly lastPrompt = new WeakMap<object, string>()

  constructor(ctx: Context) {
    super(ctx, 'qqbot')
  }

  extension(entry: QqbotExtensionEntry): () => void {
    return this.store.extension(entry, callerName(this.ctx))
  }

  runtime(name: string, text: QqbotText): () => void {
    return this.store.runtime(name, text, callerName(this.ctx))
  }
}

/** 调用方的插件名：优先用 loader 条目里的包名，取不到时用 cordis 插件名。 */
function callerName(ctx: Context): string | undefined {
  const fallback = ctx.fiber.name
  let fiber = ctx.fiber
  while (true) {
    const entryName = (fiber as { entry?: { options?: { name?: unknown } } }).entry?.options?.name
    if (typeof entryName === 'string' && entryName !== '') return entryName
    const parent = fiber.parent.fiber
    if (parent === fiber) break
    fiber = parent
  }
  return fallback === 'root' ? undefined : fallback
}

export const name = 'qqbot'

export function apply(ctx: Context): void {
  ctx.plugin(QqbotService)
  ctx.plugin(viewer)
}
