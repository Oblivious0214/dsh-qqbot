/**
 * qqbot 预设内的提示词插件：只挂在 qqbot 预设里，所以标准会话不受影响。
 * 读取 host 层 qqbot 服务的内容和登记，组装成本预设的 section 和 context。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { QqbotContent } from './content.ts'
import { MEMORY_HINT } from './content.ts'
import type {} from './index.ts'
import { CONTEXT_NAME, CONTEXT_ORDER, PROMPT_ORDER, SECTION_NAME, SECTION_ORDER } from './order.ts'
import { resolveText, type QqbotRegistryStore, type QqbotSession } from './registry.ts'

export const name = 'qqbot-prompt'
export const inject = ['systemPrompt', 'qqbot']

/** `qqbot:prompt` 里的一段。name 沿用分段时的 section 名，供提示词查看器标出来源。 */
export interface PromptPart {
  readonly name: string
  readonly order: number
  readonly text: string
  /** 外部槽位的登记插件；dsh-qqbot 自己的段落为空。 */
  readonly source?: string
}

/** 各段之间的分隔，和 DSH 拼接 section 时一致（system-prompt 的 renderPrompt）。 */
export const PART_SEPARATOR = '\n\n'

/** 诊断性组装没有 agent，此时所有按会话求值的内容都为空。 */
function sessionOf(context: AssembleContext): QqbotSession | undefined {
  const id = context.agent?.id
  return id === undefined ? undefined : { id }
}

/**
 * 按 SECTION_ORDER 列出本会话的各段，去掉空段。同 order 按名称排序，和 DSH 的 section 排序规则一致。
 * session 为空时只剩不按会话求值的段落。
 */
export function assembleParts(content: QqbotContent, store: QqbotRegistryStore, session: QqbotSession | undefined): PromptPart[] {
  const perSession = (read: (session: QqbotSession) => string) => session === undefined ? '' : read(session)
  const jailbreak = session === undefined ? undefined : content.jailbreakFor(session)
  const parts: PromptPart[] = [
    { name: SECTION_NAME.JB_HEAD, order: SECTION_ORDER.JB_HEAD, text: jailbreak?.head ?? '' },
    { name: SECTION_NAME.PERSONA, order: SECTION_ORDER.PERSONA, text: perSession(s => content.personaFor(s)) },
    { name: SECTION_NAME.JB_MID, order: SECTION_ORDER.JB_MID, text: jailbreak?.mid ?? '' },
    ...store.snapshot().extensions.map(entry => ({
      name: `${SECTION_NAME.EXT_PREFIX}${entry.name}`,
      order: SECTION_ORDER.EXT,
      text: perSession(s => resolveText(entry.text, s)),
      ...entry.source === undefined ? {} : { source: entry.source },
    })),
    { name: SECTION_NAME.MEMORY_HINT, order: SECTION_ORDER.MEMORY_HINT, text: MEMORY_HINT },
    { name: SECTION_NAME.JB_TAIL, order: SECTION_ORDER.JB_TAIL, text: jailbreak?.tail ?? '' },
  ]
  return parts
    .filter(part => part.text !== '')
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** `qqbot:runtime` context 的文本：每条一行 `名称: 内容`，空条目去掉。 */
export function renderRuntime(store: QqbotRegistryStore, session: QqbotSession): string {
  return store.snapshot().runtime
    .map(item => ({ name: item.name, text: resolveText(item.text, session) }))
    .filter(item => item.text !== '')
    .map(item => `${item.name}: ${item.text}`)
    .join('\n')
}

export function apply(ctx: Context): void {
  const { content, store, lastPrompt } = ctx.qqbot

  // complete：本会话的系统提示词只有这一段。DSH 自带段落（身份行、present 说明、源码目录、
  // Web GUI）和其他插件的 section 都不会进入 qqbot 会话；工具 schema 不受影响。
  // 每次组装时现读登记，外部条目增删不需要重新注册。
  ctx.systemPrompt.section({
    name: SECTION_NAME.PROMPT,
    order: PROMPT_ORDER,
    complete: true,
    interpolate: false,
    text: (context) => {
      const text = assembleParts(content, store, sessionOf(context)).map(part => part.text).join(PART_SEPARATOR)
      // 只有 agent-loop 的真实组装带 agent（agent-loop/src/agent.ts），这份记录就是发给模型的系统提示词。
      if (context.agent !== undefined) lastPrompt.set(context.agent, text)
      return text
    },
  })

  // required：persona 设了 includeRuntimeContext: false，可选 context 都被去掉，qqbot 自己的运行时状态要保留。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME.RUNTIME,
    order: CONTEXT_ORDER.RUNTIME,
    required: true,
    interpolate: false,
    text: (context) => {
      const session = sessionOf(context)
      return session === undefined ? '' : renderRuntime(store, session)
    },
  })
}
