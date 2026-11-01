/** 只在手机入口的 QQ 会话下适配侧栏覆盖层，右栏继续由宿主处理。 */
import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PHONE_LOGOUT } from '../phone-types.ts'
import { isPhonePage } from './phone-settings.tsx'

export const PHONE_LAYOUT_CSS = `
.qqbot-phone-sidebar-toggle { display: none; }
@media (max-width: 600px) {
  [data-qqbot-phone-frame] { height: var(--qqbot-phone-height, 100dvh); }
  [data-qqbot-phone-frame] { grid-template-columns: 0 minmax(0, 1fr) 0 !important; }
  [data-qqbot-phone-frame][data-sidebar-collapsed] > [class$='_sidebarCol'] { display: none; }
  [data-qqbot-phone-frame] .qqbot-phone-sidebar-toggle {
    display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
    margin-right: 8px; padding: 0; border: 0; border-radius: 8px; background: transparent;
    color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 20px;
  }
  [data-qqbot-phone-frame] [data-qqbot] { --dsh-composer-side-clearance: 8px; }
  [data-qqbot-phone-frame] [data-qqbot] [data-chat-flow] { padding-inline: 8px; max-width: 100%; }
  [data-qqbot-phone-frame] > [class$='_centerCol'] { grid-column: 2; grid-row: 1; }
  [data-qqbot-phone-frame] > [class$='_sidebarCol'] { grid-column: 1; grid-row: 1; z-index: 40; }
  [data-qqbot-phone-frame]:not([data-sidebar-collapsed]) > [class$='_sidebarCol'] {
    position: absolute; inset: 0 auto 0 0; width: min(280px, 85vw); box-shadow: 8px 0 30px #0003;
  }
  [data-qqbot-phone-frame] > [class$='_handle'] { display: none; }
  [data-qqbot-phone-frame] [data-qqbot] [data-composer-card] { padding-bottom: env(safe-area-inset-bottom); }
  [data-qqbot-phone-frame] [data-qqbot] input, [data-qqbot-phone-frame] [data-qqbot] textarea,
  [data-qqbot-phone-frame] [data-qqbot] [contenteditable='true'] { font-size: 16px; }
  [data-qqbot-phone-frame] [data-qqbot] [data-composer-card] [class$='_row'] {
    display: grid; grid-template-columns: repeat(4, auto) minmax(0, 1fr); gap: 8px 4px; align-items: center;
  }
  [data-qqbot-phone-frame] [data-qqbot] [data-composer-card] [class$='_tools'],
  [data-qqbot-phone-frame] [data-qqbot] [data-slot="conversation.input.left"] { display: contents; }
  [data-qqbot-phone-frame] [data-qqbot] [data-composer-card] button { white-space: nowrap; flex-shrink: 0; }
  [data-qqbot-phone-frame] [data-qqbot] .dsh-qqbot-role { min-width: 0; max-width: 90px; }
  [data-qqbot-phone-frame] [data-qqbot] .qqbot-phone-status {
    grid-row: 2; grid-column: 1 / 4; margin: 0; white-space: nowrap; gap: 4px;
  }
  [data-qqbot-phone-frame] [data-qqbot] [data-composer-card] [class$='_trailing'] {
    grid-row: 2; grid-column: 4 / -1; justify-self: end; gap: 8px;
  }
  [data-qqbot-phone-frame] [data-qqbot] .qqbot-phone-status button { min-height: 32px; padding: 4px; }

}
.qqbot-phone-status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.qqbot-phone-status button { border: 0; padding: 4px; background: none; color: inherit; font: inherit; cursor: pointer; }
`
export function PhoneStatus(props: PropsRuntime<'conversation.input.left'>) {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  if (preset !== 'qqbot' || !isPhonePage()) return null
  return <form className="qqbot-phone-status" method="post" action={PHONE_LOGOUT}><span>{online ? '手机连接' : '网络已断开'}</span><button type="submit">退出</button></form>
}
export function installPhoneLayout(ctx: Context): void {
  if (!isPhonePage()) return
  ctx.effect(() => {
    const marked = new Set<HTMLElement>()
    const buttons = new Map<HTMLElement, HTMLButtonElement>()
    const update = () => {
      const next = new Set<HTMLElement>()
      for (const qq of document.querySelectorAll('[data-qqbot]')) {
        let frame = qq.parentElement
        while (frame && !frame.querySelector(':scope > [data-shell-overlay]')) frame = frame.parentElement
        if (frame) { next.add(frame); frame.setAttribute('data-qqbot-phone-frame', ''); frame.style.setProperty('--qqbot-phone-height', `${window.visualViewport?.height ?? innerHeight}px`) }
      }
      for (const frame of next) {
        // 宿主标题栏与带 data-qqbot 的 ConversationContent 是同级区域。
        const leading = frame.querySelector<HTMLElement>(":scope > [class$='_centerCol'] [data-conversation-header-leading]")
        let button = buttons.get(frame)
        if (leading && !button) {
          button = document.createElement('button')
          button.type = 'button'; button.className = 'qqbot-phone-sidebar-toggle'
          button.textContent = '☰'; button.setAttribute('aria-label', '展开或收起侧栏')
          button.onclick = () => { ctx.layout.toggleSidebar() }
          buttons.set(frame, button)
        }
        if (leading && button && button.parentElement !== leading) leading.append(button)
      }
      for (const [frame, button] of buttons) if (!next.has(frame)) { button.remove(); buttons.delete(frame) }
      for (const frame of marked) if (!next.has(frame)) { frame.removeAttribute('data-qqbot-phone-frame'); frame.style.removeProperty('--qqbot-phone-height') }
      marked.clear(); for (const frame of next) marked.add(frame)
    }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-qqbot'] })
    const selectSession = (event: MouseEvent) => {
      if (innerWidth > 600 || !(event.target instanceof Element) || event.target.closest('button') || !event.target.closest('[data-row-key^="session:"]')) return
      for (const frame of marked) if (!frame.hasAttribute('data-sidebar-collapsed') && frame.contains(event.target)) { ctx.layout.toggleSidebar(); break }
    }
    document.addEventListener('click', selectSession)
    window.visualViewport?.addEventListener('resize', update); window.addEventListener('resize', update); update()
    return () => {
      for (const button of buttons.values()) button.remove()
      buttons.clear()
      observer.disconnect(); window.visualViewport?.removeEventListener('resize', update); window.removeEventListener('resize', update)
      document.removeEventListener('click', selectSession)
      for (const frame of marked) { frame.removeAttribute('data-qqbot-phone-frame'); frame.style.removeProperty('--qqbot-phone-height') }
    }
  }, 'qqbot: phone viewport')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'qqbot-phone-status', order: 90 }, PhoneStatus))
}
