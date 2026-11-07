import { SETTINGS_CSS } from './settings-style.ts'
import { UpdateButton, UpdateSettings } from './update-settings.tsx'
/**
 * 角色、破限预设、界面和语音设置编辑器。统一在 `shell.overlay` 的独立弹窗里编辑；
 * 选中 DSH 设置侧栏的"QQ Bot"即跳转，角色菜单和提示词查看器可直接定位到对应条目。
 * 角色和预设来自 host 的 LIBRARY_PATH，保存后下一条消息起生效；界面设置和头像见 ui-editor.tsx，语音见 voice-editor.tsx。
 */


import { writeHeaders } from './cleanup-epoch.ts'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  LIBRARY_PATH, MEME_PROMPT_LIMIT,
  MOTION_RANGE_LABELS, MOTION_RANGES,
  type LibraryAction, type LibraryPreset, type LibraryPresetDraft, type LibraryRole, type LibraryRoleDraft, type LibraryView,
} from '../library-types.ts'
import { RoleAvatarField, UiForm } from './ui-editor.tsx'
import type { UiState } from './ui-state.ts'
import { RoleVoiceField, VoicePage } from './voice-editor.tsx'
import { VOICE_EDITOR_CSS } from './voice-style.ts'
import type { VoiceState } from './voice-state.ts'
import { RoleTextEditor } from './role-text-editor.tsx'
import { MemeFields, MemeFrequencyField } from './meme-fields.tsx'
import { MemeHelp } from './meme-help.tsx'
import type { PhoneGuide } from './phone-guide.ts'
import type { MemeGuide } from './meme-guide.ts'
import { ActionDialog } from './action-dialog.tsx'
import { RoleProactivitySelect, RoleToyPrompts, useToyActionNames } from './role-toy-prompts.tsx'
import { UiExtensionFields, type UiExtensions } from './ui-extensions.tsx'
import { DataSettings } from './data-settings.tsx'
import type { MaintenanceClient } from './maintenance.ts'
import { ConfigImport } from './config-import.tsx'
import { PhoneSettings, PHONE_SETTINGS_CSS } from './phone-settings.tsx'
import { MEMORY_LIMIT, MEMORY_SECTIONS } from '../memory-format.ts'
import { DynamicsEditor, DYNAMICS_CSS, dynamicsDraft, dynamicsPatch, type DynamicsContext } from './dynamics-editor.tsx'

/** 所有样式都在这个根 class 下（CLAUDE.md 隔离原则第 3 条）。 */
export const EDITOR_CLASS = 'dsh-qqbot-library'

