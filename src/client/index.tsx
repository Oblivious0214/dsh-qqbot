/**
 * dsh-qqbot 浏览器端：给 qqbot 会话根节点加 data-qqbot，QQ 样式（qq-style.ts）只写在它下面；
 * DSH 设置窗口里加"QQ Bot"入口（不提供"设为默认"），新会话沿用 DSH 原生预设选择，
 * 在 qqbot 会话添加「提示词」视图，新会话页选角色，输入栏显示角色与设置入口（role-chip.tsx），编辑器弹窗挂在 shell.overlay，qqbot 会话里按 [qq] 块分段显示回复，
 * 角色选了音色时显示成语音条。
 */

import { MaintenanceClient } from './maintenance.ts'
import * as toy from '../toy/client/index.tsx'
import * as autoReply from './auto-reply/index.tsx'
import { QuickReplyState } from './auto-reply/quick-state.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PRESET_ID } from '../view-types.ts'
import {
  EDITOR_CLASS, EDITOR_CSS, LibraryEditorHost, LibrarySettingsSection,
  type EditorTarget, type LibraryEditorInjected, type LibrarySettingsInjected,
} from './library-editor.tsx'
import { CROPPER_CLASS, CROPPER_CSS } from './image-cropper.tsx'
import { installPromptView, ROOT_CLASS, VIEWER_CSS } from './prompt-viewer.tsx'
import { buildQqCss, MARK_ATTRIBUTE } from './qq-style.ts'
import { HeroRoleChip, InputRoleChip, ROLE_CHIP_CLASS, ROLE_CHIP_CSS, type RoleChipInjected } from './role-chip.tsx'
import { installSegments } from './segments.tsx'
import { UiState } from './ui-state.ts'
import { VoicePlayer } from './voice-player.ts'
import { VoiceState } from './voice-state.ts'
import { createPhoneGuide } from './phone-guide.ts'
import { createMemeGuide } from './meme-guide.ts'
import { ACTION_DIALOG_CLASS, ACTION_DIALOG_CSS } from './action-dialog.tsx'
import { UiExtensions, UiExtensionsService } from './ui-extensions.tsx'
import { installLeftSidebar } from './left-sidebar.tsx'
import { installPhoneLayout, PHONE_LAYOUT_CSS } from './phone-layout.tsx'

export { MARK_ATTRIBUTE, PRESET_ID }

type SessionId = keyof SessionListState['byId']

// 教程启动器在 apply 中创建；通过真实服务依赖等待导航就绪，并跟随其生命周期重建。
export const inject = ['sessions', 'slots', 'uiSession', 'layout', 'uiWorkspace']

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
  const maintenance = new MaintenanceClient()
  const ui = new UiState()
  const extensions = new UiExtensions()
  ctx.plugin(UiExtensionsService, extensions)
  ctx.effect(() => () => { ui.dispose() }, 'qqbot: ui state')
  void ui.reload().catch(() => {})

  // 语音设置和播放器；读不到设置时所有回复显示文字。插件关闭时停下播放、释放音频。
  const voiceState = new VoiceState()
  const player = new VoicePlayer(() => voiceState.settings.volume)
  ctx.effect(() => () => { player.dispose(); voiceState.dispose() }, 'qqbot: voice')
  void voiceState.reload().catch(() => {})

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
  const quick = new QuickReplyState()
  ctx.effect(() => () => quick.dispose(), 'qqbot: quick reply state')
  installSegments(ctx, {
    subscribe: listener => ctx.sessions.list.subscribe(listener),
    isQqbot: sessionId => presetOf(sessionId) === PRESET_ID,
  }, ui, { state: voiceState, player }, quick)
  ctx.plugin(autoReply, { quick, maintenance })
  ctx.effect(() => maintenance.register(async all => {
    player.clearCache()
    ui.forgetRoles()
    if (all) { player.clearReadState(); voiceState.invalidate(); quick.clearCache() }
    await Promise.all([ui.reload(), voiceState.reload()])
  }), 'qqbot: browser cache cleanup')

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

  // 提示词查看器的"编辑"打开独立编辑器弹窗，挂在常驻的 shell.overlay。
  const editorTarget = createSnapshotStore<EditorTarget | null>(null, { flush: 'sync' })
  const openEditor = (target: EditorTarget) => { editorTarget.set(target) }
  ctx.plugin(toy, { openSettings: () => { openEditor({ tab: 'toy' }) },
    openRoleProactivity: (sessionId: string) => {
      const role = ui.session(sessionId)?.role
      openEditor({ tab: 'roles', focusProactivity: true, ...role == null ? {} : { id: role.id } })
    }, maintenance })
  ctx.effect(() => maintenance.start(), 'qqbot: cleanup synchronization')
  const closeEditor = () => { editorTarget.set(null) }
  voiceState.bindGuide(ctx, closeEditor)
  const phoneGuide = createPhoneGuide(ctx, closeEditor)
  ctx.effect(() => () => { phoneGuide?.dispose() }, 'qqbot: phone guide')
  const memeGuide = createMemeGuide(ctx, closeEditor)
  ctx.effect(() => () => { memeGuide?.dispose() }, 'qqbot: meme guide')
  ctx.effect(() => closeEditor, 'qqbot: close library editor')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'qqbot-library-editor',
    inject: (): LibraryEditorInjected => ({ hooks: { editorTarget }, closeEditor, ui, voice: voiceState, extensions, memeGuide, maintenance, phoneGuide }),
  }, LibraryEditorHost))

  // 选中设置侧栏的"QQ Bot"即关闭宿主设置并打开独立编辑器。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qqbot',
    order: 100,
    label: () => 'QQ Bot',
    inject: (): LibrarySettingsInjected => ({ openEditor }),
  }, LibrarySettingsSection))

  // 查看器、编辑器和裁剪弹窗的样式收在各自根 class 下；插件关闭时移除。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['qqbotStyle'] = `${ROOT_CLASS} ${EDITOR_CLASS} ${CROPPER_CLASS} ${ROLE_CHIP_CLASS} ${ACTION_DIALOG_CLASS}`
    style.textContent = VIEWER_CSS + EDITOR_CSS + CROPPER_CSS + ROLE_CHIP_CSS + ACTION_DIALOG_CSS + PHONE_LAYOUT_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'qqbot: viewer and editor style')

  installPromptView(ctx, openEditor)
  installLeftSidebar(ctx)
  installPhoneLayout(ctx)

  // 新会话页选角色；开始后输入栏显示当前角色，点击打开 QQ Bot 设置。仅 qqbot 会话渲染。
  const roleInjected = (): RoleChipInjected => ({ ui, openEditor })
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options',
    id: 'qqbot-role',
    inject: roleInjected,
  }, HeroRoleChip))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'qqbot-role',
    order: 10,
    inject: roleInjected,
  }, InputRoleChip))
}
