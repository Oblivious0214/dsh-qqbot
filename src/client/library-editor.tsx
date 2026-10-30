/**
 * 角色、破限预设、界面和语音设置编辑器。统一在 `shell.overlay` 的独立弹窗里编辑；
 * 选中 DSH 设置侧栏的"QQ Bot"即跳转，角色菜单和提示词查看器可直接定位到对应条目。
 * 角色和预设来自 host 的 LIBRARY_PATH，保存后下一条消息起生效；界面设置和头像见 ui-editor.tsx，语音见 voice-editor.tsx。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  LIBRARY_PATH, MOTION_ACTION_LABELS, MOTION_ACTIONS,
  MOTION_RANGE_LABELS, MOTION_RANGES, ROLE_PROACTIVITIES, ROLE_PROACTIVITY_LABELS,
  type LibraryAction, type LibraryPreset, type LibraryPresetDraft, type LibraryRole, type LibraryRoleDraft, type LibraryView,
} from '../library-types.ts'
import { RoleAvatarField, UiForm } from './ui-editor.tsx'
import type { UiState } from './ui-state.ts'
import { RoleVoiceField, VoicePage } from './voice-editor.tsx'
import { VOICE_EDITOR_CSS } from './voice-style.ts'
import type { VoiceState } from './voice-state.ts'
import { MemeFields } from './meme-fields.tsx'
import { ActionDialog } from './action-dialog.tsx'
import { RoleToyPrompts } from './role-toy-prompts.tsx'
import type { UiExtensions } from './ui-extensions.tsx'
import { ConfigImport } from './config-import.tsx'
import { MEMORY_LIMIT, MEMORY_SECTIONS } from '../memory-format.ts'

/** 所有样式都在这个根 class 下（CLAUDE.md 隔离原则第 3 条）。 */
export const EDITOR_CLASS = 'dsh-qqbot-library'

export const EDITOR_CSS = `
${VOICE_EDITOR_CSS}
[role="dialog"].${EDITOR_CLASS} { width: min(960px, 100%); max-height: 100%; font-size: 14px; line-height: 22px; }
.${EDITOR_CLASS} .ql-modal-content, .${EDITOR_CLASS} .ql-modal-content > :last-child { min-height: 0; }
.${EDITOR_CLASS} .ql-body { display: flex; flex-direction: column; gap: 10px; }
.${EDITOR_CLASS} .ql-tabs { display: flex; gap: 6px; }
/* 与 DSH 设置页一致：正文和控件 14/22，辅助文字 13/20；仅作用于本编辑器。 */
.${EDITOR_CLASS} .ql-body button { font-size: 14px; line-height: 22px; min-height: 36px; }
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
.${EDITOR_CLASS} .ql-body, .${EDITOR_CLASS} .ql-main { min-height: 0; }
.${EDITOR_CLASS} .ql-tabs { flex-wrap: wrap; flex-shrink: 0; }
.${EDITOR_CLASS} .ql-field > input[type="number"] { width: 120px; max-width: 100%; }
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
.${EDITOR_CLASS} .ql-field.ql-inline { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.${EDITOR_CLASS} .ql-inline > span { flex: none; }
.${EDITOR_CLASS} .ql-inline > select { min-width: 0; max-width: 65%; }
.${EDITOR_CLASS} .ql-inline > .ql-actions { min-width: 0; justify-content: flex-end; }
.${EDITOR_CLASS} .ql-inline > .ql-actions > select { min-width: 0; max-width: 100%; }
.${EDITOR_CLASS} .ql-avatar-control { position: relative; flex: none; }
.${EDITOR_CLASS} .ql-avatar-button { display: block; padding: 0; border: none; border-radius: 50%; background: none; cursor: pointer; }
.${EDITOR_CLASS} .ql-avatar-button:disabled { cursor: default; }
.${EDITOR_CLASS} .ql-empty-pane { flex: 1; min-width: 0; }
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
.${EDITOR_CLASS} .ql-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px 16px; }
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
`

export type EditorTab = 'roles' | 'presets' | 'ui' | 'voice'