export const EDITOR_CSS = `
${DYNAMICS_CSS}
${VOICE_EDITOR_CSS}
${PHONE_SETTINGS_CSS}
[role="dialog"].${EDITOR_CLASS} { width: min(960px, 100%); height: calc(64vh + 160px); max-height: 100%; font-size: 14px; line-height: 22px; }
.${EDITOR_CLASS} .ql-modal-content, .${EDITOR_CLASS} .ql-modal-content > :last-child { flex: 1; min-height: 0; }
.${EDITOR_CLASS} .ql-modal-content > :first-child { flex-shrink: 0; }
.${EDITOR_CLASS} .ql-heading { display:flex; align-items:center; gap:10px; padding-right:42px; flex:none; }
.${EDITOR_CLASS} .ql-heading h2 { margin:0; font-size:18px; }
.${EDITOR_CLASS} .ql-close { position:absolute; right:20px; top:20px; }
.${EDITOR_CLASS} .ql-dialog-layout { display:flex; flex-direction:column; flex:1; min-height:0; padding:24px; gap:14px; }
.${EDITOR_CLASS} .ql-update-dot { width:7px; height:7px; border-radius:50%; background:#e5484d; display:inline-block; margin-right:5px; }
.${EDITOR_CLASS} .ql-body { flex: 1; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.${EDITOR_CLASS} .ql-page { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.${EDITOR_CLASS} .ql-page > .ql-main, .${EDITOR_CLASS} .ql-page > .qv-page { flex: 1; height: 100%; min-height: 0; min-width: 0; }
.${EDITOR_CLASS} .ql-tabs { display: flex; gap: 6px; }
/* 与 DSH 设置页一致：正文和控件 14/22，辅助文字 13/20；仅作用于本编辑器。 */
.${EDITOR_CLASS} .ql-body button { font-size: 14px; line-height: 22px; min-height: 36px; }
.${EDITOR_CLASS} .ql-data-section { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 12px 0; }
.${EDITOR_CLASS} .ql-import-button { margin-left: auto; }
.${EDITOR_CLASS} .ql-main { display: flex; gap: 12px; height: 64vh; min-height: 320px; }
.${EDITOR_CLASS} .ql-list { flex: 0 0 200px; display: flex; flex-direction: column; gap: 2px; overflow: auto; border-right: 0.5px solid var(--dsw-alias-border-l2); padding-right: 8px; }
.${EDITOR_CLASS} .ql-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-sm); background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.${EDITOR_CLASS} .ql-row:hover { background: var(--dsw-alias-bg-layer-1); }
.${EDITOR_CLASS} .ql-row[aria-current="true"] { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.${EDITOR_CLASS} .ql-row .ql-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${EDITOR_CLASS} .ql-form { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; border: 0; margin: 0; padding: 0 4px 0 0; }
.${EDITOR_CLASS} .ql-form.ql-editor { overflow: hidden; min-height: 0; padding: 0; gap: 0; }
.${EDITOR_CLASS} .ql-fields { overflow: auto; min-height: 0; flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 0 4px 12px 0; }
.${EDITOR_CLASS} .ql-fields > * { flex-shrink: 0; }
.${EDITOR_CLASS} .ql-savebar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding: 10px 0 0; }
.${EDITOR_CLASS} .ql-save-status { flex: 1; min-width: 80px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${EDITOR_CLASS}.ql-prompt-dialog .ql-fields > .ql-field:has(> textarea) { flex: 1; min-height: 180px; }
.${EDITOR_CLASS}.ql-prompt-dialog .ql-fields > .ql-field > textarea { flex: 1; min-height: 120px; resize: none; }
.${EDITOR_CLASS} .ql-body, .${EDITOR_CLASS} .ql-main { min-height: 0; }
.${EDITOR_CLASS} .ql-tabs { flex-wrap: wrap; flex-shrink: 0; }
.${EDITOR_CLASS} .ql-field > input[type="number"] { width: 120px; max-width: 100%; }
.${EDITOR_CLASS} .ql-field > input:not([type="number"]):not([type="range"]):not([type="checkbox"]):not([type="radio"]) { width: 100%; max-width: 360px; min-width: 0; box-sizing: border-box; }
.${EDITOR_CLASS} .ql-field > select { align-self: flex-start; max-width: 100%; width: auto; }
.${EDITOR_CLASS} .ql-example-fold { flex: none; margin-top: 8px; }
.${EDITOR_CLASS} .ql-example-fold > summary { cursor: pointer; font-size: 14px; margin-bottom: 8px; }
.${EDITOR_CLASS} .ql-example { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden; font-size: 14px; }
.${EDITOR_CLASS} .ql-example [data-chat-flow] { display: flex; flex-direction: column; gap: 18px; box-sizing: border-box; }
.${EDITOR_CLASS} .ql-example-user-row { display: flex; justify-content: flex-end; }
.${EDITOR_CLASS} .ql-example-user { padding: 9px 14px; background: var(--dsw-specific-bubble); max-width: 85%; overflow-wrap: anywhere; }
.${EDITOR_CLASS} .ql-group { flex: none; border-top: 1px solid var(--dsw-alias-border-l2); }
.${EDITOR_CLASS} .ql-group > summary { display: flex; align-items: center; gap: 8px; list-style: none; padding: 12px 0; cursor: pointer; font-size: 14px; color: var(--dsw-alias-label-primary); }
.${EDITOR_CLASS} .ql-group > summary::-webkit-details-marker { display: none; }
.${EDITOR_CLASS} .ql-group > summary > strong { flex: none; }
.${EDITOR_CLASS} .ql-group > summary::before { content: '›'; font-size: 18px; line-height: 1; transition: transform .12s; }
.${EDITOR_CLASS} .ql-group[open] > summary::before { transform: rotate(90deg); }
.${EDITOR_CLASS} .ql-group-body { display: flex; flex-direction: column; gap: 12px; padding: 0 0 6px; }
.${EDITOR_CLASS} .qm-choices { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-wrap: wrap; gap: 8px 16px; }
.${EDITOR_CLASS} .qm-choices > legend { padding: 0 0 6px; font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.${EDITOR_CLASS} .qm-choices .ql-toggle { max-width: 100%; overflow-wrap: anywhere; }
.${EDITOR_CLASS} .qm-choices input { flex: none; }
.${EDITOR_CLASS} .ql-field { display: flex; flex-direction: column; gap: 4px; }
.${EDITOR_CLASS} .ql-identity { flex: none; width: min(280px, 100%); }
.${EDITOR_CLASS} .ql-identity > .ql-field { min-width: 0; }
.${EDITOR_CLASS} .ql-identity input { min-width: 0; width: 100%; box-sizing: border-box; }
.${EDITOR_CLASS} .ql-field.ql-inline { flex-direction: row; align-items: center; justify-content: flex-start; gap: 12px; min-width: 0; }
.${EDITOR_CLASS} .ql-inline > span { flex: none; }
.${EDITOR_CLASS} .ql-inline > select { min-width: 0; max-width: 65%; }
.${EDITOR_CLASS} .ql-inline > .ql-actions { min-width: 0; justify-content: flex-start; }
.${EDITOR_CLASS} .ql-inline > .ql-actions > select { min-width: 0; max-width: 100%; }
.${EDITOR_CLASS} .ql-proactivity { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.${EDITOR_CLASS} .ql-proactivity-select { flex: 0 1 560px; min-width: 0; }
.${EDITOR_CLASS} .ql-proactivity-select > button { width: 100%; justify-content: space-between; text-align: left; white-space: normal; height: auto; }
.${EDITOR_CLASS} .ql-proactivity-select > button > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.${EDITOR_CLASS} .ql-proactivity-select > button > span:last-child { flex: none; }
.dsh-qqbot-proactivity-menu { max-width: min(560px, calc(100vw - 24px)); }
.dsh-qqbot-proactivity-menu .ql-proactivity-option { display: flex; flex-direction: column; gap: 2px; white-space: normal; overflow-wrap: anywhere; }
.dsh-qqbot-proactivity-menu .ql-proactivity-option > strong { font-weight: 500; }
.dsh-qqbot-proactivity-menu .ql-proactivity-option > span { color: var(--dsw-alias-label-secondary); }
[role="dialog"].${EDITOR_CLASS}.ql-toy-prompts { width: min(560px, 100%); height: auto; }
.${EDITOR_CLASS} .ql-toy-prompts-content { min-height: 0; overflow: auto; }
.${EDITOR_CLASS}.ql-toy-prompts textarea { box-sizing: border-box; width: 100%; max-width: 100%; }
.${EDITOR_CLASS} .ql-avatar-control { position: relative; flex: none; }
.${EDITOR_CLASS} .ql-avatar-button { display: block; padding: 0; border: none; border-radius: 50%; background: none; cursor: pointer; }
.${EDITOR_CLASS} .ql-avatar-button:disabled { cursor: default; }
.${EDITOR_CLASS} .ql-empty-pane { flex: 1; min-width: 0; }
.${EDITOR_CLASS} .ql-persona-preview { width: 100%; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.${EDITOR_CLASS} .ql-persona-preview > span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 22px; }
.${EDITOR_CLASS}.ql-persona-dialog .ql-persona-text { flex: 1; min-height: 0; width: 100%; resize: none; }
@media (max-width: 600px) {
  .${EDITOR_CLASS} .ql-main:has(> .ql-list) { flex-direction: column; gap: 8px; }
  .${EDITOR_CLASS} .ql-list { flex: 0 0 auto; flex-direction: row; border-right: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); padding: 0 0 8px; }
  .${EDITOR_CLASS} .ql-list > button { flex: none; width: auto; }
  .${EDITOR_CLASS} .ql-list .ql-name { max-width: 120px; }
  .${EDITOR_CLASS} .ql-field.ql-inline { flex-wrap: wrap; gap: 4px 8px; }
  .${EDITOR_CLASS} .ql-inline > select { max-width: 100%; }
  .${EDITOR_CLASS} .ql-inline > .ql-actions { justify-content: flex-start; }
}
.${EDITOR_CLASS} .ql-field > span[title] { cursor: help; }
.${EDITOR_CLASS} .ql-field > span { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.${EDITOR_CLASS} .ql-field > small, .${EDITOR_CLASS} .ql-note { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${EDITOR_CLASS} .ql-field input, .${EDITOR_CLASS} .ql-field select, .${EDITOR_CLASS} .ql-field textarea {
  padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px;
}
.${EDITOR_CLASS} .ql-field input:disabled { color: var(--dsw-alias-label-secondary); }
.${EDITOR_CLASS} .ql-field textarea { resize: vertical; font-family: var(--dsw-font-mono, monospace); font-size: 14px; line-height: 22px; }
.${EDITOR_CLASS} .ql-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${EDITOR_CLASS} .ql-state { padding: 6px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); font-size: 13px; line-height: 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${EDITOR_CLASS} .ql-warn { color: var(--dsw-alias-state-warn-label); }
.${EDITOR_CLASS} .ql-empty { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.${EDITOR_CLASS} .qq-section { display: flex; flex-direction: column; gap: 12px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.${EDITOR_CLASS} .qq-section h3, .${EDITOR_CLASS} .dsh-toy-buttplug .tb-card h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.${EDITOR_CLASS} .ql-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px 32px; }
.${EDITOR_CLASS} .ql-toggle { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--dsw-alias-label-primary); }
.${EDITOR_CLASS} .ql-avatar { width: 40px; height: 40px; border-radius: 50%; corner-shape: round; object-fit: cover; flex: none; }
.${EDITOR_CLASS} .ql-avatar-initial { display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }
.${EDITOR_CLASS} .ql-dual { display: grid; grid-template-columns: minmax(160px, 320px) auto; align-items: center; gap: 12px; justify-content: start; }
.${EDITOR_CLASS} .ql-dual-rail { position: relative; height: 22px; margin: 0 9px; }
.${EDITOR_CLASS} .ql-dual-track { position: absolute; top: 9px; left: 0; right: 0; height: 4px; border-radius: 4px; pointer-events: none;
  background: linear-gradient(to right, var(--dsw-alias-border-l4) var(--ql-a), var(--dsw-alias-brand-primary) var(--ql-a),
    var(--dsw-alias-brand-primary) var(--ql-b), var(--dsw-alias-border-l4) var(--ql-b)); }
.${EDITOR_CLASS} .ql-dual input[type="range"] { position: absolute; top: 0; left: -9px; width: calc(100% + 18px); height: 22px; margin: 0; padding: 0;
  border: 0; background: none; appearance: none; -webkit-appearance: none; pointer-events: none; }
.${EDITOR_CLASS} .ql-dual input[type="range"]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; pointer-events: auto; }
.${EDITOR_CLASS} .ql-dual input[type="range"]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; pointer-events: auto; }
.${EDITOR_CLASS} .ql-dual input[type="range"]:focus-visible { outline: none; }
.${EDITOR_CLASS} .ql-dual input[type="range"]:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${EDITOR_CLASS} .ql-dual input[type="range"]:disabled::-webkit-slider-thumb { cursor: default; opacity: 0.5; }
.${EDITOR_CLASS} .ql-dual output { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.${EDITOR_CLASS} .ql-palettes { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin: 4px 0 8px; }
.${EDITOR_CLASS} .ql-palette { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 12px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px;
  cursor: pointer; transition: background .12s, border-color .12s; }
.${EDITOR_CLASS} .ql-palette:hover { background: var(--dsw-alias-bg-layer-1); }
.${EDITOR_CLASS} .ql-palette[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.${EDITOR_CLASS} .ql-palette:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${EDITOR_CLASS} .ql-palette:disabled { opacity: .5; cursor: default; }
.${EDITOR_CLASS} .ql-palette-preview { position: relative; display: grid; place-items: center; width: 48px; height: 48px;
  border-radius: 12px; background-size: cover; background-position: center; box-shadow: inset 0 0 0 1px #0000000d; }
.${EDITOR_CLASS} .ql-palette-plus { color: #637b90; font-size: 26px; line-height: 1; }
.${EDITOR_CLASS} .ql-palette-check { position: absolute; right: -5px; bottom: -3px; display: grid; place-items: center;
  width: 18px; height: 18px; border: 2px solid var(--dsw-alias-bg-layer-1); border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-brand-primary); color: #fff; font-size: 11px; font-weight: 600; }
.${EDITOR_CLASS} .ql-background-options { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  padding: 0 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
@media (max-width: 600px) {
  .${EDITOR_CLASS} .ql-palettes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
${SETTINGS_CSS}
`

