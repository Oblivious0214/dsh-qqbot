import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { PRESET_ID } from '../view-types.ts'

interface LeftSidebarInjected {
  readonly current: HostObservable<{ readonly key: string | undefined }>
  readonly visited: Set<string>
  readonly toggleSidebar: () => void
}

type LeftSidebarProps = PropsRuntime<'shell.overlay'> & InjectFace<LeftSidebarInjected>

/** 仅处理新 QQ 对话的初始折叠，展开／收起沿用宿主原生入口。 */
export function LeftSidebar({ current, visited, toggleSidebar, useSessions, usePanelInfo }: LeftSidebarProps) {
  const id = useSyncExternalStore(current.subscribe, current.getSnapshot).key
  const summary = useSessions(state => id === undefined ? undefined : state.byId[id as keyof typeof state.byId])
  const visible = usePanelInfo(state => state.activePanelId === null) && summary?.projectionValues?.agentPreset === PRESET_ID
  const anchor = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    if (!visible || id === undefined || visited.has(id)) return
    const frame = anchor.current?.closest('[data-shell-overlay]')?.parentElement
    if (frame == null) return
    visited.add(id)
    if (summary?.blank && !frame.hasAttribute('data-sidebar-collapsed')) toggleSidebar()
  }, [visible, id, summary?.blank, visited, toggleSidebar])

  return visible ? <span ref={anchor} hidden /> : null
}

export function installLeftSidebar(ctx: Context): void {
  const visited = new Set<string>()
  const toggleSidebar = () => { ctx.layout.toggleSidebar() }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'qqbot-left-sidebar',
    inject: (): LeftSidebarInjected => ({ current: ctx.uiSession.adapter.current, visited, toggleSidebar }),
  }, LeftSidebar))
}
