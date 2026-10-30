/**
 * dsh-qqbot 浏览器端：给 qqbot 会话根节点加 data-qqbot，QQ 样式（qq-style.ts）只写在它下面；
 * 侧边栏底部（左下角"更多"上面）放"新建 QQ 会话"按钮，DSH 设置窗口里加"QQ Bot"页（不提供"设为默认"），
 * 在 qqbot 会话标题栏放提示词查看器，编辑器弹窗挂在 shell.overlay，qqbot 会话里按 [qq] 块分段显示回复。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconNewChatOutlineMedium, IconNewChatOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { PRESET_ID } from '../view-types.ts'
import {
  EDITOR_CLASS, EDITOR_CSS, LibraryEditorHost, LibrarySettingsSection,
  type EditorTarget, type LibraryEditorInjected, type LibrarySettingsInjected,
} from './library-editor.tsx'
import { CROPPER_CLASS, CROPPER_CSS } from './image-cropper.tsx'
import { PromptViewerButton, ROOT_CLASS, VIEWER_CSS, type PromptViewerInjected } from './prompt-viewer.tsx'
import { buildQqCss, MARK_ATTRIBUTE } from './qq-style.ts'
import { installSegments } from './segments.tsx'
import { UiState } from './ui-state.ts'

export { MARK_ATTRIBUTE, PRESET_ID }

type SessionId = keyof SessionListState['byId']

export const inject = ['sessions', 'slots', 'uiWorkspace']

interface NewSessionInjected {
  readonly startQqSession: () => void
}

type NewSessionButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<NewSessionInjected>

/** 侧边栏底部的按钮，样式照 DSH 左下角"更多"那一行；收起侧边栏时只留图标。 */
function NewSessionButton({ wide, startQqSession }: NewSessionButtonProps) {
  return <Tooltip label="新建 QQ 会话" side="right" disabled={wide}>
    <button type="button" className={FOOTER_CLASS} data-collapsed={!wide} aria-label="新建 QQ 会话" onClick={startQqSession}>
      {wide ? <IconNewChatOutlineMedium size={14} /> : <IconNewChatOutlineRegular size={18} />}
      {wide && <span>新建 QQ 会话</span>}
    </button>
  </Tooltip>
}

const FOOTER_CLASS = 'dsh-qqbot-footer'

const FOOTER_CSS = `
.${FOOTER_CLASS} { user-select: none; display: flex; align-items: center; width: 100%; height: 32px; gap: 8px; padding: 6px 2px 6px 6px;
  border: 0; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 20px; cursor: pointer; }
.${FOOTER_CLASS}[data-collapsed="true"] { box-sizing: border-box; width: 36px; height: 36px; justify-content: center; gap: 0; padding: 0; }
.${FOOTER_CLASS} > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) { .${FOOTER_CLASS}:hover { background: var(--dsw-alias-interactive-bg-hover); } }
`

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

  // 界面设置、头像版本和各会话的角色；读不到时用默认设置。
  const ui = new UiState()
  ctx.effect(() => () => { ui.dispose() }, 'qqbot: ui state')
  void ui.reload().catch(() => {})

  // QQ 样式：规则都在 [data-qqbot] 下，设置变了整份重写。插件关闭时移除。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['qqbotStyle'] = MARK_ATTRIBUTE
    let css = ''
    const render = () => {
      const next = buildQqCss(ui.settings, ui.background)
      if (next !== css) style.textContent = css = next
    }
    render()
    document.head.append(style)
    const stop = ui.subscribe(render)
    return () => { stop(); style.remove() }
  }, 'qqbot: qq style')

  // [qq] 分段只在 qqbot 会话里显示，标准会话交给 DSH 自带的渲染器。
  installSegments(ctx, {
    subscribe: listener => ctx.sessions.list.subscribe(listener),
    isQqbot: sessionId => presetOf(sessionId) === PRESET_ID,
  }, ui)

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
  const startQqSession = () => { ctx.uiWorkspace.startSession(undefined, { clearPreviousDraft: false, agentPreset: PRESET_ID }) }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'qqbot-new-session',
    inject: (): NewSessionInjected => ({ startQqSession }),
  }, NewSessionButton))

  // 设置窗口（左下角"更多"→ 设置）里的"QQ Bot"页，排在 DSH 自带的页后面。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qqbot',
    order: 100,
    label: () => 'QQ Bot',
    inject: (): LibrarySettingsInjected => ({ ui, startQqSession }),
  }, LibrarySettingsSection))

  // 提示词查看器的"编辑"打开编辑器弹窗；查看器关闭后它还要留着，所以挂在常驻的 shell.overlay。
  const editorTarget = createSnapshotStore<EditorTarget | null>(null, { flush: 'sync' })
  const openEditor = (target: EditorTarget) => { editorTarget.set(target) }
  const closeEditor = () => { editorTarget.set(null) }
  ctx.effect(() => closeEditor, 'qqbot: close library editor')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'qqbot-library-editor',
    inject: (): LibraryEditorInjected => ({ hooks: { editorTarget }, closeEditor, ui }),
  }, LibraryEditorHost))

  // 查看器、编辑器、裁剪弹窗和底部按钮的样式分别在 ROOT_CLASS、EDITOR_CLASS、CROPPER_CLASS、FOOTER_CLASS 下；插件关闭时移除。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['qqbotStyle'] = `${ROOT_CLASS} ${EDITOR_CLASS} ${CROPPER_CLASS} ${FOOTER_CLASS}`
    style.textContent = VIEWER_CSS + EDITOR_CSS + CROPPER_CSS + FOOTER_CSS
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
