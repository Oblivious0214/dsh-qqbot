/**
 * 角色、破限预设、界面和语音设置编辑器。同一份编辑器有两个位置：DSH 设置窗口里的"QQ Bot"页（左下角"更多"→ 设置），
 * 和提示词查看器"编辑"打开的弹窗（挂在全局常驻的 `shell.overlay`，定位到对应条目）。
 * 角色和预设来自 host 的 LIBRARY_PATH，保存后下一条消息起生效；界面设置和头像见 ui-editor.tsx，语音见 voice-editor.tsx。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  DEFAULT_MEME_FREQUENCY, LIBRARY_PATH, MEME_FREQUENCIES, MEME_FREQUENCY_LABELS, MOTION_ACTION_LABELS, MOTION_ACTIONS,
  MOTION_RANGE_LABELS, MOTION_RANGES, ROLE_PROACTIVITIES, ROLE_PROACTIVITY_LABELS,
  type LibraryAction, type LibraryPreset, type LibraryPresetDraft, type LibraryRole, type LibraryRoleDraft, type LibraryView,
} from '../library-types.ts'
import { RoleAvatarField, UiForm } from './ui-editor.tsx'
import type { UiState } from './ui-state.ts'
import { RoleVoiceField, VoicePage } from './voice-editor.tsx'
import type { VoiceState } from './voice-state.ts'

/** 所有样式都在这个根 class 下（CLAUDE.md 隔离原则第 3 条）。 */
export const EDITOR_CLASS = 'dsh-qqbot-library'

export const EDITOR_CSS = `
[role="dialog"].${EDITOR_CLASS} { width: min(960px, 100%); max-height: 100%; }
.${EDITOR_CLASS}.ql-section { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
.${EDITOR_CLASS} .ql-section-head { display: flex; align-items: center; gap: 12px; }
.${EDITOR_CLASS} .ql-section-head .ql-note { flex: 1; margin: 0; }
.${EDITOR_CLASS}.ql-section .ql-main { height: auto; min-height: 480px; }
.${EDITOR_CLASS}.ql-section .ql-list { flex-basis: 150px; }
.${EDITOR_CLASS} .ql-body { display: flex; flex-direction: column; gap: 10px; }
.${EDITOR_CLASS} .ql-tabs { display: flex; gap: 6px; }
.${EDITOR_CLASS} .ql-main { display: flex; gap: 12px; height: 64vh; min-height: 320px; }
.${EDITOR_CLASS} .ql-list { flex: 0 0 200px; display: flex; flex-direction: column; gap: 2px; overflow: auto; border-right: 0.5px solid var(--dsw-alias-border-l2); padding-right: 8px; }
.${EDITOR_CLASS} .ql-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-sm); background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.${EDITOR_CLASS} .ql-row:hover { background: var(--dsw-alias-bg-layer-1); }
.${EDITOR_CLASS} .ql-row[aria-current="true"] { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.${EDITOR_CLASS} .ql-row .ql-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${EDITOR_CLASS} .ql-form { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 4px; }
.${EDITOR_CLASS} .ql-field { display: flex; flex-direction: column; gap: 4px; }
.${EDITOR_CLASS} .ql-field > span { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.${EDITOR_CLASS} .ql-field > small, .${EDITOR_CLASS} .ql-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.${EDITOR_CLASS} .ql-field input, .${EDITOR_CLASS} .ql-field select, .${EDITOR_CLASS} .ql-field textarea {
  padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.${EDITOR_CLASS} .ql-field input:disabled { color: var(--dsw-alias-label-secondary); }
.${EDITOR_CLASS} .ql-field textarea { resize: vertical; font-family: var(--dsw-font-mono, monospace); font-size: 12px; line-height: 18px; }
.${EDITOR_CLASS} .ql-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${EDITOR_CLASS} .ql-state { padding: 6px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${EDITOR_CLASS} .ql-warn { color: var(--dsw-alias-state-warn-label); }
.${EDITOR_CLASS} .ql-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.${EDITOR_CLASS} .ql-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px 16px; }
.${EDITOR_CLASS} .ql-toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.${EDITOR_CLASS} .ql-avatar { width: 40px; height: 40px; border-radius: 50%; corner-shape: round; object-fit: cover; flex: none; }
.${EDITOR_CLASS} .ql-avatar-initial { display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }
.${EDITOR_CLASS} .ql-background { height: 56px; max-width: 120px; border-radius: var(--dsw-radius-sm); object-fit: cover; }
`

