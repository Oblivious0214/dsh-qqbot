/** 宿主新会话按钮旁的独立 QQ 入口；不接管原按钮，也不写默认预设。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { PRESET_ID } from '../view-types.ts'

const BUTTON_CLASS = 'dsh-qqbot-new-session'
// rc.5 和开发参考源码均使用 CSS Module 的 <hash>_newSession 类名。
const NATIVE_BUTTON = 'button[class$="_newSession"]'

export function installNewQqSession(ctx: Context): void {
  ctx.effect(() => {
    let disposed = false
    let pending = false
    const buttons = new Map<HTMLButtonElement, HTMLButtonElement>()
    const style = document.createElement('style')
    style.dataset['qqbotStyle'] = 'new-session'
    style.textContent = `
.${BUTTON_CLASS} { gap: 6px; }
.${BUTTON_CLASS}:disabled { opacity: .6; cursor: wait; }
[data-sidebar-collapsed] .${BUTTON_CLASS} { display: none; }
`
    document.head.append(style)

    const launch = async () => {
      if (disposed || pending) return
      pending = true
      for (const button of buttons.values()) {
        button.disabled = true
        button.textContent = '新QQ会话'
        button.removeAttribute('title')
      }
      try {
        if (ctx.workspaces.list.getSnapshot().items.length > 0) {
          // 由原生导航继承当前／最近工作区，并只复用 qqbot 的空白会话。
          ctx.uiWorkspace.startSession(undefined, { agentPreset: PRESET_ID })
        } else {
          // 原生 startSession 在没有工作区时只清空页面，会丢失指定预设。
          const id = await ctx.sessions.create({ agentPreset: PRESET_ID })
          if (!disposed) ctx.uiWorkspace.openSession(id)
        }
      } catch {
        if (!disposed) for (const button of buttons.values()) {
          button.textContent = '创建失败，点击重试'
          button.title = '未能创建QQ会话'
        }
      } finally {
        pending = false
        if (!disposed) for (const [native, button] of buttons) button.disabled = native.disabled
      }
    }

    const sync = () => {
      for (const [native, button] of buttons) {
        if (!native.isConnected || !native.matches(NATIVE_BUTTON)) {
          button.remove()
          buttons.delete(native)
        }
      }
      for (const native of document.querySelectorAll<HTMLButtonElement>(NATIVE_BUTTON)) {
        let button = buttons.get(native)
        if (button === undefined) {
          button = document.createElement('button')
          button.type = 'button'
          button.className = `${native.className} ${BUTTON_CLASS}`
          button.textContent = '新QQ会话'
          button.setAttribute('aria-label', '新QQ会话')
          button.addEventListener('click', () => { void launch() })
          buttons.set(native, button)
        }
        if (native.nextElementSibling !== button) native.after(button)
        const disabled = pending || native.disabled
        if (button.disabled !== disabled) button.disabled = disabled
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] })
    sync()
    return () => {
      disposed = true
      observer.disconnect()
      for (const button of buttons.values()) button.remove()
      buttons.clear()
      style.remove()
    }
  }, 'qqbot: new session entry')
}
