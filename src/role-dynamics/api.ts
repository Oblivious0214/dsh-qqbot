/** Exact owner-authenticated route, mounted by the host connection service. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import { presetForAgent } from '../agent-preset.ts'
import { STATE_PATH, LIBRARY_STATE_PATH, type PublicOperation } from './api-types.ts'
import { jsonData, object } from './validate.ts'
export const name = 'qqbot-role-state-api'
export const inject = ['qqbot', 'connection', 'agents', 'agentPresets']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({ path: STATE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async request => {
      try {
        let id: unknown = new URL(request.url).searchParams.get('session')
        let body: Record<string, unknown> | undefined
        if (request.method === 'POST') {
          const raw: unknown = await request.json(); jsonData(raw)
          body = object(raw, '$', ['session', 'roleId', 'operation']); id = body['session']
        }
        if (typeof id !== 'string' || !id || id.length > 512) throw new Error('会话无效')
        const agent = ctx.agents.get(id as Parameters<typeof ctx.agents.get>[0])
        if (!agent || presetForAgent(ctx.agentPresets, agent) !== 'qqbot') throw new Error('请在 QQ Bot 对话中查看状态')
        const host = ctx.qqbot.dynamicsHost
        if (body) {
          if (typeof body['roleId'] !== 'string') throw new Error('请选择当前角色')
          const operation = object(body['operation'], '$.operation', ['operationId', 'baseRevision', 'configRevision', 'dataEpoch', 'progressId', 'generation', 'changes'])
          await host.ownerCommit(id, body['roleId'], operation as unknown as PublicOperation)
        }
        return Response.json({ state: await host.state(id) }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : '状态操作未完成' }, { status: 409 })
      }
    }),
  }), 'qqbot: role state route')
  // The role library manages plugin-owned progress, including unopened conversations.
  // It never resumes an Agent or changes a conversation's selected role.
  ctx.effect(() => ctx.connection.fetch.register({ path: LIBRARY_STATE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: ctx.qqbot.maintenance.route(async request => {
      try {
        const query = new URL(request.url).searchParams
        let roleId: unknown = query.get('roleId'), session: unknown = query.get('session')
        let body: Record<string, unknown> | undefined
        if (request.method === 'POST') {
          const raw: unknown = await request.json(); jsonData(raw)
          body = object(raw, '$', ['session', 'roleId', 'operation']); roleId = body['roleId']; session = body['session']
        }
        if (typeof roleId !== 'string' || !roleId || !ctx.qqbot.content.roles.get(roleId)) throw new Error('请选择角色')
        if (!session && !body) {
          const ids = new Set(ctx.qqbot.content.bindings.sessionIds()), current = query.get('current')
          if (current && current.length <= 512) ids.add(current)
          return Response.json({ sessions: [...ids].filter(id => ctx.qqbot.content.roleIdFor({ id }) === roleId) }, { headers: { 'cache-control': 'no-store' } })
        }
        if (typeof session !== 'string' || !session || session.length > 512) throw new Error('会话无效')
        if (ctx.qqbot.content.roleIdFor({ id: session }) !== roleId) throw new Error('角色已切换，请重新选择对话')
        const host = ctx.qqbot.dynamicsHost
        if (body) {
          const operation = object(body['operation'], '$.operation', ['operationId', 'baseRevision', 'configRevision', 'dataEpoch', 'progressId', 'generation', 'changes'])
          await host.ownerCommit(session, roleId, operation as unknown as PublicOperation)
        }
        return Response.json({ state: await host.state(session, roleId, !body && query.get('preview') === '1') }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : '状态操作未完成' }, { status: 409 })
      }
    }),
  }), 'qqbot: role library state route')
}