/** 打开编辑器时要定位到的条目；id 为空时选第一个，角色库为空则留白。 */
export interface EditorTarget {
  readonly tab: EditorTab
  readonly id?: string
}

export type OpenEditor = (target: EditorTarget) => void

async function request(action?: LibraryAction, signal?: AbortSignal): Promise<LibraryView> {
  // 相对路径：DSH 可能挂在子路径下（与提示词查看器一致）。
  const init: RequestInit = action === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }
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
  return <label className={`ql-field${inline ? ' ql-inline' : ''}`}>
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
    <div className="ql-actions">
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
  readonly saveStatus: string
  readonly view: LibraryView
  readonly ui: UiState
  readonly voice: VoiceState
  readonly busy: boolean
  readonly removeError: string | undefined
  readonly clearError: () => void
  readonly onBusy: (busy: boolean) => void
  readonly onDirty: (dirty: boolean) => void
  /** 成功时返回操作后的数据，失败时为 undefined（错误已显示）。 */
  readonly run: (action: LibraryAction) => Promise<LibraryView | undefined>
}

function FormMore({ disabled, items, onSelect }: {
  readonly disabled: boolean; readonly items: readonly { id: string; label: string; danger?: boolean; disabled?: boolean }[]
  readonly onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal autoFocus align="end" onClose={() => { setOpen(false) }} items={items}
    anchor={<Button size="sm" variant="ghost" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setOpen(!open) }}>更多</Button>}
    onSelect={id => { setOpen(false); onSelect(id) }} />
}

