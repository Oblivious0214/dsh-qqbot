/**
 * 提示词查看器的 host 接口：GET `/api/qqbot/prompt-view?session=<id>`，只读。
 * 全部是纯读取：不调用 systemPrompt.assemble()（working-directory 的监听会做文件 I/O、可能写会话），
 * 不读会话历史。依据见 work/prompt-viewer-source-20261029/README.md。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { QqbotContent } from './content.ts'
import type {} from './index.ts'
import { CONTEXT_NAME, SECTION_NAME } from './order.ts'
import type {} from '@deepseek-ai/dsh-tools'
import { MEME_TOOL } from './format.ts'
import { presetForAgent } from './agent-preset.ts'
import { assembleParts, PART_SEPARATOR, type PromptFeatures } from './prompt.ts'
import { resolveText, type QqbotRegistryStore, type QqbotSession } from './registry.ts'
import {
  PRESET_ID, PROMPT_VIEW_PATH,
  type PromptView, type PromptViewContextItem, type PromptViewError, type PromptViewLastSent, type PromptViewTool,
} from './view-types.ts'

export const name = 'qqbot-viewer'

/** 和 DSH working-directory 的 context 文本一致（working-directory/src/index.ts contextText）。 */
const WORKING_DIRECTORY_CONTEXT = 'working-directory:current'

export interface PromptViewInput {
  readonly session: QqbotSession
  readonly content: QqbotContent
  readonly store: QqbotRegistryStore
  /** 上一轮真实组装出的系统提示词；本次启动后还没有请求时为空。 */
  readonly lastPrompt: string | undefined
  /** 当前工作目录；读不到时为空，不显示这条 context。 */
  readonly workingDirectory: string | undefined
  readonly tools: readonly PromptViewTool[]
  /** 下一轮组装时的工具情况，决定表情规则是否出现。 */
  readonly features: PromptFeatures
}

/** 组装查看器数据。纯函数，便于测试。 */
export function buildPromptView(input: PromptViewInput): PromptView {
  const { session, content, store } = input
  let cursor = 0
  const parts = assembleParts(content, store, session, input.features).map((part, index) => {
    if (index > 0) cursor += PART_SEPARATOR.length
    const start = cursor
    cursor += part.text.length
    return {
      name: part.name,
      order: part.order,
      owner: part.name.startsWith(SECTION_NAME.EXT_PREFIX) ? 'extension' as const : 'qqbot' as const,
      ...part.source === undefined ? {} : { source: part.source },
      start,
      text: part.text,
    }
  })
  const system = parts.map(part => part.text).join(PART_SEPARATOR)
  const contexts: PromptViewContextItem[] = []
  if (input.workingDirectory !== undefined) {
    contexts.push({
      name: WORKING_DIRECTORY_CONTEXT,
      text: `Current working directory: ${JSON.stringify(input.workingDirectory)}.`,
      source: 'DSH',
    })
  }
  // qqbot:runtime 在模型那里是一条 context，每行一个登记；这里按登记拆开，便于标出来源。
  for (const item of store.snapshot().runtime) {
    const text = resolveText(item.text, session)
    if (text === '') continue
    contexts.push({
      name: `${CONTEXT_NAME.RUNTIME} · ${item.name}`,
      text: `${item.name}: ${text}`,
      ...item.source === undefined ? {} : { source: item.source },
    })
  }
  const roleId = content.roleIdFor(session)
  return {
    sessionId: session.id,
    ...roleId === undefined ? {} : { roleId },
    presetId: content.jailbreakFor(session).id,
    system: { length: system.length, parts },
    lastSent: compareLastSent(input.lastPrompt, system),
    contexts,
    tools: input.tools,
  }
}

function compareLastSent(previous: string | undefined, current: string): PromptViewLastSent {
  if (previous === undefined) return { state: 'none' }
  if (previous === current) return { state: 'same' }
  let firstDiff = 0
  const limit = Math.min(previous.length, current.length)
  while (firstDiff < limit && previous.charCodeAt(firstDiff) === current.charCodeAt(firstDiff)) firstDiff++
  return { state: 'changed', firstDiff, previousLength: previous.length }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(status: number, error: PromptViewError, message: string): Response {
  return json(status, { error, message })
}

export const inject = ['qqbot', 'connection', 'agents', 'agentPresets']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: PROMPT_VIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const id = new URL(request.url).searchParams.get('session')
      if (id === null || id === '' || id.length > 512) return Promise.resolve(fail(400, 'bad-request', '缺少会话 id'))
      const agent = ctx.agents.get(id as Parameters<typeof ctx.agents.get>[0])
      if (agent === undefined) {
        return Promise.resolve(fail(409, 'not-loaded', '这个会话还没有加载，发一条消息或重新打开会话后再试'))
      }
      if (presetForAgent(ctx.agentPresets, agent) !== PRESET_ID) {
        return Promise.resolve(fail(404, 'not-qqbot', '查看器只用于 QQ Bot 会话'))
      }
      const tools = (agent.session.requestHeader()?.tools ?? []).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
      }))
      // working-directory 是可选读取；get() 只读投影状态，不做文件 I/O。
      const workingDirectory = ctx.get('workingDirectory')?.get(agent.session)
      const { content, store, lastPrompt } = ctx.qqbot
      return Promise.resolve(json(200, buildPromptView({
        session: { id: agent.id },
        content,
        store,
        lastPrompt: lastPrompt.get(agent),
        workingDirectory,
        tools,
        // 查看器显示的是下一轮要发的内容，所以按当前登记的工具判断，不看上一轮请求。
        // send_meme 没有 when 条件，登记了就会进下一轮的工具集。
        features: { meme: ctx.get('tools')?.get(MEME_TOOL, agent) !== undefined },
      })))
    },
  }), 'qqbot: prompt viewer route')
}
