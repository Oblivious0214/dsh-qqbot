/**
 * dsh-qqbot host 层入口：提供 `ctx.qqbot` 登记服务、提示词查看器接口、角色/破限预设编辑接口、QQ 界面设置接口和语音接口。
 * 本插件不注册任何提示词，不写 agent-preset-registry 的设置；
 * 提示词由 qqbot 预设内的 dsh-qqbot/prompt 组装。
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionBindings } from './bindings.ts'
import { QqbotData } from './content.ts'
import { initializeDefaultConfiguration } from './defaults.ts'
import * as library from './library.ts'
import { MemoryCoordinator } from './memory-coordinator.ts'
import { JailbreakStore } from './presets.ts'
import { QqbotRegistryStore, type QqbotExtensionEntry, type QqbotRegistry, type QqbotRoleInfo, type QqbotSession, type QqbotText } from './registry.ts'
import { MemoryStore } from './role-memory.ts'
import { RoleLibrary } from './roles.ts'
import { dataDir, dshHome } from './storage.ts'
import * as ui from './ui.ts'
import * as viewer from './viewer.ts'
import * as voice from './voice.ts'
import * as toy from './toy/index.ts'
import * as autoReply from './auto-reply/index.ts'
import * as maintenance from './maintenance.ts'
import * as phone from './phone/index.ts'
import * as update from './update.ts'
import { MemeSource } from './meme-source.ts'
import * as memeApi from './meme-api.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DynamicsHost, recoverDynamicsSelections } from './role-dynamics/host.ts'
import type { DynamicsPublic } from './role-dynamics/api-types.ts'
import * as dynamicsApi from './role-dynamics/api.ts'

export type { QqbotExtensionEntry, QqbotRegistry, QqbotRoleInfo, QqbotSession, QqbotText } from './registry.ts'
export type { DynamicsPublic, DynamicsSource, PublicOperation, StateView } from './role-dynamics/api-types.ts'
export type { Snapshot as DynamicsSnapshot, Target as DynamicsTarget } from './role-dynamics/contracts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    qqbot: QqbotService
  }
}

/**
 * `ctx.qqbot`：外部插件只用 QqbotRegistry 部分；其余成员供本插件的预设内组件和查看器读取。
 * 是 cordis Service，所以方法里的 `this.ctx` 是调用方的 Context，登记时能记下来源插件。
 */
export class QqbotService extends Service implements QqbotRegistry {
  readonly memes: MemeSource
  readonly store = new QqbotRegistryStore()
  readonly maintenance: maintenance.Maintenance
  /** 角色库、会话绑定和破限预设，数据在 `<DSH_HOME>/qqbot/`。 */
  readonly content: QqbotData
  /** QQ 界面设置、角色头像和聊天背景，只给浏览器端显示用，不进提示词。 */
  readonly ui: ui.UiStore
  /** 语音引擎、音色和朗读设置。API key 不在这里，在 DSH 凭据库。 */
  readonly voice: voice.VoiceStore
  /** 角色记忆整理的调度。会话由预设内的 memory-agent 登记。 */
  readonly memory: MemoryCoordinator
  readonly dynamicsHost: DynamicsHost
  lastDynamics = new WeakMap<object, string>()
  get dynamics(): DynamicsPublic { return this.dynamicsHost.forPlugin(callerName(this.ctx), this.ctx) }
  /**
   * 每个 agent 上一次真实组装出的系统提示词，供查看器对比"上一轮发出的"和"下一轮要发的"。
   * 以 agent 对象为键，agent 释放后自动回收；重启后为空。
   */
  lastPrompt = new WeakMap<object, string>()

