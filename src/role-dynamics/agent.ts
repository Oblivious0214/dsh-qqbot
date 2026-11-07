/** Standing qqbot composition; every agent owns its scoped tool and frozen turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptPresentation } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '../index.ts'
import { presetForAgent } from '../agent-preset.ts'
import { CONTEXT_NAME, CONTEXT_ORDER } from '../order.ts'
import { digest, turnEnd, validStateCall, type HistoryEvent } from './history.ts'
import { candidateOperation } from './host.ts'
import { renderModelProjection, UPDATE_DESCRIPTION, UPDATE_PARAMETERS, UPDATE_TOOL } from './model.ts'
import { DynamicsError, type StateValue, type StateField } from './types.ts'
import { jsonData, normalizeName, validateValue } from './validate.ts'
import type { TurnHandle } from './service.ts'

export const name = 'qqbot-role-dynamics'
export const inject = ['qqbot', 'systemPrompt', 'tools']
/** rc.5 collapses PTC schemas to run_code and complete removes tools:sdk.
 * Carry only this registered capability's existing declaration in qqbot:prompt. */
export function toolDeclaration(ctx: Context, input: AssembleContext): string {
  if (!input.agent) return ''
  const tools = ctx.get('tools') as (Context['tools'] & { modeFor?(scope: unknown): string }) | undefined
  if (tools?.modeFor?.(input.scope) !== 'ptc' || !tools.get(UPDATE_TOOL, input.agent)) return ''
  return `tools.${UPDATE_TOOL}\n${JSON.stringify({ name: UPDATE_TOOL, description: UPDATE_DESCRIPTION, parameters: UPDATE_PARAMETERS })}`
}
interface Slot {
  start: number; roleId?: string; revision: string; writable: boolean; enabled: boolean
  handle?: TurnHandle; pending?: Promise<TurnHandle | undefined>; error?: unknown
}
interface Runtime { agent: Agent; slot?: Slot; unregister?: () => void; blockedStart?: number; disposed: boolean }
type Rc5Presentation = PromptPresentation & { tools?: { name: string; description: string; parameters: unknown }[] }
export function apply(ctx: Context): void {
  const host = ctx.qqbot.dynamicsHost, states = new Map<Agent, Runtime>()
  const reset = (state: Runtime) => {
    if (state.slot) state.blockedStart = state.slot.start
    delete state.slot; state.unregister?.(); delete state.unregister
  }
  const stop = (state: Runtime) => {
    state.disposed = true
    try {
      if (state.slot?.enabled && state.slot.roleId !== undefined) host.core.invalidateOpenTarget({ roleId: state.slot.roleId, sessionId: state.agent.id })
    } finally { reset(state) }
  }
  ctx.effect(() => host.onInvalidate(() => { for (const state of states.values()) reset(state) }), 'qqbot: dynamics lifecycle')
  ctx.effect(() => () => {
    const errors: unknown[] = []
    for (const state of states.values()) { try { stop(state) } catch (error) { errors.push(error) } }
    states.clear()
    if (errors.length) throw new AggregateError(errors, '动态轮次撤销失败')
  }, 'qqbot: dynamics agents')
  const configFor = (agent: Agent) => {
    const roleId = host.data.roleIdFor({ id: agent.id })
    const config = roleId === undefined ? undefined : host.data.roles.configuration(roleId)
    return { roleId, config }
  }
  const select = (state: Runtime, event: HistoryEvent) => {
    state.unregister?.(); delete state.unregister
    const { roleId, config } = configFor(state.agent)
    state.slot = { start: event.seq, ...(roleId === undefined ? {} : { roleId }), revision: digest(config ?? null),
      enabled: config?.enabled === true, writable: config?.enabled === true && config.fields.some(field => field.visible && field.aiWritable) }
    if (state.slot.writable) state.unregister = state.agent.ctx.tools.register(tool(state))
  }
  const freeze = async (state: Runtime, input: AssembleContext): Promise<TurnHandle | undefined> => {
    if (input.signal?.aborted || state.disposed) throw new Error('动态轮次已取消')
    const current = state.slot
    if (!current || current.start === state.blockedStart) throw new Error('动态轮次准入已失效')
    if (current.error) throw current.error
    if (current.handle) return current.handle
    if (!current.enabled) return undefined
    const { roleId, config } = configFor(state.agent)
    if (!config?.enabled || roleId !== current.roleId || current.revision !== digest(config)) throw new Error('动态设定或角色已变化，请重新发送')
    if (!current.pending) current.pending = host.maintenance.write(async guard => {
      await host.prepareSession(state.agent.id); guard()
      if (state.slot !== current || state.disposed || input.signal?.aborted) throw new Error('动态轮次准入已失效')
      if (current.revision !== digest(configFor(state.agent).config ?? null)) throw new Error('动态设定已变化，请重新发送')
      host.recordSelection(state.agent.id, current.start)
      const handle = await host.core.beginTurn({ sessionId: state.agent.id, roleId: roleId! }, current.start); guard()
      if (state.slot !== current || state.disposed || input.signal?.aborted) {
        host.core.invalidateOpenTarget({ sessionId: state.agent.id, roleId: roleId! })
        throw new Error('动态轮次准入已失效')
      }
      if (handle) current.handle = handle
      return handle
    })
    return current.pending
  }
  function tool(state: Runtime): ToolDefinition {
    return {
      name: UPDATE_TOOL, description: UPDATE_DESCRIPTION, parameters: structuredClone(UPDATE_PARAMETERS),
      output: { schema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(input, exec) {
        const current = state.slot, handle = current?.handle
        if (state.disposed || exec.agent !== state.agent || exec.signal.aborted || !current?.writable || !handle) throw new Error('本轮状态更新已失效')
        let changes: { name: string; value: StateValue }[]
        try {
          jsonData(input)
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'changes')) throw Error('shape')
          const raw = (input as { changes?: unknown }).changes
          if (!Array.isArray(raw) || !raw.length || raw.length > 32) throw Error('shape')
          changes = raw.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['name', 'value'].includes(key))) throw Error('shape')
            const name = normalizeName(item.name), field = handle.projection.fields.find(field => field.name === name && field.writable)
            if (!field) throw Error('field')
            const definition = { ...field, initial: field.value, visible: true, aiWritable: true } as StateField
            return { name, value: validateValue(definition, item.value, `$.${field.name}`) }
          })
        } catch (error) {
          if (error instanceof DynamicsError && handle.projection.fields.some(field => error.path === `$.${field.name}`)) throw new Error(error.message)
          if ((error instanceof Error && error.message === 'field') || (error instanceof DynamicsError && error.path === '$.name')) throw new Error('本轮没有这个可更新字段')
          throw new Error('状态更新格式无效')
        }
        return host.maintenance.write(async guard => {
          if (exec.signal.aborted || state.slot !== current || state.disposed) throw new Error('本轮状态更新已失效')
          const cut = host.history.capture(state.agent.id)
          if (turnEnd(cut, current.start)) throw new Error('本轮状态更新已失效')
          const call = cut.events.findLast(event => event.seq > current.start && validStateCall(cut, current.start, event, exec.callId))
          if (!call) throw new Error('本轮没有匹配的状态更新调用')
          try {
            const accepted = await host.core.propose(handle, candidateOperation(handle.snapshot, handle.source, current.start, call.seq, changes), { seq: call.seq, callId: exec.callId })
            guard()
            if (exec.signal.aborted || state.slot !== current || state.disposed) throw new Error('stale')
            return accepted
          } catch { throw new Error('本轮状态更新未被接收，请依据当前状态继续回应') }
        })
      },
    }
  }
  ctx.on('agent/created', async ({ agent, signal }) => {
    const presets = ctx.get('agentPresets')
    if (presets && presetForAgent(presets, agent) !== 'qqbot') return
    const state: Runtime = { agent, disposed: false }; states.set(agent, state)
    await host.attach(agent.id)
    if (signal?.aborted || state.disposed) throw new Error('动态会话初始化已取消')
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (!state) return
    try { stop(state) } finally { states.delete(agent) }
  })
  ctx.on('session/event', (session, event) => {
    const state = [...states.values()].find(state => state.agent.session === session)
    if (!state || state.disposed) return
    if (event.type === 'turn/start') {
      try { select(state, event as unknown as HistoryEvent) }
      catch (error) { state.slot = { start: event.seq, revision: '', enabled: true, writable: false, error } }
    }
    if (event.type === 'turn/end') {
      const current = state.slot
      state.unregister?.(); delete state.unregister
      if (!current?.handle) return
      void host.maintenance.write(async guard => {
        const result = await host.core.settleTurn(current.handle!); guard()
        if (result.status === 'pending') throw new Error(result.error ?? '动态状态结算尚未完成')
      }).catch(error => { ctx.logger.warn('qqbot: 动态状态结算失败：%s', error) })
    }
  })
  ctx.systemPrompt.context({ name: CONTEXT_NAME.ROLE_DYNAMICS, order: CONTEXT_ORDER.ROLE_DYNAMICS,
    required: true, interpolate: false,
    text: input => { const state = input.agent && states.get(input.agent); return state?.slot?.handle ? renderModelProjection(state.slot.handle.projection) : '' },
  })
  ctx.on('system-prompt/assemble', async (assembly, input, next) => {
    if (!input.agent) return next()
    const state = states.get(input.agent)
    if (!state) return next()
    const current = state.slot
    if (!current) {
      if (configFor(state.agent).config?.enabled) throw new Error('动态轮次尚未开始')
      return next()
    }
    if (current.error) throw current.error
    const handle = await freeze(state, input)
    const assert = () => { if (state.slot !== current || state.disposed || input.signal?.aborted) throw new Error('动态轮次准入已失效') }
    assert()
    const text = handle ? renderModelProjection(handle.projection) : ''
    const replace = (value: Rc5Presentation): Rc5Presentation => {
      const contexts = value.contexts.filter(context => text || context.name !== CONTEXT_NAME.ROLE_DYNAMICS)
        .map(context => context.name === CONTEXT_NAME.ROLE_DYNAMICS ? { ...context, text, interpolate: false } : context)
      if (text && !contexts.some(context => context.name === CONTEXT_NAME.ROLE_DYNAMICS)) contexts.push({ name: CONTEXT_NAME.ROLE_DYNAMICS, text, interpolate: false })
      const tools = value.tools
      if (current.writable && !state.agent.ctx.tools.get(UPDATE_TOOL, state.agent)) throw new Error('动态状态工具登记已变化')
      if (current.writable && tools && !tools.some(tool => [UPDATE_TOOL, 'run_code'].includes(tool.name))) throw new Error('动态状态工具与请求不一致')
      value.contexts = contexts
      if (tools) value.tools = tools.filter(tool => tool.name !== UPDATE_TOOL || current.writable)
      return value
    }
    replace(assembly as Rc5Presentation)
    const result = replace(await next() as Rc5Presentation); assert()
    if (handle) ctx.qqbot.lastDynamics.set(state.agent, text)
    return result
  })
}
