/**
 * dsh-qqbot 浏览器端：给 qqbot 会话根节点加 data-qqbot（QQ 样式只写在它下面），
 * 在侧边栏"更多"菜单里提供"新建 QQ 会话"和"QQ 角色与破限预设"入口（不提供"设为默认"），
 * 在 qqbot 会话标题栏放提示词查看器，编辑器弹窗挂在 shell.overlay，qqbot 会话里按 [qq] 块分段显示回复。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconPersonalizationOutlineRegular, IconPlusOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { PRESET_ID } from '../view-types.ts'
import { EDITOR_CLASS, EDITOR_CSS, LibraryEditorHost, type EditorTarget, type LibraryEditorInjected } from './library-editor.tsx'
import { PromptViewerButton, ROOT_CLASS, VIEWER_CSS, type PromptViewerInjected } from './prompt-viewer.tsx'
import { installSegments } from './segments.tsx'

export { PRESET_ID }
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

interface LibraryItemInjected {
  readonly openLibrary: () => void
}

type LibraryItemProps = PropsRuntime<'sidebar.panellist.actions'> & InjectFace<LibraryItemInjected>

function LibraryItem({ onDismiss, openLibrary }: LibraryItemProps) {
  return <MenuItemButton icon={<IconPersonalizationOutlineRegular size={16} />} onSelect={() => { onDismiss(); openLibrary() }}>
    QQ 角色与破限预设
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

  // [qq] 分段只在 qqbot 会话里显示，标准会话交给 DSH 自带的渲染器。
  installSegments(ctx, {
    subscribe: listener => ctx.sessions.list.subscribe(listener),
    isQqbot: sessionId => presetOf(sessionId) === PRESET_ID,
  })

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

  // 编辑器弹窗由菜单项和查看器打开；菜单和查看器关闭后它还要留着，所以挂在常驻的 shell.overlay。
  const editorTarget = createSnapshotStore<EditorTarget | null>(null, { flush: 'sync' })
  const openEditor = (target: EditorTarget) => { editorTarget.set(target) }
  const closeEditor = () => { editorTarget.set(null) }
  ctx.effect(() => closeEditor, 'qqbot: close library editor')
  ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
    name: 'sidebar.panellist.actions',
    id: 'qqbot-library',
    inject: (): LibraryItemInjected => ({ openLibrary: () => { openEditor({ tab: 'roles' }) } }),
  }, LibraryItem))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'qqbot-library-editor',
    inject: (): LibraryEditorInjected => ({ hooks: { editorTarget }, closeEditor }),
  }, LibraryEditorHost))

  // 查看器和编辑器的样式分别在 ROOT_CLASS、EDITOR_CLASS 下；插件关闭时移除。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['qqbot'] = `${ROOT_CLASS} ${EDITOR_CLASS}`
    style.textContent = VIEWER_CSS + EDITOR_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'qqbot: viewer and editor style')

  // 组件自己判断预设，标准会话里渲染 null。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'qqbot-prompt-viewer',
    inject: (): PromptViewerInjected => ({ openEditor }),
  }, PromptViewerButton))
}