  constructor(ctx: Context) {
    super(ctx, 'qqbot')
    this.memes = new MemeSource(() => {
      const web = ctx.get('webServer')
      if (!web) throw new Error('当前没有可用的表情图库入口')
      return web.getOrigin()
    })
    const warn = (message: string) => ctx.logger.warn(message)
    const dir = dataDir(dshHome())
    this.maintenance = new maintenance.Maintenance(dshHome(), warn)
    ctx.effect(() => () => this.maintenance.dispose(), 'qqbot: stop maintenance')
    initializeDefaultConfiguration(dir, warn)
    recoverDynamicsSelections(dir)
    this.ui = new ui.UiStore(dir, warn)
    this.voice = new voice.VoiceStore(dir, warn)
    this.content = new QqbotData(
      new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn, MemoryStore.at(dir, warn),
    )
    this.memory = new MemoryCoordinator(this.content, warn, () => this.maintenance.active)
    this.dynamicsHost = new DynamicsHost(ctx, dir, this.content, this.maintenance)
    ctx.effect(() => () => this.dynamicsHost.dispose(), 'qqbot: dynamics stop')
    ctx.effect(() => this.maintenance.register({
      cache: () => { this.lastPrompt = new WeakMap(); this.lastDynamics = new WeakMap() },
      prepare: () => { this.memory.invalidate(); this.lastPrompt = new WeakMap(); this.lastDynamics = new WeakMap() },
      reload: () => {
        try { initializeDefaultConfiguration(dir, warn) } finally {
          this.content.roles.reload()
          this.content.bindings.reload()
          this.content.presets.reload()
          this.content.memories.clearCache()
          this.ui.clearCache()
          this.voice.clearCache()
        }
      },
    }), 'qqbot: reset stores')
    // 当前角色是会话中途会变的运行时状态，放 context 不放 section（CLAUDE.md 提示词规则）。
    // 写名称不写 id：id 是自动生成的内部键，对模型没有意义。改名也会让这一行变。
    // 换角色时这一行跟着变，DSH 会追加一条新的 context 快照，模型从中能看到换了人。
    this.store.runtime('role', session => this.content.roleFor(session)?.name ?? '', 'dsh-qqbot')
    this.store.runtime('voice', session => this.voice.promptStatus(this.content.roleFor(session)?.voice), 'dsh-qqbot')
  }

  extension(entry: QqbotExtensionEntry): () => void {
    return this.store.extension(entry, callerName(this.ctx))
  }

  runtime(name: string, text: QqbotText): () => void {
    return this.store.runtime(name, text, callerName(this.ctx))
  }

  role(session: QqbotSession): QqbotRoleInfo | undefined {
    const role = this.content.roleFor(session)
    if (role === undefined) return undefined
    return {
      id: role.id,
      name: role.name,
      ...role.proactivity === undefined ? {} : { proactivity: role.proactivity },
      ...role.proactivityTexts === undefined ? {} : { proactivityTexts: role.proactivityTexts },
      ...role.motionActions === undefined ? {} : { motionActions: role.motionActions },
      ...role.motionRanges === undefined ? {} : { motionRanges: role.motionRanges },
    }
  }
}

/** 调用方的插件名：优先用 loader 条目里的包名，取不到时用 cordis 插件名。 */
function callerName(ctx: Context): string | undefined {
  const fallback = ctx.fiber.name
  let fiber = ctx.fiber
  while (true) {
    const entryName = (fiber as { entry?: { options?: { name?: unknown } } }).entry?.options?.name
    if (typeof entryName === 'string' && entryName !== '') return entryName
    const parent = fiber.parent.fiber
    if (parent === fiber) break
    fiber = parent
  }
  return fallback === 'root' ? undefined : fallback
}

export const name = 'qqbot'

export function apply(ctx: Context): void {
  ctx.plugin(QqbotService)
  ctx.plugin(viewer)
  ctx.plugin(library)
  ctx.plugin(dynamicsApi)
  ctx.plugin(ui)
  ctx.plugin(voice)
  ctx.plugin(toy)
  ctx.plugin(autoReply)
  ctx.plugin(maintenance)
  ctx.plugin(phone)
  ctx.plugin(update)
  ctx.plugin(memeApi)
}