/** 角色表单。role 为空表示新建；保存成功后由父组件换 key 重新挂载。 */
function RoleForm({ view, ui, voice, busy, saveStatus, removeError, clearError, onBusy, onDirty, run, role, template, onSaved, onRemoved, onManageVoices, onCancel }: FormProps & {
  readonly role: LibraryRole | undefined
  readonly template: LibraryRoleDraft
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
  readonly onManageVoices: () => void
  readonly onCancel: () => void
}) {
  const create = role === undefined
  const [draft, setDraft] = useState<LibraryRoleDraft>(() => ({
    ...role ?? template, preset: (role ?? template).preset ?? view.defaultPreset,
  }))
  const [confirming, setConfirming] = useState(false)
  const [memeOpen, setMemeOpen] = useState(false)
  const [toyOpen, setToyOpen] = useState(false)
  const edit = (patch: Partial<LibraryRoleDraft>) => { setDraft(d => ({ ...d, ...patch })); onDirty(true) }
  const save = async () => {
    // 新建时 id 由服务端生成，从返回值里拿。
    const saved = (await run({ action: 'role.save', create, role: draft }))?.saved
    if (saved !== undefined) onSaved(saved)
  }
  // 整理要等模型回复，结果只替换记忆栏，表单其他未保存的修改不动。记忆栏本身有未保存的修改时不能整理。
  const [consolidating, setConsolidating] = useState(false)
  const memoryEdited = (draft.memory ?? '') !== (role?.memory ?? '')
  const consolidate = async () => {
    if (role === undefined) return
    setConsolidating(true)
    const next = await run({ action: 'role.memory.consolidate', id: role.id })
    setConsolidating(false)
    const memory = next?.roles.find(r => r.id === role.id)?.memory
    if (memory !== undefined) setDraft(d => ({ ...d, memory }))
  }
  const isDefault = !create && view.defaultRole === role.id

  return <fieldset className="ql-form ql-editor" disabled={busy}>
    <div className="ql-fields">
    <div className="ql-identity">
      <Field label="名称">
        <input value={draft.name} data-modal-autofocus={create ? '' : undefined} onChange={(event) => { edit({ name: event.target.value }) }} />
      </Field>
    </div>
    <RoleAvatarField ui={ui} role={role} name={draft.name} onBusy={onBusy} />
    <Field label="角色设定" hint="设定、性格、说话方式、示例对话。成年人声明等通用规则写在破限预设里">
      <textarea rows={14} value={draft.persona} onChange={(event) => { edit({ persona: event.target.value }) }} />
    </Field>
    <Field label="破限预设" inline>
      <select value={draft.preset} disabled={busy} onChange={(event) => { edit({ preset: event.target.value }) }}>
        {view.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
    </Field>
    {view.features.meme &&
      <details className="ql-group" onToggle={event => { setMemeOpen(event.currentTarget.open) }}>
        <summary><strong>表情包</strong></summary>
        <div className="ql-group-body"><MemeFields draft={draft} active={memeOpen} available={view.features.meme}
          onChange={next => { setDraft(next); onDirty(true) }} /></div>
      </details>}
    <details className="ql-group"><summary><strong>记忆</strong></summary>
      <div className="ql-group-body">
        <Field label="跨会话记忆" hint={`新会话开始时读取，聊天中途不变。按栏目写，最多 ${MEMORY_LIMIT} 字`}>
          <textarea rows={10} value={draft.memory ?? ''} placeholder={MEMORY_SECTIONS.map(s => `## ${s.title}`).join('\n')}
            onChange={(event) => { edit({ memory: event.target.value }) }} />
        </Field>
        {!create && <div className="ql-actions">
          <Button size="sm" variant="outline" disabled={busy || memoryEdited}
            title={memoryEdited ? '先保存对记忆的修改' : '用最近和这个角色的聊天整理一次'}
            onClick={() => { void consolidate() }}>{consolidating ? '整理中…' : '整理记忆'}</Button>
        </div>}
      </div>
    </details>
    <details className="ql-group"><summary><strong>音色</strong></summary>
      <div className="ql-group-body"><RoleVoiceField voice={voice} value={draft.voice} onManage={onManageVoices}
        onChange={(value) => { setDraft(({ voice: _, ...rest }) => value === undefined ? rest : { ...rest, voice: value }); onDirty(true) }} /></div>
    </details>
    {view.features.toy && <details className="ql-group" onToggle={event => { if (event.target === event.currentTarget) setToyOpen(event.currentTarget.open) }}><summary><strong>联动玩具</strong></summary><div className="ql-group-body">
    <Field label="自主性" inline hint="AI 控制设备的自主程度：从主要依照用户要求，到更多依据剧情走向和角色性格自主决定。随角色保存，下一轮生效。">
      <select value={draft.proactivity ?? 'follow'} onChange={(event) => {
        const value = ROLE_PROACTIVITIES.find(p => p === event.target.value)
        if (value === undefined) return
        setDraft(rest => ({ ...rest, proactivity: value }))
        onDirty(true)
      }}>
        {ROLE_PROACTIVITIES.map(p => <option key={p} value={p}>{ROLE_PROACTIVITY_LABELS[p]}</option>)}
      </select>
    </Field>
    <details className="ql-group"><summary>自主性说明</summary><div className="ql-group-body">
      <p className="ql-note">AI 控制设备的自主程度：低自主性主要依照用户要求，中自主性结合剧情和角色性格适度调整，高自主性更多依据剧情和角色性格自主决定。随角色保存，下一轮生效；三档提示词可在下方修改。</p>
    </div></details>
    {draft.proactivity === 'high' && <p className="ql-note">高自主性下，在对话里说“停”“慢一点”时，AI 可能按人设继续。需要立即停下时，请用暂停按钮或暂停快捷键。</p>}
    <ChoiceField label="偏好动作" hint="只是倾向，用户的要求优先；不选表示没有偏好"
      choices={MOTION_ACTIONS} labels={MOTION_ACTION_LABELS} value={draft.motionActions}
      onChange={(value) => { setDraft(({ motionActions: _, ...rest }) => value === undefined ? rest : { ...rest, motionActions: value }); onDirty(true) }} />
    <ChoiceField label="偏好范围" hint="只是倾向，用户的要求优先；滑动只在全行程、下半程、上半程里生效"
      choices={MOTION_RANGES} labels={MOTION_RANGE_LABELS} value={draft.motionRanges}
      onChange={(value) => { setDraft(({ motionRanges: _, ...rest }) => value === undefined ? rest : { ...rest, motionRanges: value }); onDirty(true) }} />
    <RoleToyPrompts active={toyOpen} value={draft.proactivityTexts} onChange={value => {
      setDraft(({ proactivityTexts: _, ...rest }) => value === undefined ? rest : { ...rest, proactivityTexts: value })
      onDirty(true)
    }} />
    </div></details>}
    </div>
    <div className="ql-savebar">
      <span className="ql-save-status" role="status">{busy ? '保存中…' : create && saveStatus === '已保存' ? '尚未创建' : saveStatus}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? '保存中…' : create ? '创建角色' : '保存'}</Button>
      {create && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>}
      {!create && <FormMore disabled={busy} items={[
        { id: 'default', label: isDefault ? '取消新会话默认' : '设为新会话默认' }, { id: 'remove', label: '删除角色', danger: true },
      ]} onSelect={id => { if (id === 'remove') { clearError(); setConfirming(true) }
        else void run(isDefault ? { action: 'role.default' } : { action: 'role.default', id: role.id }) }} />}
    </div>
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
  const isDefault = !create && view.defaultPreset === preset.id
  const users = create ? [] : view.roles.filter(role => (role.preset ?? view.defaultPreset) === preset.id)
  const replacement = view.presets.find(p => p.id === (isDefault ? view.presets.find(p => p.id !== preset?.id)?.id : view.defaultPreset))

  return <fieldset className="ql-form ql-editor" disabled={busy}>
    <div className="ql-fields">
    <Field label="名称">
      <input value={draft.name} data-modal-autofocus={create ? '' : undefined} onChange={(event) => { edit({ name: event.target.value }) }} />
    </Field>
    <Field label="提示词" hint="放在系统提示词最前面，角色设定之前">
      <textarea rows={6} value={draft.head} onChange={(event) => { edit({ head: event.target.value }) }} />
    </Field>
    <details className="ql-group"><summary><strong>高级</strong></summary><div className="ql-group-body">
    <Field label="中间" hint="紧跟在角色设定之后">
      <textarea rows={4} value={draft.mid} onChange={(event) => { edit({ mid: event.target.value }) }} />
    </Field>
    <Field label="结尾" hint="放在系统提示词最后">
      <textarea rows={4} value={draft.tail} onChange={(event) => { edit({ tail: event.target.value }) }} />
    </Field>
    </div></details>
    </div>
    <div className="ql-savebar">
      <span className="ql-save-status" role="status">{busy ? '保存中…' : create && saveStatus === '已保存' ? '尚未创建' : saveStatus}</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{busy ? '保存中…' : create ? '创建预设' : '保存'}</Button>
      {create && <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>}
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { const { id: _, ...copy } = draft; onCopy({ ...copy, name: uniqueName(`${draft.name || '预设'} 副本`, view.presets) }) }}>
        复制为新预设
      </Button>
      {!create && <FormMore disabled={busy} items={[
        ...isDefault ? [] : [{ id: 'default', label: '设为新角色默认预设' }],
        { id: 'remove', label: '删除预设', danger: true, disabled: view.presets.length <= 1 },
      ]} onSelect={id => { if (id === 'remove') { clearError(); setConfirming(true) }
        else void run({ action: 'preset.default', id: preset.id }) }} />}
    </div>
    {!create && confirming && <ActionDialog title={`删除“${preset.name}”？`} busy={busy} error={removeError} confirmLabel="确认删除"
      onCancel={() => { clearError(); setConfirming(false) }}
      onConfirm={() => { void run({ action: 'preset.remove', id: preset.id }).then((ok) => { if (ok) onRemoved() }) }}>
      删除后不能恢复。{users.length > 0 && `${users.map(role => role.name).join('、')}将改用“${replacement?.name ?? '其他预设'}”。`}
    </ActionDialog>}
  </fieldset>
}