export type EditorTab = 'roles' | 'presets' | 'ui' | 'voice' | 'toy' | 'reply' | 'phone' | 'data' | 'update'

/** 打开编辑器时要定位到的条目；id 为空时选第一个，角色库为空则留白。 */
export interface EditorTarget {
  readonly tab: EditorTab
  readonly sessionId?: string | undefined
  readonly id?: string
  readonly focusProactivity?: boolean
}

export type OpenEditor = (target: EditorTarget) => void

async function request(action?: LibraryAction, signal?: AbortSignal): Promise<LibraryView> {
  // 相对路径：DSH 可能挂在子路径下（与提示词查看器一致）。
  const init: RequestInit = action === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: writeHeaders(), body: JSON.stringify(action) }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(LIBRARY_PATH.slice(1), init)
  const body = await response.json().catch(() => undefined) as (LibraryView & { message?: string }) | undefined
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`)
  return body as LibraryView
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 复制时找一个没用过的名称：名称不能重复。 */
function uniqueName(base: string, taken: readonly { readonly name: string }[]): string {
  const names = new Set(taken.map(item => item.name))
  const stem = base.slice(0, 60)
  if (!names.has(stem)) return stem
  for (let n = 2; ; n++) if (!names.has(`${stem} ${n}`)) return `${stem} ${n}`
}

/** hint 是悬停在标签上时的提示，不铺在页面上。 */
function Field({ label, hint, inline = false, children }: { readonly label: string; readonly hint?: string; readonly inline?: boolean; readonly children: ReactNode }) {
  return <label className={`ql-field qq-settings-field${inline ? ' ql-inline qq-settings-row' : ''}`}>
    <span title={hint}>{label}</span>
    {children}
  </label>
}

/** 多选一组复选框。value 按 choices 的顺序；一个都不选时传 undefined。 */
function ChoiceField<T extends string>({ label, hint, choices, labels, value, onChange }: {
  readonly label: string; readonly hint?: string; readonly choices: readonly T[]; readonly labels: Record<T, string>
  readonly value: readonly T[] | undefined; readonly onChange: (value: readonly T[] | undefined) => void
}) {
  const selected = new Set(value)
  return <div className="ql-field ql-inline">
    <span title={hint}>{label}</span>
    <div className="ql-actions qq-settings-actions">
      {choices.map(choice => <label key={choice} className="ql-toggle">
        <input type="checkbox" checked={selected.has(choice)} onChange={(event) => {
          const next = choices.filter(c => c === choice ? event.target.checked : selected.has(c))
          onChange(next.length === 0 ? undefined : next)
        }} />
        <span>{labels[choice]}</span>
      </label>)}
    </div>
  </div>
}

const BLANK_ROLE: LibraryRoleDraft = { name: '', description: '', persona: '' }
const BLANK_PRESET: LibraryPresetDraft = { name: '', head: '', mid: '', tail: '' }

interface FormProps {
  readonly dynamicsContext?: DynamicsContext | undefined
  readonly saveStatus: string
  readonly view: LibraryView
  readonly ui: UiState
  readonly voice: VoiceState
  readonly memeGuide?: MemeGuide | undefined
  readonly busy: boolean
  readonly removeError: string | undefined
  readonly clearError: () => void
  readonly onBusy: (busy: boolean) => void
  readonly onDirty: (dirty: boolean) => void
  /** 成功时返回操作后的数据，失败时为 undefined（错误已显示）。 */
  readonly run: (action: LibraryAction, onError?: (message: string) => void) => Promise<LibraryView | undefined>
}

/** 新建成功后切换条目；已有角色保存保留其他独立编辑区的草稿。 */
function RoleForm({ view, ui, voice, memeGuide, busy, saveStatus, removeError, clearError, onBusy, onDirty, run, role, template, onSaved, onRemoved, onManageVoices, onCancel, dynamicsContext, focusProactivity = false }: FormProps & {
  readonly role: LibraryRole | undefined
  readonly template: LibraryRoleDraft
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
  readonly onManageVoices: () => void
  readonly onCancel: () => void
  readonly focusProactivity?: boolean
}) {
  const create = role === undefined
  const toySection = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!focusProactivity || toySection.current === null) return
    toySection.current.open = true
    toySection.current.scrollIntoView({ block: 'start' })
  }, [focusProactivity])
  const [roleDirty, setRoleDirty] = useState(false)
  const [textDirty, setTextDirty] = useState({ meme: false, memory: false, toy: false, dynamics: false })
  const markDynamics = useCallback((dynamics: boolean) => setTextDirty(d => d.dynamics === dynamics ? d : { ...d, dynamics }), [])
  const markMeme = useCallback((meme: boolean) => setTextDirty(d => d.meme === meme ? d : { ...d, meme }), [])
  const markMemory = useCallback((memory: boolean) => setTextDirty(d => d.memory === memory ? d : { ...d, memory }), [])
  const markToy = useCallback((toy: boolean) => setTextDirty(d => d.toy === toy ? d : { ...d, toy }), [])
  useEffect(() => { onDirty(roleDirty || Object.values(textDirty).some(Boolean)) }, [roleDirty, textDirty, onDirty])
  const libraryActions = useToyActionNames()
  const [draft, setDraft] = useState<LibraryRoleDraft>(() => ({
    ...role ?? template,
  }))
  const [dynamicEdit, setDynamicEdit] = useState(() => dynamicsDraft((role ?? template).dynamics))
  const [dynamicBase, setDynamicBase] = useState(role?.dynamicsRevision)
  const [dynamicError, setDynamicError] = useState<string>()
  const [resetDynamics, setResetDynamics] = useState<{ persona: string }>()
  // 角色卡里已有、动作库里已没有的名称也列出来，方便取消勾选。
  const actionChoices = [...libraryActions, ...(draft.motionActions ?? []).filter(name => !libraryActions.includes(name))]
  const [confirming, setConfirming] = useState(false)
  const [memeOpen, setMemeOpen] = useState(false)
  const [personaEditor, setPersonaEditor] = useState<{ text: string; dirtyBefore: boolean }>()
  const [discardPersona, setDiscardPersona] = useState(false)
  const leavePersona = () => {
    if (busy || personaEditor === undefined) return
    setRoleDirty(personaEditor.dirtyBefore)
    setDiscardPersona(false)
    setPersonaEditor(undefined)
  }
  const closePersona = () => {
    if (busy || personaEditor === undefined || discardPersona) return
    if (personaEditor.text !== draft.persona) setDiscardPersona(true)
    else leavePersona()
  }
  const edit = (patch: Partial<LibraryRoleDraft>) => { setDraft(d => ({ ...d, ...patch })); setRoleDirty(true) }
  const save = async (persona = draft.persona, reset = false) => {
    // 新建时 id 由服务端生成，从返回值里拿。
    let payload: LibraryRoleDraft
    try {
      const { dynamics: existing, ...staticDraft } = draft
      payload = { ...staticDraft, persona, ...(create && !dynamicEdit.touched && existing ? { dynamics: existing } : {}),
        ...dynamicsPatch(dynamicEdit, dynamicBase), ...(reset ? { resetDynamics: true } : {}) }
    } catch (reason) { setDynamicError(messageOf(reason)); return }
    setDynamicError(undefined)
    const next = await run({ action: 'role.save', create, role: payload }, message => {
      if (!reset && /需要重置/.test(message)) setResetDynamics({ persona })
      else setDynamicError(message)
    })
    if (next?.saved === undefined) return
    if (create) onSaved(next.saved)
    else {
      const savedRole = next.roles.find(r => r.id === next.saved)
      if (savedRole) { setDraft(savedRole); setDynamicEdit(dynamicsDraft(savedRole.dynamics)); setDynamicBase(savedRole.dynamicsRevision) }
      setRoleDirty(false); setPersonaEditor(undefined)
    }
    setResetDynamics(undefined)
  }
  const syncText = (key: 'memePrompt' | 'proactivityTexts' | 'memory', savedRole: LibraryRole) => {
    setDraft(current => {
      const { [key]: _, ...rest } = current
      const value = savedRole[key]
      return { ...rest, ...value === undefined ? {} : { [key]: value } }
    })
  }
  const saveText = async (action: LibraryAction, key: 'memePrompt' | 'proactivityTexts' | 'memory', creation: LibraryRoleDraft) => {
    let failure: string | undefined
    const next = await run(create ? { action: 'role.save', create: true, role: { ...creation, ...dynamicsPatch(dynamicEdit) } } : action, message => { failure = message })
    if (failure !== undefined) throw new Error(failure)
    const savedRole = next?.roles.find(r => r.id === next.saved)
    if (savedRole) {
      if (create) onSaved(savedRole.id)
      else syncText(key, savedRole)
    }
    return savedRole
  }
  const [consolidating, setConsolidating] = useState(false)
  const consolidate = async () => {
    if (role === undefined) return
    setConsolidating(true)
    const next = await run({ action: 'role.memory.consolidate', id: role.id })
    setConsolidating(false)
    const savedRole = next?.roles.find(r => r.id === role.id)
    if (savedRole) syncText('memory', savedRole)
  }
  const isDefault = !create && view.defaultRole === role.id

  return <fieldset className="ql-form ql-editor" disabled={busy}>
    <div className="ql-fields">
    <div className="ql-role-identity"><div className="ql-identity">
      <Field label="名称">
        <input value={draft.name} data-modal-autofocus={create ? '' : undefined} onChange={(event) => { edit({ name: event.target.value }) }} />
      </Field>
    </div>
    <RoleAvatarField ui={ui} role={role} name={draft.name} onBusy={onBusy}>
    {!create && <Button className="ql-role-default" size="sm" variant="outline" disabled={busy}
      title={isDefault ? '取消新 QQ 会话的默认角色' : '设为新 QQ 会话的默认角色'} aria-pressed={isDefault}
      onClick={() => { void run(isDefault ? { action: 'role.default' } : { action: 'role.default', id: role.id }) }}>
      {isDefault ? '取消默认' : '设为默认角色'}
    </Button>}</RoleAvatarField></div>
    <Field label="角色设定" hint="设定、性格、说话方式、示例对话；共用规则写在预设里">
      <button type="button" className="ql-persona-preview" aria-label="编辑角色设定" aria-haspopup="dialog"
        onClick={() => { setPersonaEditor({ text: draft.persona, dirtyBefore: roleDirty }) }}>
        <span>{draft.persona || '点击编辑角色设定'}</span>
      </button>
    </Field>
    <DynamicsEditor value={dynamicEdit} disabled={busy} error={dynamicError ?? role?.dynamicsError}
      roleId={role?.id} context={dynamicsContext} onPendingChange={markDynamics}
      onChange={value => { setDynamicEdit(value); setDynamicError(undefined); setRoleDirty(true) }} />
      <details className="ql-group ql-meme-group qq-settings-fold" onToggle={event => { if (event.target === event.currentTarget) setMemeOpen(event.currentTarget.open) }}>
        <summary><strong>表情包</strong></summary>
        <div className="ql-group-body">
          <div className="ql-actions">
            {view.features.meme && <MemeFrequencyField draft={draft} onChange={next => { setDraft(next); setRoleDirty(true) }} />}
            <MemeHelp guide={memeGuide} disabled={busy || saveStatus !== ''} onBusy={onBusy} />
          </div>
          {!view.features.meme && <div className="ql-note">需要先安装并启用 dsh-meme。</div>}
          {view.features.meme && <MemeFields draft={draft} active={memeOpen} available={view.features.meme}
            onChange={next => { setDraft(next); setRoleDirty(true) }} promptEditor={<RoleTextEditor label="补充提示词"
              value={role?.memePrompt ?? template.memePrompt ?? ''} disabled={busy} maxLength={MEME_PROMPT_LIMIT} clear create={create}
              onDirty={markMeme} onDraft={create ? prompt => { setDraft(d => ({ ...d, memePrompt: prompt })) } : undefined}
              onSave={async prompt => {
                const savedRole = await saveText({ action: 'role.meme-prompt.save', id: role?.id ?? '', prompt }, 'memePrompt', { ...draft, memePrompt: prompt })
                return savedRole === undefined ? undefined : savedRole.memePrompt ?? ''
              }} />} />}
        </div>
      </details>
    <details className="ql-group qq-settings-fold"><summary><strong>记忆</strong></summary>
      <div className="ql-group-body">
        <RoleTextEditor label="跨会话记忆" value={role?.memory ?? template.memory ?? ''} disabled={busy} fold={false}
          maxLength={MEMORY_LIMIT} placeholder={MEMORY_SECTIONS.map(s => `## ${s.title}`).join('\n')} create={create}
          onDirty={markMemory} onDraft={create ? memory => { setDraft(d => ({ ...d, memory })) } : undefined}
          onSave={async memory => (await saveText({ action: 'role.memory.save', id: role?.id ?? '', memory }, 'memory', { ...draft, memory }))?.memory}
          actions={!create && <Button size="sm" variant="outline" disabled={busy || textDirty.memory}
            title={textDirty.memory ? '先保存对记忆的修改' : '总结最近和这个角色的聊天'}
            onClick={() => { void consolidate() }}>{consolidating ? '总结中…' : '从最近对话总结记忆'}</Button>} />
      </div>
    </details>
    <details className="ql-group qq-settings-fold"><summary><strong>音色</strong></summary>
      <div className="ql-group-body"><RoleVoiceField voice={voice} value={draft.voice} onManage={onManageVoices}
        onChange={(value) => { setDraft(({ voice: _, ...rest }) => value === undefined ? rest : { ...rest, voice: value }); setRoleDirty(true) }} /></div>
    </details>
    {view.features.toy && <details ref={toySection} className="ql-group qq-settings-fold"><summary><strong>联动设备</strong></summary><div className="ql-group-body">
    <div className="ql-field"><span>自主性</span>
      <div className="ql-proactivity">
      <RoleProactivitySelect value={draft.proactivity ?? 'follow'} disabled={busy} onChange={value => {
        setDraft(rest => ({ ...rest, proactivity: value }))
        setRoleDirty(true)
      }} />

      </div>
    </div>
    <RoleToyPrompts level={draft.proactivity ?? 'follow'} disabled={busy} value={role?.proactivityTexts ?? template.proactivityTexts}
      onDirty={markToy} create={create} onDraft={create ? proactivityTexts => { setDraft(d => ({ ...d, proactivityTexts })) } : undefined}
      onSave={async (level, text) => {
        const texts = { ...draft.proactivityTexts }
        if (text === undefined) delete texts[level]
        else texts[level] = text
        return (await saveText({ action: 'role.proactivity-text.save', id: role?.id ?? '', level, text }, 'proactivityTexts', { ...draft, proactivityTexts: texts })) !== undefined
      }} />
    {draft.proactivity === 'high' && <p className="ql-note">高自主性下说“停”，AI 可能按人设继续；要立即停下请用暂停按钮或快捷键。</p>}
    {!draft.motionActions?.length && !draft.motionRanges?.length && <p className="ql-note">无勾选＝动作和范围无特殊偏好，按用户要求、剧情和人设选择。</p>}
    <ChoiceField label="偏好动作" hint="只是倾向，用户的要求优先；动作来自联动的动作库"
      choices={actionChoices} labels={Object.fromEntries(actionChoices.map(name => [name, name]))} value={draft.motionActions}
      onChange={(value) => { setDraft(({ motionActions: _, ...rest }) => value === undefined ? rest : { ...rest, motionActions: value }); setRoleDirty(true) }} />
    <ChoiceField label="偏好范围" hint="只是倾向，用户的要求优先"
      choices={MOTION_RANGES} labels={MOTION_RANGE_LABELS} value={draft.motionRanges}
      onChange={(value) => { setDraft(({ motionRanges: _, ...rest }) => value === undefined ? rest : { ...rest, motionRanges: value }); setRoleDirty(true) }} />
    </div></details>}
    </div>
    <div className="ql-savebar qq-settings-actions">
      <span className="ql-save-status qq-settings-status" role="status">{busy ? '保存中…' : saveStatus}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? '保存中…' : create ? '创建角色' : '保存'}</Button>
      {create && <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>}
      {!create && <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { clearError(); setConfirming(true) }}>删除角色</Button>}
    </div>
    {personaEditor !== undefined && <Modal open headless title="角色设定" className={`${EDITOR_CLASS} ql-persona-dialog`} onClose={closePersona}>
      <div className="ql-dialog-layout">
        <header className="ql-heading"><h2>角色设定</h2></header>
        <Button className="ql-close" size="sm" variant="ghost" aria-label="关闭" disabled={busy} onClick={closePersona}>×</Button>
        <textarea className="ql-persona-text" aria-label="角色设定" data-modal-autofocus disabled={busy} value={personaEditor.text}
          onChange={event => {
            setPersonaEditor({ ...personaEditor, text: event.target.value })
            setRoleDirty(true)
          }} />
        <div className="ql-savebar qq-settings-actions">
          <span className="ql-save-status qq-settings-status" role="status">{busy ? '保存中…' : saveStatus}</span>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save(personaEditor.text) }}>{busy ? '保存中…' : create ? '创建角色' : '保存'}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={closePersona}>取消</Button>
        </div>
        {discardPersona && <ActionDialog title="放弃未保存的改动？" cancelLabel="继续编辑" confirmLabel="放弃改动"
          onCancel={() => { setDiscardPersona(false) }} onConfirm={leavePersona}>
          还有未保存的改动，放弃后无法恢复。
        </ActionDialog>}
      </div>
    </Modal>}
    {resetDynamics !== undefined && <ActionDialog title="重置这个角色的进度？" busy={busy} error={dynamicError} confirmLabel="重置后应用"
      onCancel={() => { setResetDynamics(undefined); setDynamicError(undefined) }} onConfirm={() => { void save(resetDynamics.persona, true) }}>
      将重置这个角色在各个会话中的动态状态，并应用本次设定。
    </ActionDialog>}
    {!create && confirming && <ActionDialog title={`删除“${role.name}”？`} busy={busy} error={removeError} confirmLabel="确认删除"
      onCancel={() => { clearError(); setConfirming(false) }}
      onConfirm={() => { void run({ action: 'role.remove', id: role.id }).then((ok) => { if (ok) onRemoved() }) }}>
      正在用这个角色的会话之后按无角色运行。角色会移入回收站。
    </ActionDialog>}
  </fieldset>
}

