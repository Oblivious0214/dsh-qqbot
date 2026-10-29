/**
 * qqbot 预设内的提示词插件：只挂在 qqbot 预设里，所以标准会话不受影响。
 * 读取 host 层 qqbot 服务的内容和登记，组装成本预设的 section 和 context。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { MEMORY_HINT } from './content.ts'
import type {} from './index.ts'
import { CONTEXT_NAME, CONTEXT_ORDER, SECTION_NAME, SECTION_ORDER } from './order.ts'
import { resolveText, type QqbotSession } from './registry.ts'

export const name = 'qqbot-prompt'
export const inject = ['systemPrompt', 'qqbot']

/** 诊断性组装没有 agent，此时所有按会话求值的内容都为空。 */
function sessionOf(context: AssembleContext): QqbotSession | undefined {
  const id = context.agent?.id
  return id === undefined ? undefined : { id }
}

export function apply(ctx: Context): void {
  const { content, store } = ctx.qqbot
  const perSession = (read: (session: QqbotSession) => string) => (context: AssembleContext) => {
    const session = sessionOf(context)
    return session === undefined ? '' : read(session)
  }
  const section = (name: string, order: number, text: string | ((context: AssembleContext) => string)) =>
    ctx.systemPrompt.section({ name, order, text, interpolate: false })

  section(SECTION_NAME.JB_HEAD, SECTION_ORDER.JB_HEAD, perSession(s => content.jailbreakFor(s).head))
  section(SECTION_NAME.PERSONA, SECTION_ORDER.PERSONA, perSession(s => content.personaFor(s)))
  section(SECTION_NAME.JB_MID, SECTION_ORDER.JB_MID, perSession(s => content.jailbreakFor(s).mid))
  section(SECTION_NAME.MEMORY_HINT, SECTION_ORDER.MEMORY_HINT, MEMORY_HINT)
  section(SECTION_NAME.JB_TAIL, SECTION_ORDER.JB_TAIL, perSession(s => content.jailbreakFor(s).tail))

  // 每个外部条目单独成段，查看器能按 section 名看出来源。条目增删时同步。
  const mounted = new Map<string, { readonly entry: object; readonly dispose: () => void }>()
  const sync = () => {
    const current = new Map(store.snapshot().extensions.map(entry => [entry.name, entry]))
    for (const [key, item] of mounted) {
      if (current.get(key) === item.entry) continue
      item.dispose()
      mounted.delete(key)
    }
    for (const [key, entry] of current) {
      if (mounted.has(key)) continue
      const dispose = section(`${SECTION_NAME.EXT_PREFIX}${key}`, SECTION_ORDER.EXT, perSession(s => resolveText(entry.text, s)))
      mounted.set(key, { entry, dispose })
    }
  }
  ctx.effect(() => {
    sync()
    const stop = store.subscribe(sync)
    return () => {
      stop()
      for (const item of mounted.values()) item.dispose()
      mounted.clear()
    }
  }, 'qqbot-prompt: extensions')

  // required：即使 persona 设了 includeRuntimeContext: false，qqbot 自己的运行时状态也保留。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME.RUNTIME,
    order: CONTEXT_ORDER.RUNTIME,
    required: true,
    interpolate: false,
    text: perSession(s => store.snapshot().runtime
      .map(item => ({ name: item.name, text: resolveText(item.text, s) }))
      .filter(item => item.text !== '')
      .map(item => `${item.name}: ${item.text}`)
      .join('\n')),
  })
}