export type EditorTab = 'roles' | 'presets' | 'ui' | 'voice'

/** 打开编辑器时要定位到的条目；id 为空时选第一个。 */
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

function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return <label className="ql-field">
    <span>{label}</span>
    {children}
    {hint !== undefined && <small>{hint}</small>}
  </label>
}

/** 多选一组复选框。value 按 choices 的顺序；一个都不选时传 undefined。 */
function ChoiceField<T extends string>({ label, hint, choices, labels, value, onChange }: {
  readonly label: string; readonly hint: string; readonly choices: readonly T[]; readonly labels: Record<T, string>
  readonly value: readonly T[] | undefined; readonly onChange: (value: readonly T[] | undefined) => void
}) {
  const selected = new Set(value)
  return <div className="ql-field">
    <span>{label}</span>
    <div className="ql-actions">
      {choices.map(choice => <label key={choice} className="ql-toggle">
        <input type="checkbox" checked={selected.has(choice)} onChange={(event) => {
          const next = choices.filter(c => c === choice ? event.target.checked : selected.has(c))
          onChange(next.length === 0 ? undefined : next)
        }} />
        <span>{labels[choice]}</span>
      </label>)}
    </div>
    <small>{hint}</small>
  </div>
}

const BLANK_ROLE: LibraryRoleDraft = { name: '', description: '', persona: '' }
const BLANK_PRESET: LibraryPresetDraft = { name: '', head: '', mid: '', tail: '' }

interface FormProps {
  readonly view: LibraryView
  readonly ui: UiState
  readonly voice: VoiceState
  readonly busy: boolean
  readonly onDirty: (dirty: boolean) => void
  /** 成功时返回操作后的数据，失败时为 undefined（错误已显示）。 */
  readonly run: (action: LibraryAction) => Promise<LibraryView | undefined>
}

