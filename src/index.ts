/**
 * dsh-qqbot host 层入口：提供 `ctx.qqbot` 登记服务和提示词查看器接口。
 * 本插件不注册任何提示词，不写 agent-preset-registry 的设置；
 * 提示词由 qqbot 预设内的 dsh-qqbot/prompt 组装。
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionBindings } from './bindings.ts'
import { QqbotData } from './content.ts'
import { importLegacy } from './legacy-import.ts'
import { JailbreakStore } from './presets.ts'
import { QqbotRegistryStore, type QqbotExtensionEntry, type QqbotRegistry, type QqbotText } from './registry.ts'
import { RoleLibrary } from './roles.ts'
import { dataDir, dshHome } from './storage.ts'
import * as viewer from './viewer.ts'

export type { QqbotExtensionEntry, QqbotRegistry, QqbotSession, QqbotText } from './registry.ts'

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
  readonly store = new QqbotRegistryStore()
  /** 角色库、会话绑定和破限预设，数据在 `<DSH_HOME>/qqbot/`。 */
  readonly content: QqbotData
  /**
   * 每个 agent 上一次真实组装出的系统提示词，供查看器对比"上一轮发出的"和"下一轮要发的"。
   * 以 agent 对象为键，agent 释放后自动回收；重启后为空。
   */
  readonly lastPrompt = new WeakMap<object, string>()

  constructor(ctx: Context) {
    super(ctx, 'qqbot')
    const warn = (message: string) => ctx.logger.warn(message)
    const home = dshHome()
    const dir = dataDir(home)
    try {
      const result = importLegacy(home, dir, warn)
      if (result !== undefined && result.imported.length > 0) {
        ctx.logger.info(`qqbot: 已从 ${join(home, 'roles')} 导入 ${result.imported.length} 个角色到 ${dir}，旧文件保留不动`)
      }
    } catch (error) {
      warn(`qqbot: 导入旧角色库失败，下次启动再试：${String(error)}`)
    }
    this.content = new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn)
    // 当前角色 id 是会话中途会变的运行时状态，放 context 不放 section（CLAUDE.md 提示词规则）。
    // 换角色时这一行跟着变，DSH 会追加一条新的 context 快照，模型从中能看到换了人。
    this.store.runtime('role', session => this.content.roleIdFor(session) ?? '', 'dsh-qqbot')
  }

  extension(entry: QqbotExtensionEntry): () => void {
    return this.store.extension(entry, callerName(this.ctx))
  }

  runtime(name: string, text: QqbotText): () => void {
    return this.store.runtime(name, text, callerName(this.ctx))
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
}