/** 破限预设表单。preset 为空表示新建（template 是空白或复制来源）。 */
function PresetForm({ view, busy, saveStatus, removeError, clearError, onDirty, run, preset, template, onSaved, onRemoved, onCopy, onCancel }: FormProps & {
  readonly preset: LibraryPreset | undefined
  readonly template: LibraryPresetDraft
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
  readonly onCopy: (draft: LibraryPresetDraft) => void
  readonly onCancel: () => void
}) {
  const create = preset === undefined
  const [draft, setDraft] = useState<LibraryPresetDraft>(preset ?? template)
  const [confirming, setConfirming] = useState(false)
  const edit = (patch: Partial<LibraryPresetDraft>) => { setDraft(d => ({ ...d, ...patch })); onDirty(true) }
  const save = async () => {
    // 新建时 id 由服务端生成，从返回值里拿。
    const saved = (await run({ action: 'preset.save', create, preset: draft }))?.saved
    if (saved !== undefined) onSaved(saved)
  }
  const isDefault = !create && view.currentPreset === preset.id
  const replacement = view.presets.find(p => p.id === (isDefault ? view.presets.find(p => p.id !== preset?.id)?.id : view.currentPreset))

  return <fieldset className="ql-form ql-editor" disabled={busy}>
    <div className="ql-fields">
    <Field label="名称">
      <input value={draft.name} data-modal-autofocus={create ? '' : undefined} onChange={(event) => { edit({ name: event.target.value }) }} />
    </Field>
    <Field label="开头" hint="放在系统提示词最前面，角色设定之前">
      <textarea rows={6} value={draft.head} onChange={(event) => { edit({ head: event.target.value }) }} />
    </Field>
    <Field label="中间" hint="紧跟在角色设定之后">
      <textarea rows={4} value={draft.mid} onChange={(event) => { edit({ mid: event.target.value }) }} />
    </Field>
    <Field label="结尾" hint="放在系统提示词最后">
      <textarea rows={4} value={draft.tail} onChange={(event) => { edit({ tail: event.target.value }) }} />
    </Field>
    </div>
    <div className="ql-savebar qq-settings-actions">
      <span className="ql-save-status qq-settings-status" role="status">{busy ? '保存中…' : saveStatus}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? '保存中…' : create ? '创建预设' : '保存'}</Button>
      {create && <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>}
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { const { id: _, ...copy } = draft; onCopy({ ...copy, name: uniqueName(`${draft.name || '提示词'} 副本`, view.presets) }) }}>
        复制预设
      </Button>
      {!create && <>
        <Button size="sm" variant="outline" disabled={busy || isDefault} onClick={() => { void run({ action: 'preset.current', id: preset.id }) }}>{isDefault ? '使用中' : '设为使用中'}</Button>
        <Button size="sm" variant="outline" disabled={busy || view.presets.length <= 1} onClick={() => { clearError(); setConfirming(true) }}>删除预设</Button>
      </>}
    </div>
    {!create && confirming && <ActionDialog title={`删除“${preset.name}”？`} busy={busy} error={removeError} confirmLabel="确认删除"
      onCancel={() => { clearError(); setConfirming(false) }}
      onConfirm={() => { void run({ action: 'preset.remove', id: preset.id }).then((ok) => { if (ok) onRemoved() }) }}>
      删除后不能恢复。{isDefault && `全部 QQ 会话将改用“${replacement?.name}”。`}
    </ActionDialog>}
  </fieldset>
}