/** 角色表单。role 为空表示新建；保存成功后由父组件换 key 重新挂载。 */
function RoleForm({ view, ui, voice, busy, onDirty, run, role, template, onSaved, onRemoved, onManageVoices }: FormProps & {
  readonly role: LibraryRole | undefined
  readonly template: LibraryRoleDraft
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
  readonly onManageVoices: () => void
}) {
  const create = role === undefined
  const [draft, setDraft] = useState<LibraryRoleDraft>(role ?? template)
  const [confirming, setConfirming] = useState(false)
  const edit = (patch: Partial<LibraryRoleDraft>) => { setDraft(d => ({ ...d, ...patch })); onDirty(true) }
  const save = async () => {
    // 新建时 id 由服务端生成，从返回值里拿。
    const saved = (await run({ action: 'role.save', create, role: draft }))?.saved
    if (saved !== undefined) onSaved(saved)
  }
  const isDefault = !create && view.defaultRole === role.id

  return <div className="ql-form">
    <Field label="名称" hint="不能和别的角色重名。">
      <input value={draft.name} data-modal-autofocus={create ? '' : undefined} onChange={(event) => { edit({ name: event.target.value }) }} />
    </Field>
    <RoleAvatarField ui={ui} role={role} />
    <Field label="简介" hint="只在角色列表和 /role 里显示，不进提示词。">
      <input value={draft.description} onChange={(event) => { edit({ description: event.target.value }) }} />
    </Field>
    <Field label="角色设定" hint="设定、性格、说话方式、示例对话。通用规则（例如成年人声明）写在破限预设里，不用在这里重复。">
      <textarea rows={14} value={draft.persona} onChange={(event) => { edit({ persona: event.target.value }) }} />
    </Field>
    <Field label="表情频率" hint="装了 dsh-meme 时生效。随角色保存，改动让这个角色的会话下一轮从表情规则开始缓存失效。">
      <select value={draft.memeFrequency ?? ''} onChange={(event) => {
        const value = MEME_FREQUENCIES.find(f => f === event.target.value)
        setDraft(({ memeFrequency: _, ...rest }) => value === undefined ? rest : { ...rest, memeFrequency: value })
        onDirty(true)
      }}>
        <option value="">默认（{MEME_FREQUENCY_LABELS[DEFAULT_MEME_FREQUENCY]}）</option>
        {MEME_FREQUENCIES.map(f => <option key={f} value={f}>{MEME_FREQUENCY_LABELS[f]}</option>)}
      </select>
    </Field>
    <Field label="联动主动性上限" hint="装了设备插件时生效。实际档位取这里和联动设置里较低的一个。">
      <select value={draft.proactivity ?? 'high'} onChange={(event) => {
        // 高主动等于不限，不写进角色卡。
        const value = ROLE_PROACTIVITIES.find(p => p === event.target.value && p !== 'high')
        setDraft(({ proactivity: _, ...rest }) => value === undefined ? rest : { ...rest, proactivity: value })
        onDirty(true)
      }}>
        {ROLE_PROACTIVITIES.map(p => <option key={p} value={p}>{ROLE_PROACTIVITY_LABELS[p]}</option>)}
      </select>
    </Field>
    <ChoiceField label="偏好动作" hint="装了设备插件时生效。只是倾向，用户的要求优先；不选表示没有偏好。"
      choices={MOTION_ACTIONS} labels={MOTION_ACTION_LABELS} value={draft.motionActions}
      onChange={(value) => { setDraft(({ motionActions: _, ...rest }) => value === undefined ? rest : { ...rest, motionActions: value }); onDirty(true) }} />
    <ChoiceField label="偏好范围" hint="同上。滑动只在全行程、下半程、上半程里生效。"
      choices={MOTION_RANGES} labels={MOTION_RANGE_LABELS} value={draft.motionRanges}
      onChange={(value) => { setDraft(({ motionRanges: _, ...rest }) => value === undefined ? rest : { ...rest, motionRanges: value }); onDirty(true) }} />
    <RoleVoiceField voice={voice} value={draft.voice} onManage={onManageVoices}
      onChange={(value) => { setDraft(({ voice: _, ...rest }) => value === undefined ? rest : { ...rest, voice: value }); onDirty(true) }} />
    {!create && <Field label="破限预设" hint="改了立即保存。">
      <select value={role.preset ?? ''} disabled={busy}
        onChange={(event) => { void run({ action: 'role.preset', id: role.id, ...event.target.value === '' ? {} : { preset: event.target.value } }) }}>
        <option value="">跟随默认（{view.presets.find(p => p.id === view.defaultPreset)?.name ?? view.defaultPreset}）</option>
        {view.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
    </Field>}
    <div className="ql-actions">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{create ? '创建角色' : '保存'}</Button>
      {!create && <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { void run(isDefault ? { action: 'role.default' } : { action: 'role.default', id: role.id }) }}>
        {isDefault ? '取消新会话默认' : '设为新会话默认'}
      </Button>}
      {!create && !confirming && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setConfirming(true) }}>删除</Button>}
    </div>
    {!create && confirming && <div className="ql-state ql-warn">
      <span>角色文件会移到 qqbot/roles-trash/，可以手动放回。正在用这个角色的会话之后按无角色运行，放回后恢复。</span>
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { void run({ action: 'role.remove', id: role.id }).then((ok) => { if (ok) onRemoved() }) }}>确认删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>取消</Button>
    </div>}
    <div className="ql-note">
      {create
        ? `保存到 ${view.rolesDir}。`
        : '角色文件里手写的其他字段原样保留。删除角色时头像一起移到回收站。'}
      {' '}保存后下一条消息起生效。正在用这个角色的会话，下一轮前缀缓存从角色设定开始失效。
    </div>
  </div>
}

