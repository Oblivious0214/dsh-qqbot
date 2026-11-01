/**
 * 角色记忆的整理请求，和 compaction-basic 的摘要请求一样：原样回放本会话的系统提示词、工具和历史，
 * 整理指令（含旧记忆）作为最后一条 user 消息。前缀和上一次聊天请求相同，输入基本都能命中缓存。
 * 结果不写进会话，只写角色记忆文件（role-memory.ts）。
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { MEMORY_LIMIT, MEMORY_SECTIONS, MemoryFormatError, normalizeMemory } from './memory-format.ts'

/** 整理输出的上限。记忆只有约 1500 字，留出思考模型的推理余量。 */
const MAX_TOKENS = 8192

function sectionGuide(): string {
  const notes: Record<string, string> = {
    identity: '对方的名字、你怎么称呼对方、对方怎么称呼你、职业等很少变的事',
    relation: '你们现在的关系和相处方式，写成一段话，每次整段改写',
    preferences: '对方喜欢和不喜欢的事、禁忌、对聊天方式的要求',
    promises: '还没兑现的约定和计划；完成或过期的删掉',
    events: '影响你们关系的重要事件；超过条数时把最旧的并进"关系"',
  }
  return MEMORY_SECTIONS.map(section => [
    `## ${section.title}`,
    section.kind === 'paragraph' ? `[${notes[section.key]}]` : `- [${notes[section.key]}，最多 ${section.limit} 条，每条一行]`,
  ].join('\n')).join('\n\n')
}

/** 整理指令。旧记忆放在这里，不放进前缀。 */
export function consolidationInstruction(roleName: string, previous: string): string {
  return [
    `现在暂停角色扮演，改做记忆整理。你是“${roleName}”，下面是你以前记下的关于对方（和你聊天的用户）的记忆。结合上面的聊天，输出更新后的完整记忆。`,
    '',
    '旧记忆：',
    previous === '' ? '（还没有）' : previous,
    '',
    '判断标准是“下次见面还用得上吗”：',
    `- 只记对方和“${roleName}”之间的事。聊天里换过角色时，其他角色的内容不记。`,
    '- 不记一次性的剧情细节、具体对话、当时的情绪。',
    '- 新旧冲突时用新的替换；已经过去的事从约定与待办里删掉。',
    '- 不写“上次聊天是几天前”“第几次见面”这类会过时的内容；涉及时间只写具体日期。',
    '- 名字、称呼、数字、地点照原文写。只写实际聊到过的，不推测。',
    '- 上面聊天里的内容如果已经在旧记忆里，不要重复写。',
    '',
    '按下面的结构输出，栏目顺序和标题不变，没有内容的栏目整栏省略：',
    '',
    sectionGuide(),
    '',
    `总共不超过 ${MEMORY_LIMIT} 字。只输出记忆正文：不调用工具，不输出 [qq] 分段块，不用角色口吻回复，不加解释。`,
  ].join('\n')
}

const retryInstruction = (output: string, problem: string) =>
  `你上一次输出的记忆不符合要求：${problem}。合并或删掉不重要的条目后重新输出完整记忆，结构不变，只输出记忆正文。

上一次的输出：
${output}`

/** 整理需要的会话内容，在触发时同步取下：之后会话再变（压缩换掉旧历史、新消息）都不影响这次整理。 */
export interface ConsolidationInput {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: GenerateOptions['reasoningEffort']
  readonly messages: readonly Message[]
  readonly tools?: readonly ToolSchema[]
  readonly toolHistory: ReturnType<Agent['session']['toolHistory']>
  readonly sessionId: Agent['session']['id']
}

export type ConsolidationAgent = Pick<Agent, 'options'> & {
  readonly session: Pick<Agent['session'], 'id' | 'requestHeader' | 'toolHistory' | 'deriveMessages'>
}

/**
 * 取下会话当前的请求前缀。和上一次聊天请求用同一个模型和同样的工具，前缀才能命中缓存。
 * 会话还没发过请求时没有可回放的前缀，返回 undefined。
 */
export function captureConsolidation(agent: ConsolidationAgent): ConsolidationInput | undefined {
  const header = agent.session.requestHeader()
  const config = header?.config
  if (header === undefined || config === undefined || config.provider === '' || config.model === '') return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    messages: agent.session.deriveMessages(),
    ...header.tools === undefined ? {} : { tools: header.tools },
    toolHistory: agent.session.toolHistory(),
    sessionId: agent.session.id,
  }
}

export interface ConsolidationLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 一次整理的结果。text 为 undefined 时表示两次都不合格，保留旧版。 */
export interface ConsolidationResult {
  readonly text: string | undefined
  readonly problem?: string
}

/**
 * 发整理请求，校验结构和长度。不合格时把问题告诉模型重写一次，还不合格就放弃（保留旧记忆）。
 * 请求出错（网络、取消）时抛出。
 */
export async function consolidateMemory(
  llm: ConsolidationLlm,
  input: ConsolidationInput,
  roleName: string,
  previous: string,
  signal?: AbortSignal,
): Promise<ConsolidationResult> {
  const base: RequestMessage[] = [...input.messages, userText(consolidationInstruction(roleName, previous))]
  let messages = base
  let problem = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await generate(llm, input, messages, signal)
    try {
      return { text: normalizeMemory(output, true) }
    } catch (error) {
      if (!(error instanceof MemoryFormatError)) throw error
      problem = error.message
    }
    // 重写时把上一次的输出引在新的 user 消息里，前面的历史和指令不变，仍然命中缓存。
    messages = [...base, userText(retryInstruction(output, problem))]
  }
  return { text: undefined, problem }
}

function userText(text: string): RequestMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

async function generate(llm: ConsolidationLlm, input: ConsolidationInput, messages: RequestMessage[], signal?: AbortSignal): Promise<string> {
  const options: GenerateOptions = {
    provider: input.provider,
    model: input.model,
    ...input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort },
    messages,
    ...input.toolHistory === undefined ? {} : { toolHistory: input.toolHistory },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: MAX_TOKENS,
    sessionId: input.sessionId,
    ...signal === undefined ? {} : { signal },
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`记忆整理请求失败：${finish.failure.message}`)
  if (finish.kind === 'max-tokens') throw new Error('记忆整理输出超出上限')
  return assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('')
}