/** 列表里选中的条目：已有条目的 id，或一份还没保存的新条目。 */
type Selection<T> = { readonly id: string } | { readonly draft: T }

/** 编辑器内容和关闭前的检查：有未保存的改动时，guard 先显示确认，确认后才执行。 */
function useLibraryEditor(target: EditorTarget, ui: UiState, voice: VoiceState, extensions?: UiExtensions, memeGuide?: MemeGuide, maintenance?: MaintenanceClient, phoneGuide?: PhoneGuide, dynamicsContext?: DynamicsContext): { readonly guard: (next: () => void) => void; readonly content: ReactNode } {
  const dataVersion = useSyncExternalStore(maintenance?.subscribe ?? NO_SUBSCRIBE, maintenance?.getDataVersion ?? ZERO)
  const seenVersion = useRef(dataVersion)
  const [view, setView] = useState<LibraryView | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [actionError, setActionError] = useState<{ message: string; removing: boolean }>()
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [uiBusy, setUiBusy] = useState(false)
  const [tab, setTab] = useState<EditorTab>(target.tab)
  const [focusProactivity, setFocusProactivity] = useState(target.focusProactivity === true)
  const [presetSel, setPresetSel] = useState<Selection<LibraryPresetDraft> | undefined>(target.tab === 'presets' && target.id !== undefined ? { id: target.id } : undefined)
  useEffect(() => {
    document.querySelector('.dsh-qqbot-library .ql-tabs [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  const [roleSel, setRoleSel] = useState<Selection<LibraryRoleDraft> | undefined>(
    target.tab === 'roles' && target.id !== undefined ? { id: target.id } : undefined)
  // 有未保存的改动时，切换和关闭要先确认。pending 是确认后要做的事。
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy || uiBusy || voiceBusy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy, uiBusy, voiceBusy])
  const [pending, setPending] = useState<(() => void) | undefined>()
  const [importOpen, setImportOpen] = useState(false)
  const [importNotice, setImportNotice] = useState('')
  // 保存后加一，表单换 key 重新挂载，读到服务端规范化后的内容。
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (seenVersion.current === dataVersion) return
    seenVersion.current = dataVersion
    window.dispatchEvent(new Event('qqbot:discard-settings-drafts'))
    setDirty(false); setPending(undefined); setImportOpen(false); setImportNotice('')
    setRoleSel(undefined); setPresetSel(undefined); setActionError(undefined); setLoadError(undefined)
    setTab('data'); setRevision(n => n + 1); setView(undefined)
  }, [dataVersion])

  useEffect(() => {
    const abort = new AbortController()
    request(undefined, abort.signal).then(next => { if (!abort.signal.aborted) setView(next) }, (error: unknown) => { if (!abort.signal.aborted) setLoadError(messageOf(error)) })
    return () => { abort.abort() }
  }, [tab, dataVersion])

  const run = useCallback(async (action: LibraryAction, onError?: (message: string) => void): Promise<LibraryView | undefined> => {
    if (submitting.current) return undefined
    submitting.current = true
    setBusy(true)
    setActionError(undefined)
    try {
      const next = await request(action)
      if (seenVersion.current !== dataVersion) return undefined
      setView(next)
      // 名称变了头像首字跟着变，删了角色要去掉头像，改了默认角色时还没开始的会话跟着变：让各会话重读当前角色。
      if (action.action === 'role.save' || action.action === 'role.meme-prompt.save' || action.action === 'role.proactivity-text.save' || action.action === 'role.remove' || action.action === 'role.default') ui.forgetRoles()
      return next
    } catch (error) {
      if (onError) onError(messageOf(error))
      else setActionError({ message: messageOf(error), removing: action.action === 'role.remove' || action.action === 'preset.remove' })
      return undefined
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }, [ui, dataVersion])

  const guard = (next: () => void) => {
    if (submitting.current || voiceBusy || uiBusy || pending !== undefined || importOpen) return
    if (dirty) setPending(() => next)
    else next()
  }
  const go = (next: () => void) => { guard(() => { setDirty(false); setActionError(undefined); setRevision(n => n + 1); next() }) }
  const saved = (select: () => void) => { setDirty(false); select(); setRevision(n => n + 1) }

  const body = (() => {
    if (loadError !== undefined) return <div className="ql-state ql-warn">{loadError}</div>
    if (view === undefined) return <div className="ql-empty">加载中…</div>
    const formProps = { view, ui, voice, memeGuide, dynamicsContext, busy: busy || uiBusy, saveStatus: dirty ? '有未保存的修改' : '', onBusy: setUiBusy, onDirty: setDirty, run,
      removeError: actionError?.removing === true ? actionError.message : undefined,
      clearError: () => { setActionError(undefined) } }
    if (tab === 'data') return <DataSettings maintenance={maintenance} onBusy={setUiBusy} view={view} onImport={() => { setImportNotice(''); setImportOpen(true) }} />
    if (tab === 'update') return <UpdateSettings />
    if (tab === 'phone') return <PhoneSettings onBusy={setUiBusy} onDirty={setDirty} guide={phoneGuide} />
    if (tab === 'toy' || tab === 'reply') return <div className="ql-main">{extensions && <UiExtensionFields extensions={extensions} page={tab} onBusy={setUiBusy} onDirty={setDirty}
      {...tab === 'toy' ? { onOpenRoleProactivity: () => { go(() => { setFocusProactivity(true); setTab('roles') }) } } : {}} />}</div>
    if (tab === 'ui') return <div className="ql-main"><UiForm ui={ui} onBusy={setUiBusy} onDirty={setDirty} exampleRole={view.roles[0]} extensions={extensions} /></div>
    if (tab === 'voice') return <VoicePage voice={voice} roles={view.roles} onDirty={setDirty} onBusy={setVoiceBusy} guard={guard}
      onAssignVoice={async (id, voiceId) => {
        // 绑定前重读角色，避免用打开语音页时的旧正文覆盖文件中的新改动。
        const latest = await request()
        const role = latest.roles.find(role => role.id === id)
        if (role === undefined) throw new Error('这个角色已被删除，请重新打开设置。')
        const next = await request({ action: 'role.save', create: false, role: { ...role, voice: voiceId } })
        setView(next)
        ui.forgetRoles()
      }}
      onOpenRole={(id) => { go(() => { setRoleSel(id === undefined ? undefined : { id }); setTab('roles') }) }} />
    if (tab === 'presets') {
      const selected = presetSel ?? { id: view.currentPreset }
      const preset = 'id' in selected ? view.presets.find(p => p.id === selected.id) : undefined
      return <div className="ql-main">
        <div className="ql-list">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { go(() => { setPresetSel({ draft: BLANK_PRESET }); setDirty(true) }) }}>新建预设</Button>
          {view.presets.map(p => <button key={p.id} type="button" className="ql-row" disabled={busy} aria-current={preset?.id === p.id}
            onClick={() => { if (preset?.id !== p.id) go(() => { setPresetSel({ id: p.id }) }) }}>
            <span className="ql-name">{p.name}</span>{view.currentPreset === p.id && <Tag tone="neutral">使用中</Tag>}
          </button>)}
        </div>
        {'id' in selected && preset === undefined ? <div className="ql-empty">这份预设已被删除。</div>
          : <PresetForm key={`${preset?.id ?? 'new'}:${revision}`} {...formProps} preset={preset}
            template={'draft' in selected ? selected.draft : BLANK_PRESET}
            onSaved={id => { saved(() => { setPresetSel({ id }) }) }}
            onRemoved={() => { saved(() => { setPresetSel(undefined) }) }}
            onCancel={() => { go(() => { setPresetSel(undefined) }) }}
            onCopy={draft => { go(() => { setPresetSel({ draft }); setDirty(true) }) }} />}
      </div>
    }
    if (tab === 'roles') {
      const selected = roleSel ?? (view.roles[0] === undefined ? undefined : { id: view.roles[0].id })
      const role = selected !== undefined && 'id' in selected ? view.roles.find(r => r.id === selected.id) : undefined
      return <div className="ql-main">
        <div className="ql-list">
          <Button size="sm" variant="outline" onClick={() => { go(() => { setRoleSel({ draft: BLANK_ROLE }) }) }}>新建角色</Button>
          {view.roles.length === 0 && <div className="ql-empty">角色库是空的</div>}
          {view.roles.map(r => <button key={r.id} type="button" className="ql-row" aria-current={role?.id === r.id}
            onClick={() => { if (role?.id !== r.id) go(() => { setRoleSel({ id: r.id }) }) }}>
            <span className="ql-name">{r.name}</span>
            {view.defaultRole === r.id && <Tag tone="neutral">默认</Tag>}
          </button>)}
        </div>
        {selected === undefined ? <div className="ql-empty-pane" /> : 'id' in selected && role === undefined
          ? <div className="ql-empty">这个角色已经不在角色库里，可能已在文件里删除。</div>
          : <RoleForm key={`${role?.id ?? 'new'}:${revision}`} {...formProps} role={role}
            focusProactivity={focusProactivity}
            template={'draft' in selected ? selected.draft : BLANK_ROLE}
            onSaved={(id) => { saved(() => { setRoleSel({ id }) }) }}
            onRemoved={() => { saved(() => { setRoleSel(undefined) }) }}
            onCancel={() => { go(() => { setRoleSel(undefined) }) }}
            onManageVoices={() => { go(() => { setTab('voice') }) }} /> }
      </div>
    }
    return null
  })()

  const content = <div className="ql-body">
      <header className="ql-heading"><h2>QQ Bot 设置</h2><UpdateButton active={tab === 'update'} onClick={() => go(() => setTab('update'))} /></header>
      <nav className="ql-tabs" aria-label="QQ Bot 设置">
        {([['roles', '角色'], ['presets', '预设'], ['reply', '聊天辅助'], ['ui', '界面'], ['voice', '语音'], ['toy', '联动设备'], ['phone', '手机'], ['data', '数据']] as const).map(([key, label]) =>
          <Button key={key} size="sm" variant={tab === key ? 'outline' : 'ghost'}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => { if (tab !== key) go(() => { setTab(key) }) }}>{label}</Button>)}
        {extensions && <UiExtensionFields extensions={extensions} page="promotion" onBusy={setUiBusy} />}
      </nav>
      {importNotice && <div className="ql-state" role="status">{importNotice}</div>}
      <div className="ql-page">{body}</div>
      {importOpen && <ConfigImport onClose={() => { setImportOpen(false) }} onImported={(next, result) => {
        setView(next)
        ui.forgetRoles()
        setRevision(n => n + 1)
        setImportOpen(false)
        setImportNotice(`已导入 ${result.presets} 份预设、${result.roles} 个角色，跳过 ${result.skipped} 项`)
      }} />}
      {pending !== undefined && <ActionDialog title="放弃未保存的改动？" cancelLabel="继续编辑" confirmLabel="放弃改动"
        onCancel={() => { setPending(undefined) }}
        onConfirm={() => {
          const next = pending
          window.dispatchEvent(new Event('qqbot:discard-settings-drafts'))
          setPending(undefined); setDirty(false); next()
        }}>
        还有未保存的改动，放弃后无法恢复。
      </ActionDialog>}
      {actionError !== undefined && !actionError.removing && <ActionDialog title="操作未完成" cancelLabel="知道了" onCancel={() => { setActionError(undefined) }}>
        {actionError.message}
      </ActionDialog>}
    </div>
  return { guard, content }
}

