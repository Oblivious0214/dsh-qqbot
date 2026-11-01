/**
 * dsh-toy-buttplug host 层入口：设置和会话接入状态的接口，以及（装了 dsh-qqbot 时）向 qqbot 登记设备规则。
 *
 * 隔离：本插件不注册任何 systemPrompt section，不进任何预设。没装或停用 dsh-qqbot 时什么提示词也不出现；
 * 装了时规则只进已接入的 qqbot 会话（`qqbot:ext:toy`），状态只进 `qqbot:runtime`。
 * 设备连接和运动都在浏览器里，host 不碰设备。
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { guardWrites } from '../maintenance.ts'
import type {} from '@deepseek-ai/dsh-client-connection'
import { DEFAULT_BURST, STATE_PATH, type ToyError, type ToyView } from './api-types.ts'
import { RANGES } from './core/config.ts'
import { DEFAULT_PROACTIVITY_TEXTS, MAX_PROACTIVITY_TEXT_LENGTH, DEVICE_STATUSES, runtimeLine, type DeviceStatus, type ProactivityTexts } from './core/rules.ts'
import { PROACTIVITY_KEYS, proactivityOfKey } from './core/safety.ts'
import { SessionStates, validSessionId, type SessionRole } from './sessions.ts'
import { parseSettings, SettingsStore } from './settings.ts'
import { dataDir, isRecord } from './storage.ts'
import { ActionLibraryStore } from './motion-library/store.ts'
import { presetRuntime } from './motion-library/config.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { AFTERCARE_SUMMARY, CLIMAX_SOURCE, CLIMAX_SUMMARY, aftercareText, climaxText } from './climax-prompt.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'qqbot-toy-climax': { kind: 'qqbot-toy-climax'; form: 'notice'; summary: string }
  }
}

/** 向会话投递高潮消息；没有 agents 服务时为空。 */
export interface ClimaxPrompter {
  send(session: string, text: string, summary: string): void
  /** 撤回还没开始处理的高潮／温存消息。 */
  cancel(session: string): void
}

export type { ToyAction, ToySessionView, ToySettings, ToyView } from './api-types.ts'

export const name = 'toy-buttplug'
export const inject = ['connection']

/** dsh-qqbot 登记服务中本插件用到的部分。只按结构使用，不依赖 dsh-qqbot 的包。 */
interface QqbotRegistry {
  extension(entry: { name: string; text: string | ((session: { id: string }) => string) }): () => void
  runtime(name: string, text: string | ((session: { id: string }) => string)): () => void
  /**
   * 0.1.5 起有。角色卡的 proactivity 写 follow / situational / high，没写时为空。
   * motionActions、motionRanges 同版起有：偏好的动作和范围，名称和本插件一致。
   */
  role?(session: { id: string }): {
    name: string; proactivity?: string; proactivityTexts?: ProactivityTexts; motionActions?: readonly string[]; motionRanges?: readonly string[]
  } | undefined
}

/** 按本插件的顺序留下认识的值；一个都不剩时为空。 */
function known<T extends string>(values: readonly string[] | undefined, choices: readonly T[]): T[] | undefined {
  if (!Array.isArray(values)) return undefined
  const picked = choices.filter(c => values.includes(c))
  return picked.length === 0 ? undefined : picked
}

/** 请求格式不对，和"操作本身失败"区分开。 */
export class BadRequest extends Error {}

export class ToyHost {
  readonly settings: SettingsStore
  readonly sessions: SessionStates
  readonly actionLibrary: ActionLibraryStore
  /** dsh-qqbot 的登记服务在场。 */
  qqbot = false
  prompter: ClimaxPrompter | undefined
  private roles: QqbotRegistry | undefined
  private registration: (() => void) | undefined
  private registry: QqbotRegistry | undefined
  private conflict = ''
  private revision = 0
  private controlEpoch = randomUUID()
  private disposed = false
  private readonly listeners = new Set<() => void>()

  private changed(): void {
    this.revision++
    for (const listener of [...this.listeners]) listener()
  }

