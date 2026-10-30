/** QQbot 独占气泡定位；扩展只提供只读组件，不再包装宿主渲染器。 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SegmentPlayback, SegmentStage } from './reply-clock.ts'

export interface SegmentAnnotationProps {
  readonly session: string
  readonly reply: string
  readonly stages: readonly SegmentStage[]
  readonly index: number
  readonly playback: () => SegmentPlayback | undefined
}

export class SegmentAnnotations {
  private entries: readonly ComponentType<SegmentAnnotationProps>[] = []
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.entries
  register(component: ComponentType<SegmentAnnotationProps>): () => void {
    this.entries = [...this.entries, component]
    this.notify()
    return () => { this.entries = this.entries.filter(entry => entry !== component); this.notify() }
  }
  private notify() { for (const listener of this.listeners) listener() }
}

export function useSegmentAnnotations({ root, registry, visible, ...props }: Omit<SegmentAnnotationProps, 'index'> & {
  readonly root: RefObject<HTMLElement | null>
  readonly registry: SegmentAnnotations
  readonly visible: number
}) {
  const entries = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const inserted = useRef(new Map<number, HTMLElement>())
  const [hosts, setHosts] = useState<readonly HTMLElement[]>([])
  useLayoutEffect(() => {
    const nodes = [...root.current?.querySelectorAll<HTMLElement>(':scope > div > div > [class*="_markdown_"]') ?? []]
    const next: HTMLElement[] = []
    if (entries.length > 0 && nodes.length === visible) {
      nodes.forEach((node, index) => {
        let host = inserted.current.get(index)
        if (host === undefined) {
          // span 不匹配 QQ 气泡/头像的 div 选择器；独立于正文的复制源节点。
          host = document.createElement('span')
          host.setAttribute('data-qqbot-annotation', '')
          inserted.current.set(index, host)
        }
        if (node.nextElementSibling !== host) node.after(host)
        next.push(host)
      })
    }
    for (const [index, host] of inserted.current) {
      if (!next.includes(host)) { host.remove(); inserted.current.delete(index) }
    }
    setHosts(previous => previous.length === next.length && previous.every((host, i) => host === next[i]) ? previous : next)
  })
  useEffect(() => () => { for (const host of inserted.current.values()) host.remove(); inserted.current.clear() }, [])
  return hosts.map((host, index) => createPortal(<>{entries.map((Component, entry) => <Component key={entry} {...props} index={index} />)}</>, host, `${props.reply}:${index}`))
}