/** 破限预设表单。preset 为空表示新建（template 是空白或复制来源）。 */
function PresetForm({ view, busy, onDirty, run, preset, template, onSaved, onRemoved, onCopy }: FormProps & {
  readonly preset: LibraryPreset | undefined
  readonly template: LibraryPresetDraft
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
  readonly onCopy: (draft: LibraryPresetDraft) => void
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

  return <div className="ql-form">
    <Field label="名称" hint="不能和别的预设重名。">
      <input value={draft.name} data-modal-autofocus={create ? '' : undefined} onChange={(event) => { edit({ name: event.target.value }) }} />
    </Field>
    <Field label="开头" hint="放在系统提示词最前面，角色设定之前。">
      <textarea rows={6} value={draft.head} onChange={(event) => { edit({ head: event.target.value }) }} />
    </Field>
    <Field label="中间" hint="紧跟在角色设定之后。">
      <textarea rows={4} value={draft.mid} onChange={(event) => { edit({ mid: event.target.value }) }} />
    </Field>
    <Field label="结尾" hint="放在系统提示词最后。">
      <textarea rows={4} value={draft.tail} onChange={(event) => { edit({ tail: event.target.value }) }} />
    </Field>
    {!create && <div className="ql-note">
      {isDefault ? '这是默认预设，没有单独选择的角色和无角色会话都用它。' : '不是默认预设。'}
      {' '}使用它的角色：{users.length === 0 ? '无' : users.map(role => role.name).join('、')}
    </div>}
    <div className="ql-actions">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{create ? '创建预设' : '保存'}</Button>
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { const { id: _, ...copy } = draft; onCopy({ ...copy, name: uniqueName(`${draft.name || '预设'} 副本`, view.presets) }) }}>
        复制为新预设
      </Button>
      {!create && !isDefault && <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { void run({ action: 'preset.default', id: preset.id }) }}>设为默认</Button>}
      {!create && !confirming && <Button size="sm" variant="ghost" disabled={busy || view.presets.length <= 1}
        title={view.presets.length <= 1 ? '至少要保留一份预设' : undefined} onClick={() => { setConfirming(true) }}>删除</Button>}
    </div>
    {!create && confirming && <div className="ql-state ql-warn">
      <span>删除后不能恢复。选了它的角色改回跟随默认{isDefault ? '；它是默认预设，默认会改为剩下的第一份' : ''}。</span>
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { void run({ action: 'preset.remove', id: preset.id }).then((ok) => { if (ok) onRemoved() }) }}>确认删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>取消</Button>
    </div>}
    <div className="ql-note">
      保存后下一条消息起生效。改开头段，用这份预设的会话下一轮整个系统提示词的缓存失效；改中间或结尾，从改动处开始失效。
    </div>
  </div>
}

/** 列表里选中的条目：已有条目的 id，或一份还没保存的新条目。 */
type Selection<T> = { readonly id: string } | { readonly draft: T }

