import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import QqbotCompactionEngine, {
  CHAT_COMPACTION_INSTRUCTION, summarizeChat, type SummaryAgent, type SummaryConfig,
} from '../src/compaction.ts'

/** 记下请求，按给定的块回一段文字。 */
function fakeLlm(chunks: StreamChunk[]) {
  const calls: GenerateOptions[] = []
  return {
    calls,
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      yield * chunks
    },
  }
}

const textReply = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
] as StreamChunk[]

const CONFIG: SummaryConfig = { summarizationProvider: '', summarizationModel: '', maxTokens: 4096, modelPolicies: [] }

function agent(latest?: { provider: string; model: string }): SummaryAgent {
  return {
    options: { provider: 'opt', model: 'opt-model' },
    session: {
      id: 's1',
      requestHeader: () => (latest === undefined ? undefined : { config: latest }) as never,
      toolHistory: () => [] as never,
    },
  } as unknown as SummaryAgent
}

const HISTORY = { messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] } as never

describe('qqbot compaction', () => {
  it('is the native engine with only summarize overridden', () => {
    expect(QqbotCompactionEngine.prototype).toBeInstanceOf(BasicCompactionEngine)
    expect(Object.getOwnPropertyNames(QqbotCompactionEngine.prototype).sort()).toEqual(['constructor', 'summarize'])
  })

  it('appends the chat template after the replayed history and returns the text', async () => {
    const llm = fakeLlm(textReply('## 人物与称呼\n- 林哥'))
    const result = await summarizeChat(llm, CONFIG, HISTORY, agent({ provider: 'deepseek', model: 'chat' }))
    const [call] = llm.calls
    expect(call?.messages).toHaveLength(2)
    expect(call?.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: CHAT_COMPACTION_INSTRUCTION }] })
    expect(call).toMatchObject({ provider: 'deepseek', model: 'chat', maxTokens: 4096, sessionId: 's1', purpose: 'compaction' })
    expect(result).toMatchObject({ summary: [{ type: 'text', text: '## 人物与称呼\n- 林哥' }], llmStreamCall: true, provider: 'deepseek' })
    expect(CHAT_COMPACTION_INSTRUCTION).toContain('用中文写')
    expect(CHAT_COMPACTION_INSTRUCTION).toContain('<compacted-summary>')
  })

  it('picks the target like compaction-basic: configured, then latest request, then agent options', async () => {
    const target = async (config: SummaryConfig, latest?: { provider: string; model: string }) => {
      const llm = fakeLlm(textReply('x'))
      await summarizeChat(llm, config, HISTORY, agent(latest))
      return llm.calls[0]
    }
    expect(await target(CONFIG)).toMatchObject({ provider: 'opt', model: 'opt-model' })
    expect(await target(CONFIG, { provider: 'deepseek', model: 'chat' })).toMatchObject({ provider: 'deepseek', model: 'chat' })
    const configured = { ...CONFIG, summarizationProvider: 'p', summarizationModel: 'm' }
    expect(await target(configured, { provider: 'deepseek', model: 'chat' })).toMatchObject({ provider: 'p', model: 'm' })
    // 按模型的覆盖以当前对话模型匹配。
    const policy = { ...CONFIG, modelPolicies: [{ provider: 'deepseek', model: 'chat', maxTokens: 100, summarizationProvider: 'q', summarizationModel: 'n' }] }
    expect(await target(policy, { provider: 'deepseek', model: 'chat' })).toMatchObject({ provider: 'q', model: 'n', maxTokens: 100 })
    expect(await target(policy, { provider: 'other', model: 'x' })).toMatchObject({ provider: 'other', maxTokens: 4096 })
  })

  it('fails closed on truncation, empty text, and errors', async () => {
    const run = (chunks: StreamChunk[]) => summarizeChat(fakeLlm(chunks), CONFIG, HISTORY, agent())
    await expect(run([{ type: 'finish', reason: { kind: 'max-tokens' } }] as StreamChunk[])).rejects.toThrow(/truncated/)
    await expect(run(textReply('  '))).rejects.toThrow(/no text summary/)
    await expect(run([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT' } } }] as StreamChunk[]))
      .rejects.toThrow('boom')
  })
})