function LibraryDialog({ target, ui, voice, onClose, extensions, memeGuide, maintenance, phoneGuide, dynamicsContext }: {
  readonly dynamicsContext?: DynamicsContext | undefined
  readonly target: EditorTarget; readonly ui: UiState; readonly voice: VoiceState; readonly onClose: () => void; readonly extensions?: UiExtensions | undefined; readonly memeGuide?: MemeGuide | undefined; readonly maintenance?: MaintenanceClient | undefined; readonly phoneGuide?: PhoneGuide | undefined
}) {
  const { guard, content } = useLibraryEditor(target, ui, voice, extensions, memeGuide, maintenance, phoneGuide,
    dynamicsContext === undefined ? undefined : { ...dynamicsContext, current:target.sessionId })
  return <Modal open onClose={() => { guard(onClose) }} title="QQ Bot 设置" headless className={EDITOR_CLASS}>
    <div className="ql-dialog-layout"><Button className="ql-close" size="sm" variant="ghost" aria-label="关闭" onClick={() => guard(onClose)}>×</Button>{content}</div>
  </Modal>
}

export interface LibrarySettingsInjected {
  readonly openEditor: OpenEditor
}

/** 选中设置侧栏 QQ Bot 时即挂载：关闭宿主设置，再打开独立编辑器，不渲染中间页面。 */
export function LibrarySettingsSection({ close, openEditor }: PropsRuntime<'settings.section'> & InjectFace<LibrarySettingsInjected>) {
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    close()
    openEditor(ROLES)
  }, [close, openEditor])
  return null
}

