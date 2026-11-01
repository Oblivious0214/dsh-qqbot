/**
 * 空白 qqbot 会话可选择角色；开始后输入栏显示当前角色，点击打开 QQ Bot 设置。
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutlineRegular, IconUserOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PRESET_ID } from '../view-types.ts'
import type { OpenEditor } from './library-editor.tsx'
import type { UiState } from './ui-state.ts'
import { ActionDialog } from './action-dialog.tsx'

/** 样式都在这个根 class 下（CLAUDE.md 隔离原则第 3 条）。 */
export const ROLE_CHIP_CLASS = 'dsh-qqbot-role'

export const ROLE_CHIP_CSS = `
/* 宿主 heroOptions 用 auto 外边距靠右；只在 qqbot 的角色菜单出现时让它紧跟 Agent 预设，并允许收缩。 */
[data-qqbot] div:has(> [data-slot="conversation.hero.options"] .${ROLE_CHIP_CLASS}[data-place="hero"]) { margin-left: 0; flex: 0 1 auto; }
.${ROLE_CHIP_CLASS} { display: inline-flex; min-width: 0; max-width: 100%; }
.${ROLE_CHIP_CLASS} .qr-trigger { appearance: none; display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 200px; min-height: 28px; padding: 0 8px;
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; white-space: nowrap; cursor: pointer; }
.${ROLE_CHIP_CLASS}[data-place="input"] .qr-trigger { min-height: 30px; color: var(--dsw-alias-label-secondary); font-weight: 400; }
.${ROLE_CHIP_CLASS} .qr-trigger[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .${ROLE_CHIP_CLASS} .qr-trigger:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); } }
.${ROLE_CHIP_CLASS} .qr-trigger:disabled { cursor: default; color: var(--dsw-alias-label-quaternary); }
.${ROLE_CHIP_CLASS} .qr-trigger > svg { flex: none; }
.${ROLE_CHIP_CLASS} .qr-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.${ROLE_CHIP_CLASS}-item { display: flex; flex-direction: column; min-width: 0; max-width: 280px; }
`

const NONE_ID = '\u0000none'
const MANAGE_ID = '\u0000manage'

export interface RoleChipInjected {
  readonly ui: UiState
  readonly openEditor: OpenEditor
}

type HeroProps = PropsRuntime<'conversation.hero.options'> & InjectFace<RoleChipInjected>
type InputProps = PropsRuntime<'conversation.input.left'> & InjectFace<RoleChipInjected>

/** 新会话页：只在空白的 qqbot 会话里出现。 */
export function HeroRoleChip(props: HeroProps) {
  const state = useSessionState(props)
  if (state !== 'blank') return null
  return <RoleChip sessionId={props.sessionId} ui={props.ui} openEditor={props.openEditor} />
}

/** 输入栏：qqbot 会话发过消息以后出现。 */
export function InputRoleChip(props: InputProps) {
  const state = useSessionState(props)
  if (state !== 'started') return null
  return <CurrentRoleSettings sessionId={props.sessionId} ui={props.ui} openEditor={props.openEditor} />
}

function CurrentRoleSettings({ sessionId, ui, openEditor }: { sessionId: string } & RoleChipInjected) {
  useSyncExternalStore(ui.subscribe, ui.getVersion)
  const current = ui.session(sessionId)?.role
  return <span className={ROLE_CHIP_CLASS} data-place="input">
    <button type="button" className="qr-trigger" aria-haspopup="dialog" title="QQ Bot 设置"
      onClick={() => openEditor({ tab: 'roles', ...current == null ? {} : { id: current.id } })}>
      <IconUserOutlineRegular size={16} />
      <span className="qr-label">{current?.name ?? 'QQ Bot'}</span>
    </button>
  </span>
}

/** 不是 qqbot 会话时为 undefined。 */
function useSessionState({ sessionId, useSessions }: HeroProps | InputProps): 'blank' | 'started' | undefined {
  return useSessions((state) => {
    const summary = state.byId[sessionId]
    const preset = summary?.projectionValues?.agentPreset
    if (summary === undefined || preset !== PRESET_ID) return undefined
    return summary.blank ? 'blank' : 'started'
  })
}

function RoleChip({ sessionId, ui, openEditor }: { readonly sessionId: string } & RoleChipInjected) {
  useSyncExternalStore(ui.subscribe, ui.getVersion)
  const view = ui.session(sessionId)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  // 角色可能在编辑器或另一个窗口里改过：每次打开菜单重读一次。
  useEffect(() => { if (open) ui.refreshRole(sessionId) }, [open, sessionId, ui])

  const current = view?.role ?? null
  const label = view === undefined ? '角色' : current === null ? '不用角色' : current.name
  const items: MenuEntry[] = [
    { id: NONE_ID, label: <span className={`${ROLE_CHIP_CLASS}-item`}><span>不用角色</span></span> },
    ...(view?.roster ?? []).map(role => ({
      id: role.id,
      label: <span className={`${ROLE_CHIP_CLASS}-item`}>
        <span>{role.name}</span>
      </span>,
    })),
    { type: 'separator', id: 'qr-separator' },
    { id: MANAGE_ID, label: '管理角色…' },
  ]

  const pick = (id: string) => {
    setOpen(false)
    if (id === MANAGE_ID) {
      openEditor({ tab: 'roles', ...current === null ? {} : { id: current.id } })
      return
    }
    const role = id === NONE_ID ? null : id
    if (role === (current?.id ?? null)) return
    setBusy(true)
    setError(undefined)
    ui.setRole(sessionId, role).then(
      () => { setBusy(false) },
      (reason: unknown) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)) },
    )
  }

  return <span className={ROLE_CHIP_CLASS} data-place="hero">
    <Menu open={open} onClose={() => { setOpen(false) }} items={items} selectedId={current?.id ?? NONE_ID}
      onSelect={pick} align="start" side="bottom" portal
      anchor={<button type="button" className="qr-trigger" aria-haspopup="menu" aria-expanded={open} title="这个会话用的角色"
        disabled={busy} onClick={() => { setOpen(value => !value) }}>
        <IconUserOutlineRegular size={16} />
        <span className="qr-label">{label}</span>
        <IconChevronDownOutlineRegular size={14} />
      </button>} />
    {error !== undefined && <ActionDialog title="角色没有切换" cancelLabel="知道了" onCancel={() => { setError(undefined) }}>
      {error}
    </ActionDialog>}
  </span>
}
