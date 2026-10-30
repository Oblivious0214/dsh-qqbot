/**
 * qqbot 预设隔离组里的压缩后端：DSH 原生 compaction-basic，只换摘要模板。
 *
 * compaction-basic 的配置没有模板选项，摘要指令写死为英文编程栏目。它注明 `summarize()`
 * 是唯一的子类钩子，这里只覆盖它；阈值、保留、事务和计量全部沿用原生实现。
 * 本插件只出现在 qqbot 预设的 `cordis:group` 里，标准会话仍用 DSH 自己的 compaction-basic。
 *
 * `summarizeChat()` 改写自 compaction-basic 的 `summarizeWithLlm()`（src/summarizer.ts，MIT），
 * 那个函数没有导出。和原版只差指令文本；DSH 升级时对照原版检查。
 */

import type {} from './index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, Message, RequestMessage, StreamChunk, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'

/** compaction-basic 用 `<compacted-summary>` 框住摘要；合并旧摘要时模型要认出它。 */
const SUMMARY_TAG = '<compacted-summary>'

/**
 * 摘要指令，作为最后一条 user 消息接在回放的对话后面，前缀缓存和原版一样复用。
 * 栏目没有内容时整栏省略：对话短时摘要比原文长会被 compaction-basic 拒绝。
 */
export const CHAT_COMPACTION_INSTRUCTION = [
  '现在暂停角色扮演，改做摘要整理。把上面的聊天整理成一份存档，让之后的对话能无缝接着聊下去。',
  '',
  '按下面的结构输出，栏目顺序不变。没有内容的栏目整栏省略。每条一行，用短句，不写成段落。',
  '',
  '## 人物与称呼',
  '- [出场的角色和用户；彼此怎么称呼，昵称、外号原样保留]',
  '',
  '## 关系进展',
  '- [关系现在到了哪一步，经历过的转折]',
  '',
  '## 经过',
  '- [按时间顺序的要点，每条写明是谁说的、谁做的；切换过角色时写明何时换成了谁]',
  '',
  '## 当前场景',
  '- [最后在哪里、在做什么、气氛如何，话题停在哪]',
  '',
  '## 约定与待办',
  '- [还没兑现的约定、计划、提醒，带上时间和细节，写明是谁提出的、谁答应的]',
  '',
  '## 用户偏好',
  '- [只写用户本人说过的喜好、忌口、禁忌、对回复方式的要求，以及纠正过的地方。不写角色设定和说话风格，已写进约定与待办的不再重复]',
  '',
  '规则：',
  '- 用中文写。人名、称呼、数字、时间、地点照原文写，不改写。',
  '- 用户的关键原话用引号原样保留。',
  '- 只记录实际发生过的内容，不推测，不补写。',
  '- 不要提到这次整理，也不要说对话被压缩过。',
  '- 只输出存档正文：不调用工具，不输出 [qq] 分段块，不用角色口吻回复。',
  `- 如果上面已有 ${SUMMARY_TAG} 块，那是之前的存档。不要原样照抄：保留仍然成立的内容，删掉过时的，把新内容合并进同一份存档，结构不变。`,
].join('\n')

/** compaction-basic 回放给摘要器的对话：派生的系统头和被遮蔽的历史。对应它的 `SummarizationInput`。 */
export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** 对应 compaction-basic 的 `SummaryResult` 中经过 `ctx.llm.stream()` 的那种形态。 */
export interface SummaryResult {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
  rawOutput: ContentBlock[]
  llmStreamCall: true
}

/** 摘要调用用到的配置：compaction-basic 解析后的默认值，加按模型的覆盖。 */
export type SummaryConfig = Pick<ResolvedConfig, 'summarizationProvider' | 'summarizationModel' | 'maxTokens' | 'modelPolicies'>

/** 摘要调用只用到 `ctx.llm.stream()`，测试时可以换成假的。 */
export interface SummaryLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** 摘要调用只读 agent 的这几项。 */
export type SummaryAgent = Pick<Agent, 'options'> & {
  readonly session: Pick<Agent['session'], 'id' | 'requestHeader' | 'toolHistory'>
}

type Target = Pick<LlmCallConfig, 'provider' | 'model'>

/**
 * 用中文聊天模板生成摘要。目标模型、上限、按模型覆盖的取法和 compaction-basic 相同：
 * 配置的摘要模型 → 最近一次请求的模型 → AgentOptions。
 */
export async function summarizeChat(
  llm: SummaryLlm,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: SummaryAgent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const latestTarget = latest !== undefined && latest.provider !== '' && latest.model !== ''
    ? { provider: latest.provider, model: latest.model }
    : undefined
  const agentTarget = nonEmptyTarget(agent.options.provider, agent.options.model)
  const policy = policyFor(config, latestTarget ?? agentTarget)
  const configured = nonEmptyTarget(policy.summarizationProvider, policy.summarizationModel)
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const messages: RequestMessage[] = [
    ...input.messages,
    Object.freeze({ role: 'user' as const, content: Object.freeze([{ type: 'text' as const, text: CHAT_COMPACTION_INSTRUCTION }]) }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent.session.toolHistory(),
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: policy.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: policy.maxTokens,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  }
}

/** 默认摘要配置合并按模型的覆盖（compaction-basic 的 resolveTargetPolicy 中摘要用到的部分）。 */
function policyFor(config: SummaryConfig, target: Target | undefined): Omit<SummaryConfig, 'modelPolicies'> {
  const override = target === undefined
    ? undefined
    : config.modelPolicies.find(policy => policy.provider === target.provider && policy.model === target.model)
  return {
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
  }
}

function nonEmptyTarget(provider: string | undefined, model: string | undefined): Target | undefined {
  return provider === undefined || provider === '' || model === undefined || model === ''
    ? undefined
    : { provider, model }
}

/** 摘要没有正常结束时报错，不落半截存档。 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** 只留文字；摘要里有图片时报错，不让图片悄悄消失。 */
function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

/** compaction-basic 换成中文聊天模板。配置项、服务名、自动压缩和 `/compact` 都和原版相同。 */
export class QqbotCompactionEngine extends BasicCompactionEngine {
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // 旧历史即将被摘要换掉，先单独整理一次角色记忆。整理在触发时就取下了完整历史，
    // 不等它完成，失败也不影响压缩（docs/architecture.md 第 6 节）。没有 dsh-qqbot 服务时跳过。
    void this.ctx.get('qqbot')?.memory.consolidate(agent.id).then((outcome) => {
      if (outcome.kind === 'failed') this.ctx.logger.warn(`qqbot: 记忆整理失败：${outcome.error}`)
    })
    return summarizeChat(this.ctx.llm, this.config, input, agent, signal)
  }
}

export default QqbotCompactionEngine
