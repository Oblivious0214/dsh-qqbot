/** QQbot 界面页的可选扩展；组件与设置仍由提供它的插件负责。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore, type ComponentType } from 'react'

export interface UiExtensionProps { readonly onBusy: (busy: boolean) => void }
export class UiExtensions {
  private entries: readonly ComponentType<UiExtensionProps>[] = []
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.entries
  register(component: ComponentType<UiExtensionProps>): () => void {
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
  register(component: ComponentType<UiExtensionProps>): () => void {
    const extensions = this.extensions
    return this.ctx.effect(() => extensions.register(component), 'qqbotUi: settings')
  }
}

export function UiExtensionFields({ extensions, onBusy }: UiExtensionProps & { readonly extensions: UiExtensions }) {
  const entries = useSyncExternalStore(extensions.subscribe, extensions.getSnapshot)
  return <>{entries.map((Component, index) => <Component key={index} onBusy={onBusy} />)}</>
}