/** 编辑器内容和关闭前的检查：有未保存的改动时，guard 先显示确认，确认后才执行。 */
function useLibraryEditor(target: EditorTarget, ui: UiState, voice: VoiceState): { readonly guard: (next: () => void) => void; readonly content: ReactNode } {
  const [view, setView] = useState<LibraryView | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<EditorTab>(target.tab)
  const [roleSel, setRoleSel] = useState<Selection<LibraryRoleDraft> | undefined>(
    target.tab === 'roles' && target.id !== undefined ? { id: target.id } : undefined)
  const [presetSel, setPresetSel] = useState<Selection<LibraryPresetDraft> | undefined>(
    target.tab === 'presets' && target.id !== undefined ? { id: target.id } : undefined)
  // 有未保存的改动时，切换和关闭要先确认。pending 是确认后要做的事。
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<(() => void) | undefined>()
  // 保存后加一，表单换 key 重新挂载，读到服务端规范化后的内容。
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    request(undefined, abort.signal).then(setView, (error: unknown) => { if (!abort.signal.aborted) setLoadError(messageOf(error)) })
    return () => { abort.abort() }
  }, [])

  const run = useCallback(async (action: LibraryAction): Promise<LibraryView | undefined> => {
    setBusy(true)
    setActionError(undefined)
    try {
      const next = await request(action)
      setView(next)
      // 名称变了头像首字跟着变，删了角色要去掉头像，改了默认角色时还没开始的会话跟着变：让各会话重读当前角色。
      if (action.action === 'role.save' || action.action === 'role.remove' || action.action === 'role.default') ui.forgetRoles()
      return next
    } catch (error) {
      setActionError(messageOf(error))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [ui])

  const guard = (next: () => void) => {
    if (dirty) setPending(() => next)
    else next()
  }
  const go = (next: () => void) => { guard(() => { setDirty(false); setActionError(undefined); next() }) }
  const saved = (select: () => void) => { setDirty(false); select(); setRevision(n => n + 1) }

  const body = (() => {
    if (loadError !== undefined) return <div className="ql-state ql-warn">{loadError}</div>
    if (view === undefined) return <div className="ql-empty">加载中…</div>
    const formProps = { view, ui, voice, busy, onDirty: setDirty, run }
    if (tab === 'ui') return <div className="ql-main"><UiForm ui={ui} /></div>
    if (tab === 'voice') return <VoicePage voice={voice} onDirty={setDirty} guard={guard} />
    if (tab === 'roles') {
      const selected = roleSel ?? (view.roles[0] === undefined ? { draft: BLANK_ROLE } : { id: view.roles[0].id })
      const role = 'id' in selected ? view.roles.find(r => r.id === selected.id) : undefined
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
        {'id' in selected && role === undefined
          ? <div className="ql-empty">这个角色已经不在角色库里，可能已在文件里删除。</div>
          : <RoleForm key={`${role?.id ?? 'new'}:${revision}`} {...formProps} role={role}
            template={'draft' in selected ? selected.draft : BLANK_ROLE}
            onSaved={(id) => { saved(() => { setRoleSel({ id }) }) }}
            onRemoved={() => { saved(() => { setRoleSel(undefined) }) }}
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
          onCopy={(draft) => { go(() => { setPresetSel({ draft }) }) }} />}
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
      </div>
      {pending !== undefined && <div className="ql-state ql-warn">
        <span>有没保存的改动。</span>
        <Button size="sm" variant="outline" onClick={() => { const next = pending; setPending(undefined); setDirty(false); next() }}>放弃改动</Button>
        <Button size="sm" variant="ghost" onClick={() => { setPending(undefined) }}>继续编辑</Button>
      </div>}
      {actionError !== undefined && <div className="ql-state ql-warn">{actionError}</div>}
      {body}
    </div>
  return { guard, content }
}

const DESCRIPTION = '只用于 QQ Bot 会话。也可以直接编辑文件，打开这里或执行 /role 时重新读取。'

function LibraryDialog({ target, ui, voice, onClose }: {
  readonly target: EditorTarget; readonly ui: UiState; readonly voice: VoiceState; readonly onClose: () => void
}) {
  const { guard, content } = useLibraryEditor(target, ui, voice)
  return <Modal open onClose={() => { guard(onClose) }} title="QQ Bot 设置" closeLabel="关闭" className={EDITOR_CLASS} description={DESCRIPTION}>
    {content}
  </Modal>
}

export interface LibrarySettingsInjected {
  readonly ui: UiState
  readonly voice: VoiceState
  readonly startQqSession: () => void
}

/**
 * DSH 设置窗口里的"QQ Bot"页。设置窗口的关闭由 DSH 管，拦不住，所以这里关窗口会丢掉没保存的改动；
 * 页内切换标签和条目照常确认。
 */
export function LibrarySettingsSection({ close, ui, voice, startQqSession }: PropsRuntime<'settings.section'> & InjectFace<LibrarySettingsInjected>) {
  const { content } = useLibraryEditor(ROLES, ui, voice)
  return <div className={`${EDITOR_CLASS} ql-section`}>
    <div className="ql-section-head">
      <p className="ql-note">{DESCRIPTION}</p>
      <Button size="sm" variant="outline" onClick={() => { close(); startQqSession() }}>新建 QQ 会话</Button>
    </div>
    {content}
  </div>
}

const ROLES: EditorTarget = { tab: 'roles' }

export interface LibraryEditorInjected {
  readonly hooks: { readonly editorTarget: SnapshotStore<EditorTarget | null> }
  readonly closeEditor: () => void
  readonly ui: UiState
  readonly voice: VoiceState
}

/** `shell.overlay` 里的常驻组件：没有打开时什么也不渲染。target 变化时换 key，重新加载。 */
export function LibraryEditorHost({ useEditorTarget, closeEditor, ui, voice }: InjectFace<LibraryEditorInjected>) {
  const target = useEditorTarget(state => state)
  if (target === null) return null
  return <LibraryDialog key={`${target.tab}:${target.id ?? ''}`} target={target} ui={ui} voice={voice} onClose={closeEditor} />
}
