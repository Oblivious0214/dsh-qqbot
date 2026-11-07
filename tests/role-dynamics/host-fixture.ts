import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, runInThisContext } from 'node:vm'
import { QqbotService } from '../../src/index.ts'
import * as prompt from '../../src/prompt.ts'
import * as api from '../../src/role-dynamics/api.ts'
import { dshHome } from '../../src/storage.ts'
import type { HistoryEvent } from '../../src/role-dynamics/history.ts'
import { UPDATE_TOOL } from '../../src/role-dynamics/model.ts'
import { example } from './fixtures.ts'

const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-tools/package.json'))
const nativeImport = runInThisContext('(url) => import(url)', { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as (url: string) => Promise<any>
export const scope = await nativeImport(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href)
/** Execute retained rc.5 code unchanged apart from dependency URL resolution. */
async function rc5(name: string) {
  const file = resolve('../../work/role-dynamics-plan-20261102/step-01-evidence/installed-host/dsh/node_modules/@deepseek-ai', name, 'lib/index.js')
  const code = readFileSync(file, 'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g, (_, spec) => {
    const dependency = spec === '@deepseek-ai/dsh-sandbox' ? resolve('../../qqbot/src/deepseek-harness/packages/sandbox/sandbox/lib/index.js') : require.resolve(spec)
    return `from ${JSON.stringify(pathToFileURL(dependency).href)}`
  })
  return nativeImport(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
export const rc5Prompt = await rc5('dsh-system-prompt')
export const rc5Tools = await rc5('dsh-tools')
const fixtureHome = dshHome()
let fixtureId = 0
export class FakeSession {
  events: HistoryEvent[] = []
  inheritedEventCount = 0
  header: { id: string; isSeeded?: boolean; parentSession?: string }
  agent: any
  constructor(readonly root: Context, readonly id: string) { this.header = { id } }
  get seq() { return this.events.length }
  append(type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const event = { seq: this.seq, type, data: structuredClone(data), time: this.seq * 100, ...extra }
    this.events.push(event)
    this.root.emit(scope.scopeTarget(this, this.agent), 'session/event', this as any, event as any)
    return event
  }
  requestHeader() { return undefined }
}
class Sessions extends Service {
  all = new Map<string, FakeSession>(); flushed = new Map<string, number>(); barrier?: () => Promise<void>; participates = true
  constructor(ctx: Context) { super(ctx, 'sessions') }
  get(id: string) { return this.all.get(id) }
  async flush(session: FakeSession) {
    const count = session.seq
    await this.barrier?.()
    this.flushed.set(session.id, count)
    return this.participates
  }
}
class Queries extends Service {
  leased = 0; released = 0; gate?: () => Promise<void>
  constructor(ctx: Context) { super(ctx, 'sessionQuery' as any) }
  async observeSession(id: string, options: unknown) {
    if (JSON.stringify(options) !== '{"projections":"none"}') throw Error('unexpected query options')
    const session = (this.ctx.get('sessions') as unknown as Sessions).all.get(id)!
    const events = structuredClone(session.events), header = structuredClone(session.header), inheritedEventCount = session.inheritedEventCount
    this.leased++; await this.gate?.()
    let disposed = false
    return { header, events, inheritedEventCount, cursor: events.length - 1, source: 'live',
      [Symbol.dispose]: () => { if (!disposed) { disposed = true; this.released++ } } }
  }
}
class Agents extends Service {
  all = new Map<string, any>()
  constructor(ctx: Context) { super(ctx, 'agents') }
  get(id: string) { return this.all.get(id) }
  list() { return [...this.all.values()] }
}
class Presets extends Service {
  choices = new Map<Context, string>()
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  composedPreset(ctx: Context) { return this.choices.get(ctx) }
}
class Connection extends Service {
  routes = new Map<string, any>()
  fetch = { register: (route: any) => { this.routes.set(route.path, route); return () => this.routes.delete(route.path) } }
  constructor(ctx: Context) { super(ctx, 'connection') }
}
class Runtime extends Service {
  language = 'typescript'; programFormat = 'module'; executionInstructions = ''
  rootError = false
  constructor(ctx: Context) { super(ctx, 'ptcRuntime' as any) }
  resolve(input: any) { return input }
  async run(input: any) {
    const args = JSON.parse(input.program)
    const result = await input.bindings[0].functions[UPDATE_TOOL](args)
    return { logs: [], value: result, ...(this.rootError ? { error: { kind: 'runtime', message: 'synthetic root failure' } } : {}) }
  }
  release() {}
}
class WorkingDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  ensure() { return Promise.resolve('E:/synthetic-workspace') }
}
export async function hostFixture() {
  process.env['DSH_HOME'] = join(fixtureHome, `host-${++fixtureId}`)
  mkdirSync(join(dshHome(), 'qqbot', 'roles'), { recursive: true })
  const root = new Context()
  await root.plugin(rc5Prompt.SystemPrompt, { includeHarnessIdentity: false })
  await root.plugin(rc5Tools.ToolRuntime, { mode: 'native' })
  for (const plugin of [Sessions, Queries, Agents, Presets, Connection, Runtime, WorkingDirectory, QqbotService]) await root.plugin(plugin as any)
  let ownerContext!: Context
  await root.plugin({ name: 'fixture-owner', inject: ['systemPrompt', 'tools', 'qqbot', 'agents', 'sessions', 'agentPresets', 'connection', 'workingDirectory'], apply: (ctx: Context) => { ownerContext = ctx } })
  const presetKey = {}, preset = scope.createScope(ownerContext, presetKey)
  preset.ctx.systemPrompt.suppressRuntimeContext()
  const promptFiber = await preset.ctx.plugin(prompt)
  await root.plugin(api)
  const host = root.qqbot.dynamicsHost
  const role = host.data.roles.save({ name: `动态角色-${Math.random()}`, persona: '静态角色正文', description: '', dynamics: example() }, true)
  host.data.bindings.setDefaultRole(role.id)
  const sessions = root.sessions as unknown as Sessions, queries = root.get('sessionQuery' as never) as unknown as Queries
  const agents = root.agents as unknown as Agents, presets = root.agentPresets as unknown as Presets
  async function agent(id = 'session-root', parent?: FakeSession, count = parent?.seq, qqbot = true) {
    const session = new FakeSession(root, id)
    if (parent) {
      session.events = structuredClone(parent.events.slice(0, count))
      session.inheritedEventCount = count!; session.header = { id, isSeeded: true, parentSession: parent.id }
    }
    const value: any = { id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
    const own = scope.createScope(ownerContext, value, qqbot ? { parent: presetKey } : undefined)
    value.ctx = own.ctx; session.agent = value
    sessions.all.set(id, session); agents.all.set(id, value); presets.choices.set(own.ctx, qqbot ? 'qqbot' : 'standard')
    await root.serial(scope.scopeTarget(value, value), 'agent/created', { agent: value, source: 'startup' })
    return { ...value, value, own, session }
  }
  function assemble(a: any) { return root.systemPrompt.assemble({ agent: a.value, scope: a.value, signal: new AbortController().signal }) as Promise<any> }
  const start = (a: any, turn = 1) => a.session.append('turn/start', { turn })
  async function call(a: any, value: unknown = 31, options: { error?: boolean; ptc?: boolean; callId?: string; noCall?: boolean; args?: unknown; signal?: AbortSignal } = {}) {
    const turn = a.session.events.findLast((event: HistoryEvent) => event.type === 'turn/start').data.turn
    const name = options.ptc ? 'run_code' : UPDATE_TOOL, callId = options.callId ?? `call-${a.session.seq}`
    const args = options.args ?? { changes: [{ name: '好感', value }] }
    const arguments_ = options.ptc ? { code: JSON.stringify(args), description: '更新状态' } : args
    const event = options.noCall ? undefined : a.session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(arguments_) })
    const result = await root.tools.execute({ agent: a.value, callId: callId as any, name, arguments: arguments_, signal: options.signal ?? new AbortController().signal })
    if (event) a.session.append('tool/result', { turn, step: 1, message: { toolCallId: callId, isError: options.error ?? result.isError, content: result.content } }, { sourceEventSeqs: [event.seq] })
    return { result, event }
  }
  function end(a: any, reason = 'completed', message = true) {
    const turn = a.session.events.findLast((event: HistoryEvent) => event.type === 'turn/start').data.turn
    if (message) a.session.append('assistant/message', { turn, message: { content: [] } })
    a.session.append('turn/end', { turn, reason: { kind: reason } })
  }
  const state = (a: any) => host.state(a.id)
  const owner = async (a: any, value: number, operationId = 'owner') => {
    const current = (await state(a))!.snapshot
    return host.ownerCommit(a.id, role.id, { operationId, baseRevision: current.revision, configRevision: current.configRevision,
      progressId: current.progressId, generation: current.generation, dataEpoch: current.dataEpoch, changes: [{ name: '好感', value }] })
  }
  return { root, host, role, sessions, queries, agents, preset, promptFiber, agent, start, call, end, assemble, state, owner,
    dir: join(dshHome(), 'qqbot'), runtime: root.get('ptcRuntime' as never) as unknown as Runtime,
    route: (path: string) => (root.connection as unknown as Connection).routes.get(path),
    async dispose() { host.dispose(); await promptFiber.dispose(); await preset.dispose(); await root.fiber.dispose() },
  }
}
