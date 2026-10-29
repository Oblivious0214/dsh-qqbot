/**
 * 浏览器端的界面设置状态：从 UI_PATH 读设置、图片版本和各会话各轮的角色，供样式、分段显示和编辑器共用。
 * 只在页面内存里，刷新后重新读取。
 */

import { DEFAULT_UI_SETTINGS, UI_PATH, type UiAction, type UiRole, type UiSessionView, type UiSettings, type UiView } from '../ui-types.ts'

export type SessionRole = UiRole

export async function requestUi(action?: UiAction, session?: string, signal?: AbortSignal): Promise<UiView> {
  const url = `${UI_PATH.slice(1)}${session === undefined ? '' : `?session=${encodeURIComponent(session)}`}`
  const init: RequestInit = action === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined) as (UiView & { message?: string }) | undefined
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`)
  return body as UiView
}

export class UiState {
  private view: UiView = { settings: DEFAULT_UI_SETTINGS, avatars: {} }
  private readonly roles = new Map<string, UiSessionView>()
  private readonly loading = new Set<string>()
  private readonly again = new Set<string>()
  /** 每个会话见过的最新一轮。出现更新的一轮时重读角色：上一轮之后可能用 /role 换过人。 */
  private readonly turns = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private disposed = false

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version

  get settings(): UiSettings { return this.view.settings }
  get background(): number | undefined { return this.view.background }

  avatarVersion(role: string): number | undefined {
    return Object.hasOwn(this.view.avatars, role) ? this.view.avatars[role] : undefined
  }

  /**
   * 第 turn 轮回复用的角色；还没读到时为 undefined，并在后台读取。
   * 服务端只在换人时记一条，所以最后一条之后的轮次都用最后一条的角色；还没有记录时用当前角色。
   */
  roleAt(session: string, turn: number): SessionRole | undefined {
    const known = this.roles.get(session)
    if (known === undefined) {
      this.refreshRole(session)
      return undefined
    }
    if (known.turns.length === 0) return known.role
    let role = known.turns[0]!.role
    for (const item of known.turns) {
      if (item.turn > turn) break
      role = item.role
    }
    return role
  }

  /** 渲染到某一轮的回复时调用；比之前见过的都新时重读角色。 */
  noteTurn(session: string, turn: number): void {
    const seen = this.turns.get(session)
    this.turns.set(session, Math.max(seen ?? turn, turn))
    if (seen !== undefined && turn > seen) this.refreshRole(session)
  }

  /**
   * 重新读这个会话的角色（例如新一轮开始，`/role` 可能换过人）。同一会话同时只发一个请求；
   * 请求途中又要求重读时，等它回来再读一次，免得漏掉刚开始的一轮。
   */
  refreshRole(session: string): void {
    if (this.disposed) return
    if (this.loading.has(session)) {
      this.again.add(session)
      return
    }
    this.loading.add(session)
    requestUi(undefined, session).then((view) => {
      if (this.disposed) return
      this.roles.set(session, view.session ?? { role: null, turns: [] })
      this.adopt(view)
    }, () => { /* 读不到时先不显示头像，下一轮再试 */ }).finally(() => {
      this.loading.delete(session)
      if (this.again.delete(session)) this.refreshRole(session)
    })
  }

  /** 读设置和图片版本，不改各会话的角色。 */
  reload(): Promise<void> {
    return requestUi().then((view) => { if (!this.disposed) this.adopt(view) })
  }

  /** 编辑器提交操作后用返回值更新，不用再读一次。 */
  adopt(view: UiView): void {
    const { session: _, ...rest } = view
    this.view = rest
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** 角色改了名或删了：清掉各会话缓存的角色，下次渲染时重读。 */
  forgetRoles(): void {
    this.roles.clear()
    this.version++
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.roles.clear()
    this.turns.clear()
    this.again.clear()
  }
}