  /** 长轮询只传设置与停用状态；不驱动设备，不产生模型消息。 */
  async watch(after: number, signal: AbortSignal): Promise<void> {
    if (this.disposed || after !== this.revision || signal.aborted) return
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.listeners.delete(done); signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, 20000)
      this.listeners.add(done)
      signal.addEventListener('abort', done, { once: true })
      if (signal.aborted) done()
    })
  }

  refreshRegistration(): void {
    if (this.disposed) return
    const conflict = this.legacyActive() ? '请先在 DSH 插件管理中停用旧的独立联动插件，再使用内置联动。' : ''
    const allowed = this.settings.value.enabled !== false && conflict === ''
    if (!allowed) {
      this.sessions.clear()
      this.registration?.()
      this.registration = undefined
    } else if (this.registry !== undefined && this.registration === undefined) {
      this.roles = this.registry
      const extension = this.registry.extension({ name: 'toy', text: session => this.sessions.rules(session.id) })
      const runtime = this.registry.runtime('device', session => {
        const status = this.sessions.status(session.id)
        if (status === undefined) return ''
        const catalog = presetRuntime(this.actionLibrary.value)
        return catalog === '' ? runtimeLine(status) : `${runtimeLine(status)}\n可选动作：\n${catalog}`
      })
      this.registration = () => { runtime(); extension(); this.roles = undefined }
    }
    if (this.conflict !== conflict) { this.controlEpoch = randomUUID(); this.conflict = conflict; this.changed() }
  }

  /** 撤回授权并通知全部客户端停止；不连接设备。 */
  reset(resetLibrary = true): void {
    this.settings.reset()
    if (resetLibrary) this.actionLibrary.reset()
    this.sessions.clear()
    this.controlEpoch = randomUUID()
    this.refreshRegistration()
    this.changed()
  }

  dispose(): void {
    this.disposed = true
    this.registration?.()
    this.registration = undefined
    this.registry = undefined
    this.sessions.clear()
    this.changed()
    this.listeners.clear()
  }

  constructor(dir: string, warn: (message: string) => void, private readonly legacyActive: () => boolean = () => false) {
    this.settings = SettingsStore.at(dir, warn)
    this.actionLibrary = ActionLibraryStore.at(dir, warn)
    this.sessions = new SessionStates(() => this.settings.value, id => this.roleOf(id))
  }

  /** 会话当前的角色。未设置或不认识的档位按低自主性处理，不认识的偏好丢掉。 */
  private roleOf(id: string): SessionRole | undefined {
    const role = this.roles?.role?.({ id })
    if (role === undefined) return undefined
    const proactivity = proactivityOfKey(role.proactivity)
    const names = this.actionLibrary.value.library.clips.map(clip => clip.name)
    const actions = known(role.motionActions, names)
    const ranges = known(role.motionRanges, RANGES)
    const texts = role.proactivityTexts
    const proactivityTexts: ProactivityTexts = {}
    if (isRecord(texts)) for (const key of PROACTIVITY_KEYS) {
      const text = texts[key]
      if (typeof text === 'string' && text.length <= MAX_PROACTIVITY_TEXT_LENGTH) proactivityTexts[key] = text
    }
    return {
      name: role.name,
      ...Object.keys(proactivityTexts).length === 0 ? {} : { proactivityTexts },
      ...proactivity === undefined ? {} : { proactivity },
      ...actions === undefined ? {} : { actions },
      ...ranges === undefined ? {} : { ranges },
    }
  }

  view(session: string | undefined): ToyView {
    this.refreshRegistration()
    return {
      revision: this.revision,
      actionLibrary: this.actionLibrary.value,
      controlEpoch: this.controlEpoch,
      ...this.conflict === '' ? {} : { conflict: this.conflict },
      settings: this.disposed ? { ...this.settings.value, enabled: false } : this.settings.value,
      proactivityDefaults: { ...DEFAULT_PROACTIVITY_TEXTS, ...this.settings.value.proactivityTexts },
      qqbot: this.qqbot,
      ...session === undefined ? {} : { session: this.sessions.view(session) },
    }
  }

  /** 执行一个操作，返回操作涉及的会话 id。格式错误抛 BadRequest，操作失败抛 Error。 */
  apply(body: unknown): string | undefined {
    if (!isRecord(body)) throw new BadRequest('请求格式无效')
    this.refreshRegistration()
    const action = body['action']
    if (action === 'library.save') {
      try { this.actionLibrary.save(body['library']) }
      catch (error) { throw new BadRequest(error instanceof Error ? error.message : String(error)) }
      this.changed()
      return undefined
    }
    if (action === 'module.enable') {
      if (typeof body['enabled'] !== 'boolean') throw new BadRequest('联动开关无效')
      this.settings.save({ ...this.settings.value, enabled: body['enabled'],
        ...body['enabled'] && !this.conflict ? { deviceIntroSeen: true } : {} })
      if (!body['enabled']) this.controlEpoch = randomUUID()
      this.sessions.settingsChanged()
      this.refreshRegistration()
      this.changed()
      return undefined
    }
    if (action === 'settings.save') {
      let next
      try {
        next = parseSettings(body['settings'])
        // 普通设置表单不得用旧快照重新开启总开关。
        next = { ...next, enabled: this.settings.value.enabled !== false,
          ...this.settings.value.deviceIntroSeen || next.authorized && !this.settings.value.authorized ? { deviceIntroSeen: true } : {} }
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error))
      }
      this.settings.save(next)
      if (!next.authorized) this.controlEpoch = randomUUID()
      this.sessions.settingsChanged()
      this.changed()
      return undefined
    }
    const session = body['session']
    if (!validSessionId(session)) throw new BadRequest('缺少会话 id')
    const status = () => {
      const value = body['status']
      if (!DEVICE_STATUSES.includes(value as DeviceStatus)) throw new BadRequest('设备状态无效')
      return value as DeviceStatus
    }
    switch (action) {
      case 'session.attach':
        if (this.conflict) throw new Error(this.conflict)
        this.sessions.attach(session, status())
        return session
      case 'session.status':
        this.sessions.setStatus(session, status())
        return session
      case 'session.detach':
        this.sessions.detach(session)
        return session
      case 'session.climax':
        if (this.sessions.status(session) === undefined) throw new Error('本会话尚未接入联动')
        if (this.prompter === undefined) throw new Error('当前无法向对话发送消息')
        this.prompter.send(session, climaxText(this.settings.value.burst ?? DEFAULT_BURST, this.settings.value.climaxPrompts), CLIMAX_SUMMARY)
        return session
      case 'session.aftercare':
        if (this.sessions.status(session) === undefined) throw new Error('本会话尚未接入联动')
        if (this.prompter === undefined) throw new Error('当前无法向对话发送消息')
        this.prompter.send(session, aftercareText(this.settings.value.burst ?? DEFAULT_BURST, this.settings.value.climaxPrompts), AFTERCARE_SUMMARY)
        return session
      case 'session.climax.cancel':
        this.prompter?.cancel(session)
        return session
      default:
        throw new BadRequest('不认识的操作')
    }
  }

  /** 向 qqbot 登记规则和状态，返回撤销函数。 */
  register(qqbot: QqbotRegistry): () => void {
    this.registry = qqbot
    this.refreshRegistration()
    return () => { this.registration?.(); this.registration = undefined; this.registry = undefined; this.roles = undefined }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(status: number, error: ToyError['error'], message: string): Response {
  return json(status, { error, message } satisfies ToyError)
}

interface LoaderEntry {
  readonly options: { readonly name: string }
  readonly disabled: boolean
  readonly fiber?: { readonly state: number }
}

/** Cordis FiberState 的 LOADING=1 / ACTIVE=2 / UNLOADING=5；卸载完成前也让出槽位。 */
export function standaloneToyActive(entries: Iterable<LoaderEntry>): boolean {
  return [...entries].some(entry => entry.options.name === 'dsh-toy-buttplug'
    && (!entry.disabled || entry.fiber !== undefined && [1, 2, 5].includes(entry.fiber.state)))
}

export function apply(ctx: Context): void {
  // 与宿主 plugin-inventory 相同，只读 Loader 的有效状态，不改旧插件配置。
  const legacyActive = () => {
    const loader = ctx.get('loader') as { entries(): Iterable<LoaderEntry> } | undefined
    return loader !== undefined && standaloneToyActive(loader.entries())
  }
  const host = new ToyHost(dataDir(), message => ctx.logger.warn(message), legacyActive)
  ctx.effect(() => () => { host.dispose() }, 'qqbot: toy host')
  ctx.on('internal/status', () => { host.refreshRegistration() })

  ctx.inject(['qqbot'], (inner) => {
    const qqbot = (inner as unknown as { qqbot: QqbotRegistry }).qqbot
    inner.effect(() => inner.qqbot.maintenance.register({ prepare: () => {
      if (legacyActive()) throw new Error('请先停用旧的独立联动插件，再清理全部数据。')
      // 准备阶段只撤销设备状态；凭据清理失败时仍须保留原动作库。
      host.reset(false)
    }, reload: () => host.reset() }), 'qqbot: reset toy')
    inner.effect(() => {
      host.qqbot = true
      const unregister = host.register(qqbot)
      return () => { unregister(); host.qqbot = false }
    }, 'toy-buttplug: qqbot registration')
  })

  // 高潮按钮与转入温存的消息：只投给 qqbot 预设的会话；来源不是 user，不算用户发言。
  ctx.inject(['agents', 'agentPresets'], inner => {
    const find = (id: string) => inner.agents.get(id as Parameters<typeof inner.agents.get>[0])
    inner.effect(() => {
      host.prompter = {
        send: (session, text, summary) => {
          const agent = find(session)
          if (agent === undefined || inner.agentPresets.presetForSession(agent.session) !== 'qqbot') throw new Error('会话已关闭或不是 QQ Bot 对话')
          agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: CLIMAX_SOURCE, form: 'notice', summary } }))
        },
        cancel: session => {
          const agent = find(session)
          if (agent === undefined) return
          for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
            if (message.source.kind === CLIMAX_SOURCE) agent.inbox.remove(message.id)
          }
        },
      }
      return () => { host.prompter = undefined }
    }, 'qqbot: toy climax prompt')
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: guardWrites(ctx, async (request) => {
      let session: string | undefined
      if (request.method === 'POST') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return fail(400, 'bad-request', '请求不是有效的 JSON')
        }
        try {
          session = host.apply(body)
        } catch (error) {
          if (error instanceof BadRequest) return fail(400, 'bad-request', error.message)
          return fail(409, 'failed', error instanceof Error ? error.message : String(error))
        }
      } else {
        const params = new URL(request.url).searchParams
        if (params.has('watch')) {
          const revision = Number(params.get('watch'))
          if (!Number.isSafeInteger(revision)) return fail(400, 'bad-request', '同步版本无效')
          host.refreshRegistration()
          await host.watch(revision, request.signal)
        }
        const query = params.get('session') ?? undefined
        if (query !== undefined && !validSessionId(query)) return fail(400, 'bad-request', '会话 id 无效')
        session = query
      }
      return json(200, host.view(session))
    }),
  }), 'toy-buttplug: state route')
}
