import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from './index.ts'
import type { QqbotData } from './content.ts'
import { MEME_SCOPE_PATH } from './meme-scope.ts'
import { MEME_TOOL } from './format.ts'
import { presetForAgent } from './agent-preset.ts'

/** 历史回复按当轮角色取图库；最早记录之前的身份未知时不借用后来的角色。 */
export function memeRoleAt(data: QqbotData, session: string, turn?: number) {
  if (turn === undefined) return data.roleFor({ id: session })
  const history = data.bindings.turnsOf(session)
  if (!history.length) return data.roleFor({ id: session })
  const id = history.findLast(row => row.turn <= turn)?.role
  return id == null ? undefined : data.roles.get(id)
}

export const inject = ['qqbot', 'connection', 'tools', 'agents', 'agentPresets']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: MEME_SCOPE_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async request => {
      const params = new URL(request.url).searchParams
      const session = params.get('session') ?? ''
      const turn = params.has('turn') ? Number(params.get('turn')) : undefined
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(session) || (turn !== undefined && (!Number.isSafeInteger(turn) || turn < 0))) {
        return Response.json({ message: '会话或轮次无效' }, { status: 400 })
      }
      const data = ctx.qqbot.content
      const agent = ctx.agents.get(session as Parameters<typeof ctx.agents.get>[0])
      if (!agent || presetForAgent(ctx.agentPresets, agent) !== 'qqbot') return Response.json({ memes: [] }, { status: 404 })
      if (data.bindings.get(session) === undefined || !ctx.tools.get(MEME_TOOL)) return Response.json({ memes: [] })
      data.roles.reload()
      const selection = () => {
        const role = memeRoleAt(data, session, turn)
        return { id: role?.id, packs: role?.memePacks ?? [] }
      }
      const selected = selection()
      try {
        const result = await ctx.qqbot.memes.read(selected.packs, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]))
        data.roles.reload()
        if (!ctx.tools.get(MEME_TOOL) || JSON.stringify(selection()) !== JSON.stringify(selected)) return Response.json({ memes: [] })
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      } catch {
        return Response.json({ memes: [], message: '读取角色表情失败，请重试。' }, { status: 503 })
      }
    }),
  }), 'qqbot: scoped meme catalogue')
}
