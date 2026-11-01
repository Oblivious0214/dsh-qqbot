/**
 * 每个会话的联动状态，只在内存里。DSH 重启、插件重载后所有会话回到未接入，需要用户重新点"接入对话"。
 * 多个 qqbot 会话各自接入、各自断开（docs/architecture.md 第 5 节）。
 */

import type { SessionRole, ToySessionView, ToySettings } from './api-types.ts'
import { deviceRules, type DeviceStatus } from './core/rules.ts'
import type { Proactivity } from './core/safety.ts'

export type { SessionRole } from './api-types.ts'

interface SessionState {
  status: DeviceStatus
}

/** 同时接入的会话数上限，防止异常客户端塞满内存。 */
const MAX_SESSIONS = 200
const MAX_ID_LENGTH = 512

export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH
}

export class SessionStates {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly settings: () => ToySettings,
    private readonly role: (id: string) => SessionRole | undefined = () => undefined,
  ) {}

  attach(id: string, status: DeviceStatus): void {
    if (this.settings().enabled === false) throw new Error('联动已关闭')
    if (!this.settings().authorized) throw new Error('请先完成首次授权')
    const existing = this.sessions.get(id)
    if (existing !== undefined) {
      existing.status = status
      return
    }
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('接入的会话过多，请先断开其他会话')
    this.sessions.set(id, { status })
  }

  setStatus(id: string, status: DeviceStatus): void {
    const state = this.sessions.get(id)
    if (state === undefined) throw new Error('这个会话没有接入')
    state.status = status
  }

  detach(id: string): void {
    this.sessions.delete(id)
  }

  /** 设置保存后调用：撤回授权时全部退出。 */
  settingsChanged(): void {
    const settings = this.settings()
    if (!settings.authorized || settings.enabled === false) {
      this.sessions.clear()
      return
    }
  }

  clear(): void {
    this.sessions.clear()
  }

  status(id: string): DeviceStatus | undefined {
    return this.sessions.get(id)?.status
  }

  /** 每次现读角色卡的档位；没有设置时为低自主性。 */
  proactivity(id: string): Proactivity {
    return this.role(id)?.proactivity ?? 0
  }

  /** 登记给 qqbot 的规则。未接入的会话为空串，规则不出现在它的提示词里。角色偏好每次现读。 */
  rules(id: string): string {
    if (!this.sessions.has(id)) return ''
    const settings = this.settings()
    const role = this.role(id)
    return deviceRules({
      motion: settings.motion, behavior: settings.behavior, proactivity: this.proactivity(id),
      proactivityTexts: { ...settings.proactivityTexts, ...role?.proactivityTexts },
      ...role === undefined ? {} : { role },
    })
  }

  view(id: string): ToySessionView {
    const status = this.status(id)
    const role = this.role(id)
    return {
      attached: status !== undefined,
      ...status === undefined ? {} : { status },
      proactivity: this.proactivity(id),
      ...role === undefined ? {} : { role },
      rules: this.rules(id),
    }
  }
}
