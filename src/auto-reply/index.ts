import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-client-connection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AutoReplyController } from './controller.ts'
import { AUTO_REPLY_PATH, AUTO_REPLY_SOURCE, AUTO_REPLY_TEXT } from './types.ts'
import { AutoReplyPromptSettings } from './prompt-settings.ts'
import type {} from '../index.ts'
import { dataDir } from '../storage.ts'
import { QuickReplySettings } from './quick-settings.ts'
import { QUICK_REPLY_PROMPT } from './prompts.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'qqbot-auto-reply': { kind: 'qqbot-auto-reply'; form: 'notice'; summary: string }
  }
}

export const name = 'qqbot-auto-reply'
export const inject = ['connection', 'agents', 'agentPresets', 'workspaceRegistry', 'qqbot']

export function apply(ctx: Context): void {
  // Public workspace getter, structurally typed to avoid a new runtime dependency.
  // packages/workspace/workspace/{README.md,src/index.ts}: archivedSessionIds.
  const workspace = ctx.get('workspaceRegistry') as { readonly archivedSessionIds: readonly string[] }
  const find = (id: string) => ctx.agents.get(id as Parameters<typeof ctx.agents.get>[0])
  const quick = new QuickReplySettings(dataDir(), message => ctx.logger.warn(message))
  const prompts = new AutoReplyPromptSettings(dataDir(), message => ctx.logger.warn(message))
  ctx.effect(() => ctx.qqbot.extension({ name: 'quick-replies', text: session => quick.prompt(session.id) }), 'qqbot: quick reply rules')
  const controller = new AutoReplyController({
    now: Date.now,
    availability: id => {
      const agent = find(id)
      return { allowed: agent !== undefined && ctx.agentPresets.presetForSession(agent.session) === 'qqbot'
        && agent.session.header.origin !== 'subagent' && !workspace.archivedSessionIds.includes(id),
      busy: agent === undefined || agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0,
      started: agent !== undefined && ctx.agents.turnBoundaryOf(agent.session).lastTurn > 0 }
    },
    send: id => {
      const agent = find(id)
      if (!agent) throw new Error('会话已关闭')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompts.get(id).prompt }],
        source: { kind: AUTO_REPLY_SOURCE, form: 'notice', summary: '自动接话' } }))
    },
    cancelPending: id => {
      const agent = find(id)
      if (!agent) return
      for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
        if (message.source.kind === AUTO_REPLY_SOURCE) agent.inbox.remove(message.id)
      }
    },
  })
  ctx.effect(() => ctx.qqbot.maintenance.register({
    prepare: () => { controller.clear() },
    reload: () => { quick.clear(); prompts.clear() },
  }), 'qqbot: reset auto reply')
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') controller.busy(agent.id)
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind === 'user') controller.userInput(agent.id)
    else if (message.source.kind !== AUTO_REPLY_SOURCE) controller.busy(agent.id)
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    if (message.source.kind === AUTO_REPLY_SOURCE) controller.stop(agent.id, '待发接话已取消，请重新开启。')
  })
  ctx.on('agent/error', ({ agent }) => { controller.stop(agent.id, '回复出错，自动接话已停止。') })
  ctx.on('agent/disposed', ({ agent }) => { controller.forget(agent.id) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (event.data.reason.kind === 'completed') controller.completed(session.id)
    else controller.stop(session.id, '回复已取消或未正常结束，自动接话已停止。')
  })
  ctx.effect(() => {
    const timer = setInterval(() => controller.sweep(), 10000)
    timer.unref()
    return () => { clearInterval(timer); controller.dispose() }
  }, 'qqbot: auto reply cleanup')
  ctx.effect(() => ctx.connection.fetch.register({
    path: AUTO_REPLY_PATH, methods: ['POST'], requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async request => {
      try {
        const body = await request.json() as Record<string, unknown>
        if (!body || typeof body !== 'object' || typeof body['session'] !== 'string' || !body['session'] || body['session'].length > 200) throw new Error('请求格式无效。')
        const session = body['session']
        if (['quick.get', 'quick.set', 'quick.mode.set', 'quick.prompt.get', 'quick.prompt.set', 'quick.prompt.reset', 'prompt.get', 'prompt.set', 'prompt.reset'].includes(String(body['action']))) {
          const agent = find(session)
          if (!agent || ctx.agentPresets.presetForSession(agent.session) !== 'qqbot'
            || agent.session.header.origin === 'subagent' || workspace.archivedSessionIds.includes(session)) throw new Error('请在未归档的 QQ Bot 对话中设置。')
          if (body['action'] === 'prompt.get') return Response.json(prompts.get(session))
          if (body['action'] === 'prompt.set') return Response.json(prompts.set(session, body['prompt']))
          if (body['action'] === 'prompt.reset') return Response.json(prompts.set(session, AUTO_REPLY_TEXT))
          if (body['action'] === 'quick.prompt.get') return Response.json(quick.promptView(session))
          if (body['action'] === 'quick.prompt.set') return Response.json(quick.setPrompt(session, body['prompt']))
          if (body['action'] === 'quick.prompt.reset') return Response.json(quick.setPrompt(session, QUICK_REPLY_PROMPT))
          if (body['action'] === 'quick.set') {
            if (typeof body['enabled'] !== 'boolean') throw new Error('回复建议开关无效。')
            quick.set(session, body['enabled'])
          }
          if (body['action'] === 'quick.mode.set') quick.setClickMode(session, body['clickMode'])
          return Response.json({ enabled: quick.get(session), clickMode: quick.clickMode(session) }, { headers: { 'cache-control': 'no-store' } })
        }
        const owner = body['owner']
        if (typeof owner !== 'string' || !/^[\w-]{16,100}$/.test(owner)) throw new Error('请求格式无效。')
        let view
        if (body['action'] === 'enable') view = controller.enable(session, owner, body['options'])
        else if (body['action'] === 'disable') { controller.disable(session, owner); view = controller.view(session) }
        else if (body['action'] === 'pulse' && typeof body['blocked'] === 'boolean' && Number.isSafeInteger(body['activity'])) {
          view = controller.pulse(session, owner, { blocked: body['blocked'], activity: body['activity'] as number })
        } else throw new Error('请求格式无效。')
        return Response.json(view, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : '自动接话不可用。' }, { status: 409 })
      }
    }),
  }), 'qqbot: auto reply route')
}
