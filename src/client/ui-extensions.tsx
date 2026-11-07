/** QQbot 界面页的可选扩展；组件与设置仍由提供它的插件负责。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore, type ComponentType } from 'react'

export interface UiExtensionProps { readonly preview?: boolean; readonly onBusy: (busy: boolean) => void; readonly onDirty?: (dirty: boolean) => void; readonly onOpenRoleProactivity?: () => void }
export type UiSettingsPage = 'ui' | 'toy' | 'reply' | 'pacing' | 'promotion'
declare module '@deepseek-ai/cordis' {
  interface Context { qqbotUi: UiExtensionsService }
}
export class UiExtensions {
  private entries: readonly ComponentType<UiExtensionProps>[] = []
  private toyEntries: readonly ComponentType<UiExtensionProps>[] = []
  private replyEntries: readonly ComponentType<UiExtensionProps>[] = []
  private pacingEntries: readonly ComponentType<UiExtensionProps>[] = []
  private promotionEntries: readonly ComponentType<UiExtensionProps>[] = []
  getPromotionSnapshot = () => this.promotionEntries
  getPacingSnapshot = () => this.pacingEntries
  getReplySnapshot = () => this.replyEntries
  getToySnapshot = () => this.toyEntries
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.entries
  register(component: ComponentType<UiExtensionProps>, page: UiSettingsPage = 'ui'): () => void {
    if (page === 'promotion') {
      this.promotionEntries = [...this.promotionEntries, component]; this.notify()
      return () => { this.promotionEntries = this.promotionEntries.filter(entry => entry !== component); this.notify() }
    }
    if (page === 'pacing') {
      this.pacingEntries = [...this.pacingEntries, component]; this.notify()
      return () => { this.pacingEntries = this.pacingEntries.filter(entry => entry !== component); this.notify() }
    }
    if (page === 'reply') {
      this.replyEntries = [...this.replyEntries, component]; this.notify()
      return () => { this.replyEntries = this.replyEntries.filter(entry => entry !== component); this.notify() }
    }
    if (page === 'toy') {
      this.toyEntries = [...this.toyEntries, component]; this.notify()
      return () => { this.toyEntries = this.toyEntries.filter(entry => entry !== component); this.notify() }
    }
    this.entries = [...this.entries, component]
    this.notify()
    return () => { this.entries = this.entries.filter(entry => entry !== component); this.notify() }
  }
  private notify() { for (const listener of this.listeners) listener() }
}

export class UiExtensionsService extends Service {
  private readonly extensions: UiExtensions
  constructor(ctx: Context, extensions: UiExtensions) {
    super(ctx, 'qqbotUi')
    this.extensions = extensions
  }
  register(component: ComponentType<UiExtensionProps>, page: UiSettingsPage = 'ui'): () => void {
    const extensions = this.extensions
    return this.ctx.effect(() => extensions.register(component, page), 'qqbotUi: settings')
  }
}

export function UiExtensionFields({ extensions, onBusy, onDirty, onOpenRoleProactivity, page = 'ui', preview }: UiExtensionProps & { readonly extensions: UiExtensions; readonly page?: UiSettingsPage }) {
  const entries = useSyncExternalStore(extensions.subscribe, page === 'promotion' ? extensions.getPromotionSnapshot : page === 'toy' ? extensions.getToySnapshot : page === 'reply' ? extensions.getReplySnapshot : page === 'pacing' ? extensions.getPacingSnapshot : extensions.getSnapshot)
  if (page === 'toy' && entries.length === 0) return <p className="ql-note" role="status">联动模块尚未就绪，请重新打开设置。</p>
  return <>{entries.map((Component, index) => <Component key={index} onBusy={onBusy} {...preview === undefined ? {} : { preview }} {...onDirty === undefined ? {} : { onDirty }} {...onOpenRoleProactivity === undefined ? {} : { onOpenRoleProactivity }} />)}</>
}
