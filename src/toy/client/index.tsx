/**
 * dsh-toy-buttplug 浏览器端：qqbot 会话右侧联动面板、输入栏暂停按钮和设置页，设备连接，按 dsh-qqbot 的分段显示驱动设备。
 *
 * 隔离：按钮只在 qqbot 会话里渲染，标准会话里什么也不显示；样式收在 ROOT_CLASS 下，插件关闭时移除。
 * 没装或停用 dsh-qqbot 的浏览器端时，段落动作不会执行（面板里会说明）。
 * 插件停用、页面关闭时设备停止并断开，会话退出联动。
 */

import type { MaintenanceClient } from '../../client/maintenance.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BluetoothConnection } from './bluetooth.ts'
import type { Transport } from './transport.ts'
import { DEFAULT_ADDRESS, ButtplugConnection } from './buttplug.ts'
import { fetchApi } from './api.ts'
import { ToyController, type QqbotSegments, type TransportKind } from './controller.ts'
import { ROOT_CLASS, TOY_CSS, ToyButton, type ConnectionPrefs, type ToyInjected } from './panel.tsx'
import { installStageBadges, STAGE_CSS } from './stage-badge.tsx'
import { ToyDebugSettings, ToyDisplayPreview } from './debug-settings.tsx'
import { ToySettingsPage } from './settings-page.tsx'
import type { UiExtensionsService } from '../../client/ui-extensions.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { installToySidebar, SIDEBAR_CSS } from './sidebar.tsx'
import { PRESET_LIBRARY_CSS } from './preset-library.tsx'
import { WorkerClock } from './worker-clock.ts'
import { PacingSettings } from './pacing-settings.tsx'

export const inject = ['slots', 'uiSession', 'sessions']

const PREFS_KEY = 'dsh-toy-buttplug:connection'

function readPrefs(): ConnectionPrefs {
  // 连接方式只属于当前浏览器，不随电脑或其他手机同步。
  const fallback: ConnectionPrefs = { kind: 'buttplug', address: DEFAULT_ADDRESS }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<ConnectionPrefs> | null
    return {
      kind: saved?.kind === 'bluetooth' ? 'bluetooth' : 'buttplug',
      address: typeof saved?.address === 'string' ? saved.address : fallback.address,
    }
  } catch {
    return fallback
  }
}

function writePrefs(prefs: ConnectionPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* 存不了时只在本页有效 */ }
}

export function apply(ctx: Context, options: { openSettings: () => void; openRoleProactivity?: (sessionId: string) => void; maintenance?: MaintenanceClient }): void {
  const transports = new Map<TransportKind, Transport>()
  const clock = new WorkerClock(() => { controller.pagehide('设备计时异常，已停止并断开，请重新连接。') })
  const controller = new ToyController({
    api: fetchApi,
    clock,
    kind: readPrefs().kind,
    transport: (kind) => {
      let transport = transports.get(kind)
      if (transport === undefined) {
        transport = kind === 'bluetooth' ? new BluetoothConnection() : new ButtplugConnection()
        transports.set(kind, transport)
      }
      return transport
    },
  })
  ctx.effect(() => () => {
    controller.dispose()
    for (const transport of transports.values()) transport.disconnect()
    clock.dispose()
  }, 'toy-buttplug: controller')
  ctx.effect(() => options.maintenance?.register(all => { if (all) controller.resetForCleanup(); else controller.clearCache() }) ?? (() => {}), 'qqbot: reset toy client')
  void controller.load()
  void controller.watch()

  // 可选登记到 QQbot 的界面页；组件和设置均由本插件拥有，停用时自动撤销。
  ctx.inject(['qqbotUi'], inner => {
    const ui = (inner as unknown as { qqbotUi: UiExtensionsService }).qqbotUi
    ui.register(props => <ToySettingsPage {...props} controller={controller} />, 'toy')
    ui.register(props => <PacingSettings {...props} controller={controller} />, 'pacing')
    ui.register(props => props.preview ? <ToyDisplayPreview controller={controller} /> : <ToyDebugSettings {...props} controller={controller} />)
  })

  // dsh-qqbot 的分段显示时钟。它停用时登记和暂停由 cordis 撤销，设备停下。
  ctx.inject(['qqbotSegments'], (inner) => {
    const segments = (inner as unknown as { qqbotSegments: QqbotSegments }).qqbotSegments
    inner.effect(() => {
      let remove: (() => void) | undefined
      const refresh = () => {
        if (controller.getSnapshot().enabled && remove === undefined) {
          // 先占位，connectSegments 会同步通知快照监听者。
          remove = () => {}
          remove = controller.connectSegments(segments)
        } else if (!controller.getSnapshot().enabled && remove !== undefined) {
          const dispose = remove; remove = undefined; dispose()
        }
      }
      const unsubscribe = controller.subscribe(refresh)
      refresh()
      return () => { unsubscribe(); remove?.() }
    }, 'toy-buttplug: qqbot segments')
    inner.effect(() => installStageBadges(segments, controller), 'toy-buttplug: stage badges')
  })

  ctx.effect(() => {
    const pagehide = () => { controller.pagehide() }
    // 捕获阶段：先于输入框和其他快捷键处理。录入快捷键的输入框自己处理按键。
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-toy-hotkey]')) return
      if (!controller.hotkey(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    const hidden = () => { if (document.hidden && controller.getSnapshot().kind === 'bluetooth') controller.pagehide('手机页面已进入后台，设备已停止并断开。') }
    const offline = () => { controller.pagehide('网络已断开，设备已停止并断开。') }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('offline', offline)
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('offline', offline)
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('keydown', keydown, true)
    }
  }, 'toy-buttplug: page events')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['toyButtplugStyle'] = ROOT_CLASS
    style.textContent = TOY_CSS + STAGE_CSS + SIDEBAR_CSS + PRESET_LIBRARY_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'toy-buttplug: style')

  const injected = (): ToyInjected => ({ controller, connection: { get: readPrefs, set: writePrefs } })
  installToySidebar(ctx, { ...injected(), openSettings: options.openSettings,
    ...options.openRoleProactivity ? { openRoleProactivity: options.openRoleProactivity } : {} })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'toy-buttplug', order: 15, inject: injected,
  }, ToyButton))
}
