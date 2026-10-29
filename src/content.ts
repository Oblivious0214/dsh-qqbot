/**
 * dsh-qqbot 自己的提示词内容：破限预设和角色正文。
 * 数据来自角色库、会话绑定和破限预设存储；`createDefaultContent()` 是不读写文件的内置默认，供测试和缺省使用。
 */

import { NO_ROLE, SessionBindings, type RoleChoice } from './bindings.ts'
import { DEFAULT_MEME_FREQUENCY, type MemeFrequency } from './library-types.ts'
import { DEFAULT_JAILBREAK, JailbreakStore, type JailbreakPreset } from './presets.ts'
import type { QqbotSession } from './registry.ts'
import { RoleLibrary, type Role } from './roles.ts'
import type { Warn } from './storage.ts'

export { DEFAULT_JAILBREAK, type JailbreakPreset } from './presets.ts'

export interface QqbotContent {
  jailbreakFor(session: QqbotSession): JailbreakPreset
  /** 当前会话绑定的角色正文；没有角色时返回空串。 */
  personaFor(session: QqbotSession): string
  /** 当前会话的角色 id；没有角色时为空。供 `qqbot:runtime` 和查看器使用。 */
  roleIdFor(session: QqbotSession): string | undefined
  /** 当前角色的表情频率；没有角色或角色卡没写时用默认档。 */
  memeFrequencyFor(session: QqbotSession): MemeFrequency
  /**
   * 真实组装前调用：没有记录的会话把当前默认角色写下来，之后改默认角色不会让进行中的会话换人。
   * 只读路径（提示词查看器）不调用它。
   */
  settle(session: QqbotSession): void
}

export function createDefaultContent(): QqbotContent {
  return {
    jailbreakFor: () => DEFAULT_JAILBREAK,
    personaFor: () => '',
    roleIdFor: () => undefined,
    memeFrequencyFor: () => DEFAULT_MEME_FREQUENCY,
    settle: () => {},
  }
}

/** 角色库、会话绑定、破限预设三者合起来的内容来源。 */
export class QqbotData implements QqbotContent {
  constructor(
    readonly roles: RoleLibrary,
    readonly bindings: SessionBindings,
    readonly presets: JailbreakStore,
    private readonly warn: Warn,
  ) {}

  /** 会话的选择：有记录用记录，没有记录时用新会话默认角色（不写盘）。 */
  choiceFor(session: QqbotSession): RoleChoice {
    // 不能用 ??：NO_ROLE 是 null，会被当成"没有记录"而让默认角色接管。
    const choice = this.bindings.get(session.id)
    return choice !== undefined ? choice : this.bindings.defaultRole ?? NO_ROLE
  }

  /** 会话当前在用的角色。绑定的角色已从角色库删掉时为空，会话按无角色运行，绑定保留。 */
  roleFor(session: QqbotSession): Role | undefined {
    const choice = this.choiceFor(session)
    return choice === NO_ROLE ? undefined : this.roles.get(choice)
  }

  jailbreakFor(session: QqbotSession): JailbreakPreset {
    return this.presets.forRole(this.roleFor(session)?.id)
  }

  personaFor(session: QqbotSession): string {
    return this.roleFor(session)?.persona ?? ''
  }

  roleIdFor(session: QqbotSession): string | undefined {
    return this.roleFor(session)?.id
  }

  memeFrequencyFor(session: QqbotSession): MemeFrequency {
    return this.roleFor(session)?.memeFrequency ?? DEFAULT_MEME_FREQUENCY
  }

  settle(session: QqbotSession): void {
    if (this.bindings.get(session.id) !== undefined) return
    try {
      this.bindings.set(session.id, this.choiceFor(session))
    } catch (error) {
      // 写不了盘时本轮照常组装（用的就是默认角色），下一轮再试。
      this.warn(`qqbot: 记不下会话 ${session.id} 的角色：${String(error)}`)
    }
  }
}
