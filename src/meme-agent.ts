/** 每个 QQ agent 自己的 send_meme，遮蔽继承的全局工具；不改标准会话。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from './index.ts'
import { presetForAgent } from './agent-preset.ts'
import { MEME_TOOL } from './format.ts'
import { isRecord } from './json-record.ts'
import { memeMarker, searchMemes } from './meme-scope.ts'

export const MEME_DESCRIPTION = '从当前角色的可用图库中按标签或关键词找表情。挑选贴合的一张，将候选的 marker 原样写进回复；没有合适候选时继续文字回应。'
export const MEME_PARAMETERS = {
  type: 'object' as const,
  properties: {
    tag: { type: 'string' as const, description: '表情分类，可用分类见结果 tags。' },
    query: { type: 'string' as const, description: '描述或关键词。' },
    limit: { type: 'number' as const, description: '候选数量，默认 3，最多 10。' },
  }, additionalProperties: false,
}
/** rc.5 的 complete section 会移除 PTC SDK，补回本工具自己的声明。 */
export function toolDeclaration(ctx: Context, input: AssembleContext): string {
  const tools = ctx.get('tools') as (Context['tools'] & { modeFor?(scope: unknown): string }) | undefined
  if (!input.agent || tools?.modeFor?.(input.scope) !== 'ptc' || !tools.get(MEME_TOOL, input.agent)) return ''
  return `tools.${MEME_TOOL}\n${JSON.stringify({ name: MEME_TOOL, description: MEME_DESCRIPTION, parameters: MEME_PARAMETERS })}`
}
export function scopedMemeTool(ctx: Context, agent: Agent): ToolDefinition {
  return {
    name: MEME_TOOL, description: MEME_DESCRIPTION, parameters: MEME_PARAMETERS,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      ctx.qqbot.maintenance.assertAvailable()
      if (exec.agent !== agent || !ctx.tools.get(MEME_TOOL) || exec.signal.aborted) throw new Error('表情工具当前不可用')
      const data = ctx.qqbot.content
      data.roles.reload()
      const selected = () => { const role = data.roleFor({ id: agent.id }); return { id: role?.id, packs: role?.memePacks ?? [] } }
      const before = selected()
      const result = await ctx.qqbot.memes.read(before.packs, AbortSignal.any([exec.signal, AbortSignal.timeout(15_000)]))
      data.roles.reload()
      ctx.qqbot.maintenance.assertAvailable()
      if (exec.signal.aborted || !ctx.tools.get(MEME_TOOL) || JSON.stringify(selected()) !== JSON.stringify(before)) throw new Error('角色表情设置已变化，请重新选图')
      const input = isRecord(args) ? args : {}
      const hits = searchMemes(result.memes, typeof input['tag'] === 'string' ? input['tag'] : '', typeof input['query'] === 'string' ? input['query'] : '', typeof input['limit'] === 'number' ? input['limit'] : 3)
      return { hits: hits.map(row => ({ caption: row.caption, tag: row.tag, marker: memeMarker(row) })),
        tags: [...new Set(result.memes.map(row => row.tag))],
        message: result.message ?? (hits.length ? '将选中候选的 marker 原样写进回复。' : '没有匹配的表情，可按 tags 换词检索，或继续文字回应。') }
    },
  }
}

export const name = 'qqbot-meme-scope'
export const inject = ['qqbot', 'tools']
export function apply(ctx: Context): void {
  const agents = new Map<Agent, (() => void) | undefined>()
  let syncing = false
  const sync = () => {
    if (syncing) return
    syncing = true
    try {
      const available = !!ctx.tools.get(MEME_TOOL)
      for (const [agent, dispose] of agents) {
        if (available && !dispose) agents.set(agent, agent.ctx.tools.register(scopedMemeTool(ctx, agent)))
        if (!available && dispose) { agents.set(agent, undefined); dispose() }
      }
    } finally { syncing = false }
  }
  const attach = (agent: Agent) => {
    const presets = ctx.get('agentPresets')
    if (presets && presetForAgent(presets, agent) !== 'qqbot') return
    if (agents.has(agent)) return
    agents.set(agent, undefined); sync()
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { const dispose = agents.get(agent); agents.delete(agent); dispose?.() })
  ctx.on('tools/change', sync)
  if (ctx.get('agentPresets')) for (const agent of ctx.get('agents')?.list() ?? []) attach(agent)
  ctx.effect(() => () => { const disposers = [...agents.values()]; agents.clear(); for (const dispose of disposers) dispose?.() }, 'qqbot: scoped meme tools')
}