/** 列表里选中的条目：已有条目的 id，或一份还没保存的新条目。 */
type Selection<T> = { readonly id: string } | { readonly draft: T }

/** 编辑器内容和关闭前的检查：有未保存的改动时，guard 先显示确认，确认后才执行。 */
function useLibraryEditor(target: EditorTarget, ui: UiState, voice: VoiceState, extensions?: UiExtensions): { readonly guard: (next: () => void) => void; readonly content: ReactNode } {
  const [view, setView] = useState<LibraryView | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [actionError, setActionError] = useState<{ message: string; removing: boolean }>()
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [uiBusy, setUiBusy] = useState(false)
  const [tab, setTab] = useState<EditorTab>(target.tab)
  const [roleSel, setRoleSel] = useState<Selection<LibraryRoleDraft> | undefined>(
    target.tab === 'roles' && target.id !== undefined ? { id: target.id } : undefined)
  const [presetSel, setPresetSel] = useState<Selection<LibraryPresetDraft> | undefined>(
    target.tab === 'presets' && target.id !== undefined ? { id: target.id } : undefined)
  // 有未保存的改动时，切换和关闭要先确认。pending 是确认后要做的事。
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<(() => void) | undefined>()
  const [importOpen, setImportOpen] = useState(false)
  const [importNotice, setImportNotice] = useState('')
  // 保存后加一，表单换 key 重新挂载，读到服务端规范化后的内容。
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    request(undefined, abort.signal).then(setView, (error: unknown) => { if (!abort.signal.aborted) setLoadError(messageOf(error)) })
    return () => { abort.abort() }
  }, [])

  const run = useCallback(async (action: LibraryAction): Promise<LibraryView | undefined> => {
    if (submitting.current) return undefined
    submitting.current = true
    setBusy(true)
    setActionError(undefined)
    try {
      const next = await request(action)
      setView(next)
      // 名称变了头像首字跟着变，删了角色要去掉头像，改了默认角色时还没开始的会话跟着变：让各会话重读当前角色。
      if (action.action === 'role.save' || action.action === 'role.remove' || action.action === 'role.default') ui.forgetRoles()
      return next
    } catch (error) {
      setActionError({ message: messageOf(error), removing: action.action === 'role.remove' || action.action === 'preset.remove' })
      return undefined
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }, [ui])

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
    const formProps = { view, ui, voice, busy: busy || uiBusy, saveStatus: dirty ? '有未保存的修改' : '已保存', onBusy: setUiBusy, onDirty: setDirty, run,
      removeError: actionError?.removing === true ? actionError.message : undefined,
      clearError: () => { setActionError(undefined) } }
    if (tab === 'ui') return <div className="ql-main"><UiForm ui={ui} onBusy={setUiBusy} exampleRole={view.roles[0]} extensions={extensions} /></div>
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
            template={'draft' in selected ? selected.draft : BLANK_ROLE}
            onSaved={(id) => { saved(() => { setRoleSel({ id }) }) }}
            onRemoved={() => { saved(() => { setRoleSel(undefined) }) }}
            onCancel={() => { go(() => { setRoleSel(undefined) }) }}
            onManageVoices={() => { go(() => { setTab('voice') }) }} />}
      </div>
    }
    const selected = presetSel ?? { id: view.defaultPreset }
    const preset = 'id' in selected ? view.presets.find(p => p.id === selected.id) : undefined
    // 新草稿按名称区分：复制出来的草稿名称不同，表单会重新挂载。
    const draftKey = 'draft' in selected ? `new:${selected.draft.name}` : preset?.id ?? 'missing'
    return <div className="ql-main">
      <div className="ql-list">
        <Button size="sm" variant="outline" onClick={() => { go(() => { setPresetSel({ draft: BLANK_PRESET }) }) }}>新建预设</Button>
        {view.presets.map(p => <button key={p.id} type="button" className="ql-row" aria-current={preset?.id === p.id}
          onClick={() => { if (preset?.id !== p.id) go(() => { setPresetSel({ id: p.id }) }) }}>
          <span className="ql-name">{p.name}</span>
          {view.defaultPreset === p.id && <Tag tone="neutral">默认</Tag>}
        </button>)}
      </div>
      {'id' in selected && preset === undefined
        ? <div className="ql-empty">这份预设已经不在了，可能已被删除。</div>
        : <PresetForm key={`${draftKey}:${revision}`} {...formProps} preset={preset}
          template={'draft' in selected ? selected.draft : BLANK_PRESET}
          onSaved={(id) => { saved(() => { setPresetSel({ id }) }) }}
          onRemoved={() => { saved(() => { setPresetSel(undefined) }) }}
          onCancel={() => { go(() => { setPresetSel(undefined) }) }}
          onCopy={(draft) => { go(() => { setPresetSel({ draft }); setDirty(true) }) }} />}
    </div>
  })()

  const content = <div className="ql-body">
      <div className="ql-tabs">
        <Button size="sm" variant={tab === 'roles' ? 'outline' : 'ghost'}
          onClick={() => { if (tab !== 'roles') go(() => { setTab('roles') }) }}>角色</Button>
        <Button size="sm" variant={tab === 'presets' ? 'outline' : 'ghost'}
          onClick={() => { if (tab !== 'presets') go(() => { setTab('presets') }) }}>破限预设</Button>
        <Button size="sm" variant={tab === 'ui' ? 'outline' : 'ghost'}
          onClick={() => { if (tab !== 'ui') go(() => { setTab('ui') }) }}>界面</Button>
        <Button size="sm" variant={tab === 'voice' ? 'outline' : 'ghost'}
          onClick={() => { if (tab !== 'voice') go(() => { setTab('voice') }) }}>语音</Button>
        <Button size="sm" variant="outline" className="ql-import-button" disabled={view === undefined || busy || voiceBusy || uiBusy}
          onClick={() => { go(() => { setImportNotice(''); setImportOpen(true) }) }}>导入配置</Button>
      </div>
      {importNotice && <div className="ql-state" role="status">{importNotice}</div>}
      {body}
      {importOpen && <ConfigImport onClose={() => { setImportOpen(false) }} onImported={(next, result) => {
        setView(next)
        ui.forgetRoles()
        setRevision(n => n + 1)
        setImportOpen(false)
        setImportNotice(`已导入 ${result.presets} 份预设、${result.roles} 个角色，跳过 ${result.skipped} 项`)
      }} />}
      {pending !== undefined && <ActionDialog title="放弃未保存的改动？" cancelLabel="继续编辑" confirmLabel="放弃改动"
        onCancel={() => { setPending(undefined) }}
        onConfirm={() => { const next = pending; setPending(undefined); setDirty(false); next() }}>
        还有未保存的改动，放弃后无法恢复。
      </ActionDialog>}
      {actionError !== undefined && !actionError.removing && <ActionDialog title="操作未完成" cancelLabel="知道了" onCancel={() => { setActionError(undefined) }}>
        {actionError.message}
      </ActionDialog>}
    </div>
  return { guard, content }
}

function LibraryDialog({ target, ui, voice, onClose, extensions }: {
  readonly target: EditorTarget; readonly ui: UiState; readonly voice: VoiceState; readonly onClose: () => void; readonly extensions?: UiExtensions | undefined
}) {
  const { guard, content } = useLibraryEditor(target, ui, voice, extensions)
  return <Modal open onClose={() => { guard(onClose) }} title="QQ Bot 设置" closeLabel="关闭" className={EDITOR_CLASS} contentClassName="ql-modal-content">
    {content}
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
  readonly hooks: { readonly editorTarget: SnapshotStore<EditorTarget | null> }
  readonly closeEditor: () => void
  readonly ui: UiState
  readonly voice: VoiceState
  readonly extensions?: UiExtensions
}

/** `shell.overlay` 里的常驻组件：没有打开时什么也不渲染。target 变化时换 key，重新加载。 */
export function LibraryEditorHost({ useEditorTarget, closeEditor, ui, voice, extensions }: InjectFace<LibraryEditorInjected>) {
  const target = useEditorTarget(state => state)
  if (target === null) return null
  return <LibraryDialog key={`${target.tab}:${target.id ?? ''}`} target={target} ui={ui} voice={voice} extensions={extensions} onClose={closeEditor} />
}
