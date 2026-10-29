/**
 * dsh-qqbot 浏览器端：给 qqbot 会话根节点加 data-qqbot（QQ 样式只写在它下面），
 * 并在侧边栏"更多"菜单里提供"新建 QQ 会话"入口。不提供"设为默认"。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconPlusOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

export const PRESET_ID = 'qqbot'
export const MARK_ATTRIBUTE = 'data-qqbot'

type SessionId = keyof SessionListState['byId']

export const inject = ['sessions', 'slots', 'uiWorkspace']

interface NewSessionInjected {
  readonly startQqSession: () => void
}

type NewSessionItemProps = PropsRuntime<'sidebar.panellist.actions'> & InjectFace<NewSessionInjected>

function NewSessionItem({ onDismiss, startQqSession }: NewSessionItemProps) {
  return <MenuItemButton icon={<IconPlusOutlineRegular size={16} />} onSelect={() => { onDismiss(); startQqSession() }}>
    新建 QQ 会话
  </MenuItemButton>
}

export function apply(ctx: Context): void {
  const presetOf = (sessionId: string | null): string | undefined => {
    if (sessionId === null) return undefined
    const value = ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  }
  const sync = () => {
    for (const node of document.querySelectorAll('[data-conversation-session]')) {
      const isQqbot = presetOf(node.getAttribute('data-conversation-session')) === PRESET_ID
      if (isQqbot !== node.hasAttribute(MARK_ATTRIBUTE)) node.toggleAttribute(MARK_ATTRIBUTE, isQqbot)
    }
  }

  ctx.effect(() => {
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-conversation-session'] })
    const stop = ctx.sessions.list.subscribe(sync)
    sync()
    return () => {
      stop()
      observer.disconnect()
      for (const node of document.querySelectorAll(`[${MARK_ATTRIBUTE}]`)) node.removeAttribute(MARK_ATTRIBUTE)
    }
  }, 'qqbot: mark qqbot sessions')

  // 显式指定 qqbot 预设创建会话；不改用户的默认预设。
  const injected = (): NewSessionInjected => ({
    startQqSession: () => { ctx.uiWorkspace.startSession(undefined, { clearPreviousDraft: false, agentPreset: PRESET_ID }) },
  })
  ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
    name: 'sidebar.panellist.actions',
    id: 'qqbot-new-session',
    inject: injected,
  }, NewSessionItem))
}