const ROLES: EditorTarget = { tab: 'roles' }

export interface LibraryEditorInjected {
  readonly dynamicsContext?: DynamicsContext | undefined
  readonly hooks: { readonly editorTarget: SnapshotStore<EditorTarget | null> }
  readonly closeEditor: () => void
  readonly ui: UiState
  readonly voice: VoiceState
  readonly memeGuide?: MemeGuide | undefined
  readonly extensions?: UiExtensions
  readonly maintenance?: MaintenanceClient
  readonly phoneGuide?: PhoneGuide | undefined
}

const NO_SUBSCRIBE = () => () => {}
const ZERO = () => 0

/** `shell.overlay` 里的常驻组件：没有打开时什么也不渲染。target 变化时换 key，重新加载。 */
export function LibraryEditorHost({ useEditorTarget, closeEditor, ui, voice, extensions, memeGuide, maintenance, phoneGuide, dynamicsContext }: InjectFace<LibraryEditorInjected>) {
  const target = useEditorTarget(state => state)
  if (target === null) return null
  return <LibraryDialog key={`${target.tab}:${target.id ?? ''}:${target.focusProactivity === true}`} target={target} ui={ui} voice={voice} extensions={extensions} memeGuide={memeGuide} maintenance={maintenance} phoneGuide={phoneGuide} dynamicsContext={dynamicsContext} onClose={closeEditor} />
}
