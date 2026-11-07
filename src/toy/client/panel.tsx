/**
 * 设备插件的界面：输入栏暂停按钮、首次授权、设置面板。只在 qqbot 会话里出现。
 * 所有样式收在 ROOT_CLASS 下（CLAUDE.md 隔离原则第 3 条）。
 *
 * 设置面板的布局参考 dsh-serveu 的 client/index.jsx（ToyPanel）和 controls.jsx（Authorization、ConversationSettings），
 * 按新的设置格式重写：设置存 host，简单参数自动保存，独立内容一次保存；连接和接入立即生效。
 */

import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { DEFAULT_BURST, type BurstSettings, type ToySettings } from '../api-types.ts'
import { HARD_LIMITS, parseMotion, speedBands, type MotionConfig } from '../core/config.ts'
import { hotkeyFromEvent, hotkeyLabel, NO_HOTKEY, RECOMMENDED_HOTKEY } from '../core/hotkey.ts'
import { DEFAULT_BEHAVIOR, MAX_BEHAVIOR_LENGTH } from '../core/rules.ts'
import type { ToyController, ToySnapshot, TransportKind } from './controller.ts'
import { TextEditor } from '../../client/text-editor.tsx'
import { SwitchRow } from '../../client/switch.tsx'
import { PresetPools } from './preset-library.tsx'
import { mergeSettings } from './settings-merge.ts'
import { parseActionLibrary, type ActionLibrary } from '../motion-library/config.ts'
import { DEFAULT_SAFETY_WORDS, MAX_SAFETY_WORD_LENGTH, MAX_SAFETY_WORDS, parseSafetyWords, type SafetyWords } from '../core/safety-words.ts'
import { chatActivity, submissionActivity } from '../../vendor/dialogue-timing/interruptions.js'

/** dsh-qqbot 注册的预设 id。按值比较，不引用 dsh-qqbot 的代码。 */
export const QQBOT_PRESET = 'qqbot'
export const ROOT_CLASS = 'dsh-toy-buttplug'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 连接方式和服务地址只跟这台浏览器有关，存在 localStorage。 */
export interface ConnectionPrefs {
  readonly kind: TransportKind
  readonly address: string
}

export interface ToyInjected {
  readonly controller: ToyController
  readonly connection: { get(): ConnectionPrefs; set(prefs: ConnectionPrefs): void }
}

export function useToy(controller: ToyController): ToySnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}

type ButtonProps = PropsRuntime<'conversation.input.left'> & InjectFace<ToyInjected>

/** 输入栏左侧不可关闭的暂停／继续按钮。标准会话里渲染 null。 */
export function ToyButton(props: ButtonProps) {
  const preset = props.useSessions((state) => {
    // agentPreset 来自 agent-preset-registry 的 projection；按字段名读，不为它多引一个包。
    const value = (state.byId[props.sessionId]?.projectionValues as Record<string, unknown> | undefined)?.['agentPreset']
    return typeof value === 'string' ? value : undefined
  })
  if (preset !== QQBOT_PRESET) return null
  return <QqbotToyButton {...props} />
}

function QqbotToyButton({ sessionId, controller, useChat, useSession }: ButtonProps) {
  const toy = useToy(controller)
  const chat = useChat(chatActivity)
  const submissions = useSession(submissionActivity)
  useLayoutEffect(() => { controller.observeInput(sessionId, chat, submissions) }, [controller, sessionId, chat, submissions, toy.owner])
  if (!toy.enabled) return null
  const mine = sessionId !== undefined && toy.owner === sessionId
  if (!mine) return null
  return <span className={ROOT_CLASS}>
    {toy.paused
      ? <button type="button" className="tb-trigger" onClick={() => { controller.resume() }}>继续设备</button>
      : <button type="button" className="tb-trigger" onClick={() => { controller.pause() }}>暂停设备</button>}
  </span>
}

/** 首次授权。建议起步值：行程 0–50，速度上限 300。暂停快捷键默认不设，这里推荐用户勾选设好。 */
export function Consent({ controller, close, accept }: { controller: ToyController; close: () => void; accept: () => void }) {
  const toy = useToy(controller)
  const [recommended, setRecommended] = useState(true)
  const [pauseKey, setPauseKey] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    const settings = toy.settings
    if (settings === undefined) { setError(toy.loadError || '设置还没读到，请稍后再试'); return }
    const motion: MotionConfig = recommended
      ? { ...settings.motion, minPosition: 0, maxPosition: 50, maxSpeed: 300, speedBreakpoints: [100, 200] }
      : settings.motion
    try {
      const hotkey = pauseKey && settings.resumeHotkey !== RECOMMENDED_HOTKEY ? RECOMMENDED_HOTKEY : settings.hotkey
      await controller.saveSettings({ ...settings, authorized: true, motion, hotkey })
      accept()
    } catch (reason) {
      setError(`保存失败：${messageOf(reason)}`)
    }
  }
  return <Modal open onClose={close} title="首次联动授权" headless className={`${ROOT_CLASS} tb-window`}>
    <div className="tb-header"><h2>首次联动授权</h2></div>
    <div className="tb-scroll">
      <p>授权后，你将把设备控制权交给 AI，使用风险由你自行承担。请提前设置好行程范围和速度上限，需要停止时请使用暂停按钮或快捷键。</p>
      <SwitchRow label="使用建议起步值：行程 0–50，速度上限 300" title="之后可以按体验逐步放大"
        checked={recommended} onChange={setRecommended} />
      {toy.settings?.hotkey === NO_HOTKEY && <SwitchRow label={`设置暂停快捷键 ${hotkeyLabel(RECOMMENDED_HOTKEY)}（推荐）`}
        title="已经用 ServeUCentral 等外部急停时不用设" checked={pauseKey} onChange={setPauseKey} />}
      {error !== '' && <p className="tb-error" role="alert">{error}</p>}
    </div>
    <div className="tb-footer qq-settings-actions">
      <Button variant="outline" onClick={close}>暂不开启</Button>
      <Button variant="primary" disabled={toy.busy} onClick={() => { void confirm() }}>同意授权并设置</Button>
    </div>
  </Modal>
}

/** 面板里可编辑的设置。 */
interface Draft {
  readonly actionLibrary?: ActionLibrary | undefined
  readonly motion: MotionConfig
  readonly behavior: string
  readonly hotkey: string
  readonly resumeHotkey: string
  readonly burst: BurstSettings
  readonly safetyWords: SafetyWords
}

const draftOf = (settings: ToySettings, actionLibrary?: ActionLibrary): Draft => ({
  ...actionLibrary === undefined ? {} : { actionLibrary },
  motion: settings.motion, behavior: settings.behavior, hotkey: settings.hotkey, resumeHotkey: settings.resumeHotkey ?? '',
  burst: settings.burst ?? DEFAULT_BURST,
  safetyWords: settings.safetyWords ?? DEFAULT_SAFETY_WORDS,
})

function settingsOf(base: ToySettings, draft: Draft): ToySettings {
  const { resumeHotkey: _resumeHotkey, ...rest } = base
  return {
    ...rest, motion: draft.motion, behavior: draft.behavior, hotkey: draft.hotkey,
    ...draft.resumeHotkey === '' ? {} : { resumeHotkey: draft.resumeHotkey },
    burst: draft.burst,
    safetyWords: draft.safetyWords,
  }
}

/** 保存前先在本地查一遍，提示和 host 相同。 */
function problemOf(draft: Draft): string {
  try {
    parseMotion(draft.motion)
    parseSafetyWords(draft.safetyWords)
    if (draft.actionLibrary !== undefined) parseActionLibrary(draft.actionLibrary)
    if (draft.resumeHotkey !== NO_HOTKEY && draft.resumeHotkey === draft.hotkey) throw new Error('恢复快捷键不能和暂停快捷键相同')
    if (draft.behavior.length > MAX_BEHAVIOR_LENGTH) throw new Error(`补充互动规则不超过 ${MAX_BEHAVIOR_LENGTH} 字`)
    return ''
  } catch (error) {
    return messageOf(error)
  }
}

interface PanelProps {
  readonly embedded?: boolean
  readonly afterReplySettings?: ReactNode
  readonly onDirty?: (dirty: boolean) => void
  readonly onBusy?: (busy: boolean) => void
  readonly controller: ToyController
  readonly close: () => void
}

let panelMemorySequence = 0
interface PanelMemory { id: number; generation: number; base: Draft; draft: Draft; inputs: Map<string, string>; status: string }
const panelMemories = new WeakMap<ToyController, PanelMemory>()
const InputMemory = createContext<{ inputs: Map<string, string>; changed: () => void } | undefined>(undefined)

export function ToyPanel({ controller, close, embedded = false, afterReplySettings, onDirty, onBusy }: PanelProps) {
  const toy = useToy(controller)
  const memory = useRef(panelMemories.get(controller))
  if (memory.current?.generation !== controller.settingsDraftGeneration) memory.current = undefined
  if (!memory.current && toy.settings) {
    const base = draftOf(toy.settings, toy.actionLibrary)
    memory.current = { id: ++panelMemorySequence, generation: controller.settingsDraftGeneration, base, draft: base, inputs: new Map(), status: '' }
    panelMemories.set(controller, memory.current)
  }
  const [, render] = useState(0)
  useEffect(() => {
    const discard = () => {
      panelMemories.delete(controller)
      memory.current = undefined
      render(n => n + 1)
      onDirty?.(false)
    }
    window.addEventListener('qqbot:discard-settings-drafts', discard)
    return () => window.removeEventListener('qqbot:discard-settings-drafts', discard)
  }, [controller, onDirty])
  const [saving, setSaving] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const state = memory.current
  const draft = state?.draft
  const changed = () => { render(n => n + 1); onDirty?.(true) }
  const dirty = state !== undefined && (JSON.stringify(state.base) !== JSON.stringify(state.draft) || state.inputs.size > 0)
  useEffect(() => { onDirty?.(dirty || editorOpen) }, [dirty, editorOpen, onDirty])
  useEffect(() => { onBusy?.(saving > 0); return () => { onBusy?.(false) } }, [saving, onBusy])
  useEffect(() => () => { onDirty?.(false) }, [onDirty])
  useEffect(() => {
    if (!toy.settings || !state) return
    const next = draftOf(toy.settings, toy.actionLibrary)
    state.draft = mergeSettings(state.base, state.draft, next)
    state.draft = { ...state.draft, actionLibrary: toy.actionLibrary }
    state.base = next
    render(n => n + 1)
  }, [toy.settings, toy.actionLibrary, state])
  const submit = async (before: Draft, after: Draft) => {
    if (!state) return
    const problem = problemOf(after)
    if (problem) { state.status = problem; changed(); return }
    setSaving(n => n + 1)
    state.status = ''
    try {
      await controller.updateSettings(latest => mergeSettings(settingsOf(latest, before), settingsOf(latest, after), latest))
      state.status = ''
    } catch (error) { state.status = `保存失败：${messageOf(error)}` }
    finally { setSaving(n => n - 1); render(n => n + 1) }
  }
  const edit = (patch: Partial<Draft>) => {
    if (!state) return
    const before = state.draft
    const next = { ...before, ...patch }
    state.draft = next
    changed()
    if (!('behavior' in patch)) void submit(before, next)
  }
  const retry = () => {
    if (state) void submit(state.base, { ...state.draft, behavior: state.base.behavior })
  }
  const revoke = async () => {
    setSaving(n => n + 1)
    try { await controller.updateSettings(latest => ({ ...latest, authorized: false })); close() }
    catch (error) { if (state) state.status = `撤回授权失败：${messageOf(error)}` }
    finally { setSaving(n => n - 1) }
  }
  const problem = draft ? problemOf(draft) : ''
  const pending = state && JSON.stringify({ ...state.base, behavior: '' }) !== JSON.stringify({ ...state.draft, behavior: '' })
  const footerStatus = saving > 0 ? '保存中…' : problem || (state?.status.startsWith('保存失败') ? state.status : '')
    || (state?.inputs.size ? '有未完成的输入' : dirty ? '有未保存的修改' : state?.status || '')
  const content = <>
    {!embedded && <div className="tb-header"><h2>联动设置</h2>
      <Button variant="outline" size="sm" disabled={saving > 0} onClick={close} aria-label="关闭联动设置">关闭</Button></div>}
    <div className="tb-scroll">
      {!draft || !state ? <p className="tb-error">{toy.loadError || '正在读取设置…'}</p>
        : <InputMemory.Provider value={{ inputs: state.inputs, changed }}><fieldset key={state.id} className="tb-draft">
          <MotionSection draft={draft} edit={edit} fine={false} controller={controller} onEditorOpen={setEditorOpen} />
          <MotionSection draft={draft} edit={edit} fine controller={controller} onEditorOpen={setEditorOpen} />
          <Section title="回复结束后" heading={false}>
            <AutoStopSection draft={draft} edit={edit} />
            {afterReplySettings}
          </Section>
          <StopSection draft={draft} edit={edit} />
          <SafetyWordsSection draft={draft} edit={edit} />
          <BehaviorSection draft={draft} edit={edit} saving={saving > 0} dirty={draft.behavior !== state.base.behavior}
            save={behavior => { edit({ behavior }); void submit(state.base, { ...state.base, behavior }) }}
            cancel={() => { state.draft = { ...state.draft, behavior: state.base.behavior }; state.status = ''; changed() }} />
          <AuthorizationSection toy={toy} saving={saving > 0 || dirty} revoke={() => { void revoke() }} />
        </fieldset></InputMemory.Provider>}
    </div>
    {(footerStatus || pending) && <div className="tb-footer qq-settings-actions">
      <span className="tb-footer-status qq-settings-status" role="status" data-error={problem !== '' || state?.status.startsWith('保存失败') || undefined}>
        {footerStatus}
      </span>
      {pending && !problem && <Button variant="outline" disabled={saving > 0} onClick={retry}>重试</Button>}
    </div>}
  </>
  return embedded ? <div className={`${ROOT_CLASS} qq-settings-scope tb-embedded`}>{content}</div>
    : <Modal open onClose={close} title="联动设置" headless className={`${ROOT_CLASS} qq-settings-scope tb-window tb-panel`}>{content}</Modal>
}

function Section({ title, heading = true, children }: {
  readonly title: string; readonly heading?: boolean; readonly children: ReactNode
}) {
  return <section className="tb-card qq-settings-card" aria-label={title}>{heading && <h3>{title}</h3>}{children}</section>
}

function AuthorizationSection({ toy, saving, revoke }: {
  toy: ToySnapshot
  saving: boolean; revoke: () => void
}) {
  const phase = toy.transport.phase
  const hardware = toy.transport.hardware
  return <Section title="设备授权" heading={false}>
    <div className="tb-compact-row">
    {hardware !== undefined && <p className="tb-hint">机内行程 {hardware.minPosition}–{hardware.maxPosition}，速度上限 {hardware.maxSpeed} unit/s</p>}
    <div className="tb-row qq-settings-row"><Button variant="outline" size="sm" disabled={saving || toy.busy} onClick={revoke}>撤回授权</Button></div>
    {(toy.transport.error !== '' || (phase !== 'ready' && toy.transport.message !== '')) && <p className="tb-hint" role="status" data-error={toy.transport.error !== '' || undefined}>
      {toy.transport.error || toy.transport.message}
    </p>}
    {toy.notice !== '' && <p className="tb-hint" role="status">{toy.notice}</p>}
    </div>
  </Section>
}

type EditProps = { readonly draft: Draft; readonly edit: (patch: Partial<Draft>) => void }

/** 单、双句柄共用轨道和圆点。分界只有刻度，没有“选中区间”。 */
function Slider({ label, labels, values, min, max, cuts, disabled = false, format = String, onChange }: {
  readonly label: string; readonly labels?: readonly [string, string]; readonly values: readonly number[]
  readonly min: number; readonly max: number; readonly cuts?: 'speed' | 'stroke'; readonly disabled?: boolean
  readonly format?: (value: number) => string; readonly onChange: (index: number, value: number) => void
}) {
  const [preview, setPreview] = useState(values)
  const pending = useRef<{ index: number; value: number }>()
  useEffect(() => { if (!pending.current) setPreview(values) }, [values.join(',')])
  const commit = () => {
    const next = pending.current
    pending.current = undefined
    if (next) onChange(next.index, next.value)
  }
  const at = (value: number) => `${Math.max(0, Math.min(100, (value - min) / Math.max(1, max - min) * 100))}%`
  return <div className="tb-slider qq-settings-slider" data-cuts={cuts || undefined} data-dual={values.length === 2 || undefined}
    style={{ '--tb-a': preview.length === 2 ? at(preview[0]!) : '0%', '--tb-b': at(preview.at(-1)!) } as CSSProperties}>
    <div className="tb-slider-track" />
    {preview.map((value, index) => <input key={index} type="range" min={min} max={max} step={1} value={value} disabled={disabled}
      aria-label={labels?.[index] ?? label} aria-valuetext={format(value)}
      style={{ zIndex: index === 0 && value > (min + max) / 2 ? 3 : index + 1 }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerUp={commit} onKeyUp={commit} onBlur={commit}
      onPointerCancel={() => { pending.current = undefined; setPreview(values) }}
      onChange={event => {
        const raw = Number(event.target.value)
        const next = values.length === 2 ? (index === 0 ? Math.min(raw, preview[1]! - 1) : Math.max(raw, preview[0]! + 1)) : raw
        pending.current = { index, value: next }
        setPreview(current => current.map((v, i) => i === index ? next : v))
      }} />)}
  </div>
}

/** Keep incomplete numeric input locally; commit only a valid blur/Enter value. */
function NumberRow({ label, hint, value, min, max, unit, compact = false, onChange }: {
  readonly label: string; readonly hint?: string | undefined; readonly value: number; readonly min: number; readonly max: number
  readonly unit?: string; readonly compact?: boolean; readonly onChange: (value: number) => void
}) {
  const memory = useContext(InputMemory)
  const [text, setText] = useState(memory?.inputs.get(label) ?? String(value))
  useEffect(() => { if (!memory?.inputs.has(label)) setText(String(value)) }, [value])
  const valid = text.trim() !== '' && Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max
  const commit = () => {
    if (!valid) return
    memory?.inputs.delete(label)
    if (Number(text) !== value) onChange(Number(text))
    memory?.changed()
  }
  return <div className={`tb-number qq-settings-number${compact ? ' tb-number-compact' : ''}`}>
    <span title={hint}>{label}</span>
    <div className="tb-number-control">
      {!compact && <Slider label={label} min={min} max={max} values={[Math.min(max, Math.max(min, value))]} format={n => `${n}${unit ?? ''}`}
        onChange={(_index, next) => { memory?.inputs.delete(label); setText(String(next)); onChange(next) }} />}
      <span className="tb-number-value"><input type="number" min={min} max={max} step={1} value={text} aria-label={`${label}数值`} aria-invalid={!valid || undefined}
        onChange={event => { const raw = event.target.value; setText(raw); memory?.inputs.set(label, raw); memory?.changed() }}
        onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
        {unit !== undefined && <small>{unit}</small>}</span>
    </div>
  </div>
}

/**
 * 双句柄滑条，用于成对的上下限和分界（迁移自 dsh-serveu 的 DualRange）。两个句柄至少隔 1。
 * 拖动预览留在滑条内，松手或键盘操作结束后提交。
 */
function DualRow({ label, hint, labels, value, min, max, format, onChange }: {
  readonly label: string; readonly hint?: string | undefined; readonly labels: readonly [string, string]
  readonly value: readonly [number, number]; readonly min: number; readonly max: number
  readonly format: (value: number) => string; readonly onChange: (value: [number, number]) => void
}) {
  const move = (index: 0 | 1, raw: number) => {
    const next: [number, number] = [value[0], value[1]]
    next[index] = index === 0 ? Math.min(raw, value[1] - 1) : Math.max(raw, value[0] + 1)
    if (next[index] !== value[index]) onChange(next)
  }
  return <div className="tb-dual">
    <span title={hint}>{label}</span>
    <Slider label={label} labels={labels} min={min} max={max} values={value}
      format={format} onChange={(index, value) => { move(index as 0 | 1, value) }} />
    <output>{format(value[0])} – {format(value[1])}</output>
  </div>
}

/** 参考旧版 DualRange：刻度跟随圆点，下面列出三段实际范围；速度三色，行程保持中性。 */
function DefinitionRow({ label, labels, kind, value, max, minCut, maxCut, format, ranges, onChange }: {
  readonly label: string; readonly labels: readonly [string, string]; readonly kind: 'speed' | 'stroke'
  readonly value: readonly [number, number]; readonly max: number; readonly minCut: number; readonly maxCut: number
  readonly format: (value: number) => string
  readonly ranges: readonly { readonly name: string; readonly value: string }[]
  readonly onChange: (value: [number, number]) => void
}) {
  const at = (n: number) => n / max * 100
  const close = at(value[1] - value[0]) < 18
  const markStyle = (percent: number): CSSProperties => ({
    left: `${percent}%`, transform: percent < 10 ? 'none' : percent > 90 ? 'translateX(-100%)' : 'translateX(-50%)',
  })
  const move = (index: number, raw: number) => {
    const next: [number, number] = [...value]
    const bounded = Math.max(minCut, Math.min(maxCut, raw))
    next[index as 0 | 1] = index === 0 ? Math.min(bounded, value[1] - 1) : Math.max(bounded, value[0] + 1)
    if (next[index as 0 | 1] !== value[index as 0 | 1]) onChange(next)
  }
  return <div className="tb-definition" data-kind={kind} role="group" aria-label={label}>
    <span className="tb-definition-label">{label}{kind === 'speed' && <small>unit/s</small>}</span>
    <div className="tb-definition-content">
      <Slider label={label} labels={labels} min={0} max={max} values={value} cuts={kind}
        format={(n) => kind === 'speed' ? `${n} unit/s` : `${n}%（相对行程）`} onChange={move} />
      <div className="tb-cut-values" aria-label={`${label}分界值`}>
        {close
          ? <output className="tb-cut-pair" style={markStyle(at((value[0] + value[1]) / 2))}>{format(value[0])} / {format(value[1])}</output>
          : value.map((n, index) => <output key={index} data-index={index} style={markStyle(at(n))}>{format(n)}</output>)}
      </div>
      <div className="tb-band-ranges" aria-label={`${label}分区`}>
        {ranges.map((range, index) => <span key={range.name} data-index={index}><span>{range.name}</span><output>{range.value}</output></span>)}
      </div>
    </div>
  </div>
}

/** 恢复旧版范围偏好的大卡片：标题在上、曲线在下，与动作卡片等宽。 */
function HighRangeChoices({ value, shrink, onChange, onShrink }: {
  readonly value: 'large' | 'local'; readonly shrink: number; readonly onChange: (value: 'large' | 'local') => void
  readonly onShrink: (value: number) => void
}) {
  const name = useId()
  return <div className="tb-high-choice" role="radiogroup" aria-label="高速偏好">
    <span>高速偏好</span>
    <div className="tb-high-cards">{(['large', 'local'] as const).map(preference => {
      const local = preference === 'local'
      const retained = 1 - shrink / 100
      const cycles = local ? Math.round(12 / retained) : 4
      const amplitude = local ? 26 / 3 * retained : 26
      const points = Array.from({ length: cycles * 2 + 1 }, (_, index) =>
        `${4 + index / (cycles * 2) * 232},${30 + (index % 2 === 0 ? amplitude : -amplitude)}`).join(' ')
      return <div key={preference} className="tb-high-card" data-selected={value === preference || undefined}>
        <label className="tb-high-card-select" title={local ? '根部、中段或龟头局部往返' : '全程或偏根部、偏龟头的半程往返'}>
        <span className="tb-high-card-title">
          <input type="radio" name={name} value={preference} aria-label={local ? '小行程高频' : '大行程高速'} checked={value === preference} onChange={() => { onChange(preference) }} />
          <span>{local ? '小行程高频' : '大行程高速'}</span>
        </span>
        <svg viewBox="0 0 240 60" preserveAspectRatio="none" role="img" aria-label={`${local ? '小行程高频' : '大行程高速'}示意曲线`}>
          <path d="M4 4H236M4 30H236M4 56H236" fill="none" stroke="currentColor" opacity=".15" />
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        </label>
        {local && value === 'local' && <div className="tb-high-card-footer">
          <NumberRow label="行程缩短" hint="仅高速时，围绕所选行程的中点额外缩短"
            value={shrink} min={0} max={90} unit="%" onChange={onShrink} />
        </div>}
      </div>
    })}</div>
  </div>
}

function MotionSection({ draft, edit, fine, controller, onEditorOpen }: EditProps & { readonly fine: boolean; controller: ToyController; onEditorOpen: (open: boolean) => void }) {
  const motion = draft.motion
  const set = (patch: Partial<MotionConfig>) => { edit({ motion: { ...motion, ...patch } }) }
  return <Section title={fine ? '动作细调' : '行程和速度'}>
    {!fine && <>
    <DualRow label="行程" hint="下限是根部：深插到底、顶住研磨；上限是龟头" labels={['行程下限（根部）', '行程上限（龟头）']}
      value={[motion.minPosition, motion.maxPosition]} min={HARD_LIMITS.minPosition} max={HARD_LIMITS.maxPosition}
      format={String} onChange={([minPosition, maxPosition]) => { set({ minPosition, maxPosition }) }} />
    <NumberRow label="速度上限" value={motion.maxSpeed} min={HARD_LIMITS.minSpeed} max={HARD_LIMITS.maxSpeed} unit="unit/s"
      onChange={(value) => { set({ maxSpeed: value }) }} />
    </>}
    {fine && <MotionFineControls motion={motion} set={set} actionLibrary={draft.actionLibrary} controller={controller} onEditorOpen={onEditorOpen} />}
  </Section>
}

/** 设置页与右栏共用分区和预设入口。 */
export function MotionFineControls({ motion, set, actionLibrary, controller, onEditorOpen, disabled = false }: {
  motion: MotionConfig; set: (patch: Partial<MotionConfig>) => void; actionLibrary: ActionLibrary | undefined
  controller: ToyController; onEditorOpen: (open: boolean) => void; disabled?: boolean
}) {
  const bands = useMemo(() => { try { return speedBands(motion) } catch { return undefined } }, [motion])
  // 显示按当前上限实际生效的分界；拖动后存的就是看到的值。
  const cuts: [number, number] = bands === undefined ? [...motion.speedBreakpoints] : [bands.low, bands.high]
  const span = motion.maxPosition - motion.minPosition
  const stroke = (percent: number) => Number((motion.minPosition + span * percent / 100).toFixed(1))
  const [lower, upper] = motion.rangeBreakpoints
  const speedInterval = (min: number, max: number) => min <= max ? `${min}–${max}` : '不可用'
  return <>
    <DefinitionRow label="部位分界" kind="stroke" labels={['根部与中段的分界', '中段与龟头的分界']}
      value={motion.rangeBreakpoints} max={100} minCut={1} maxCut={99}
      ranges={[
        { name: '根部', value: `${motion.minPosition}–${stroke(lower)}` },
        { name: '中段', value: `${stroke(lower)}–${stroke(upper)}` },
        { name: '龟头', value: `${stroke(upper)}–${motion.maxPosition}` },
      ]}
      format={(percent) => `${percent}%`} onChange={(rangeBreakpoints) => { set({ rangeBreakpoints }) }} />
    <DefinitionRow label="快慢定义" kind="speed" labels={['慢与中的分界', '中与快的分界']} value={cuts} max={motion.maxSpeed}
      minCut={motion.maxSpeed === 2 ? 0 : 1} maxCut={motion.maxSpeed - 1}
      ranges={[
        { name: '慢速', value: speedInterval(1, cuts[0] - 1) },
        { name: '中速', value: speedInterval(Math.max(1, cuts[0]), cuts[1] - 1) },
        { name: '高速', value: speedInterval(cuts[1], motion.maxSpeed) },
      ]}
      format={String} onChange={(speedBreakpoints) => { set({ speedBreakpoints }) }} />
    {actionLibrary !== undefined && <PresetPools value={actionLibrary} controller={controller} onOpen={onEditorOpen}
      highPreference={<fieldset className="tb-high-preference tb-draft" disabled={disabled}>
        <HighRangeChoices value={motion.tiers.high.rangePreference} shrink={motion.tiers.high.localShrinkPercent} onChange={rangePreference => {
            set({ tiers: { ...motion.tiers, high: { ...motion.tiers.high, rangePreference } } })
          }} onShrink={(value) => {
            set({ tiers: { ...motion.tiers, high: { ...motion.tiers.high, localShrinkPercent: value } } })
          }} />
      </fieldset>} />}
  </>
}

/** 点一下开始录入，按下组合键即保存。Escape、Tab 照常用于关闭和切换焦点。退格或"清除"去掉快捷键。 */
function HotkeyField({ label, value, recommended, onChange }: {
  readonly label: string; readonly value: string; readonly recommended?: string
  readonly onChange: (value: string) => void
}) {
  const [recording, setRecording] = useState(false)
  const clear = () => { onChange(NO_HOTKEY) }
  return <div className="tb-row qq-settings-row">
    <input className="tb-hotkey" data-toy-hotkey="" readOnly aria-label={label}
      value={recording ? '请按下快捷键…' : value === NO_HOTKEY ? '未设置' : hotkeyLabel(value)}
      onFocus={() => { setRecording(true) }} onBlur={() => { setRecording(false) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') return
        event.preventDefault()
        if (event.key === 'Backspace' || event.key === 'Delete') {
          setRecording(false); event.currentTarget.blur()
          if (value !== NO_HOTKEY) clear()
          return
        }
        event.stopPropagation()
        const next = hotkeyFromEvent(event.nativeEvent)
        if (next !== undefined) { onChange(next); setRecording(false); event.currentTarget.blur() }
      }} />
    <Button variant="outline" disabled={value === NO_HOTKEY} onClick={clear}>清除</Button>
    {recommended !== undefined && <Button variant="outline" disabled={value === recommended} onClick={() => { onChange(recommended) }}>
      推荐 {hotkeyLabel(recommended)}</Button>}
  </div>
}

const PAUSE_HINT = '设备和文字一起暂停。带 Ctrl、Alt 或 Meta 的组合键在输入框里也有效'

function AutoStopSection({ draft, edit }: EditProps) {
  const motion = draft.motion
  const standby = motion.standby
  const mode = standby !== undefined ? 'standby' : motion.autoStopSeconds === 0 ? 'none' : 'stop'
  // 切换处理方式时暂存细调，重新选回可继续编辑；保存格式仍只包含当前模式。
  const lastStandby = useRef(standby)
  const lastWait = useRef(motion.autoStopSeconds || 30)
  if (standby !== undefined) lastStandby.current = standby
  if (motion.autoStopSeconds) lastWait.current = motion.autoStopSeconds
  const set = (patch: Partial<MotionConfig>) => { edit({ motion: { ...motion, ...patch } }) }
  return <>
    <div className="tb-compact-row">
    <label className="tb-compact-field"><span>回复结束后</span><select aria-label="回复结束后" value={mode} onChange={event => {
      const { standby: _standby, ...base } = motion
      const next = event.target.value
      edit({ motion: { ...base, autoStopSeconds: next === 'none' ? 0 : lastWait.current,
        ...next === 'standby' ? { standby: lastStandby.current ?? { preset: draft.actionLibrary?.library.clips[0]?.name ?? '', minPosition: motion.minPosition, maxPosition: motion.maxPosition, maxSpeed: Math.min(50, motion.maxSpeed) } } : {} } })
    }}><option value="stop">延时停止</option><option value="none">持续当前动作</option><option value="standby">转入待机</option></select></label>
    {mode !== 'none' && <NumberRow compact label="等待时间" value={motion.autoStopSeconds ?? 30} min={1} max={86400} unit="秒" onChange={autoStopSeconds => { set({ autoStopSeconds }) }} />}
    </div>
    {standby !== undefined && <>
      <label className="tb-compact-field"><span>待机动作</span><select aria-label="待机动作" value={standby.preset} onChange={event => { set({ standby: { ...standby, preset: event.target.value } }) }}>
        {draft.actionLibrary?.library.clips.filter(clip => clip.points.length >= 3 && Math.abs(clip.points[0]!.pos - clip.points.at(-1)!.pos) <= 1e-6).map(clip => <option key={clip.id} value={clip.name}>{clip.name}</option>)}
      </select></label>
      <details className="tb-fold tb-subsettings qq-settings-fold">
        <summary>待机细调</summary>
        <DualRow label="待机行程" labels={['待机行程下限', '待机行程上限']} value={[standby.minPosition, standby.maxPosition]} min={motion.minPosition} max={motion.maxPosition} format={String}
          onChange={([minPosition, maxPosition]) => { set({ standby: { ...standby, minPosition, maxPosition } }) }} />
        <NumberRow label="待机速度" value={standby.maxSpeed} min={2} max={motion.maxSpeed} unit="unit/s" onChange={maxSpeed => { set({ standby: { ...standby, maxSpeed } }) }} />
      </details>
    </>}
  </>
}

function StopSection({ draft, edit }: EditProps) {
  return <Section title="快捷键">
    <div className="tb-hotkey-row"><span title={PAUSE_HINT}>暂停快捷键</span>
      <HotkeyField label="暂停快捷键" value={draft.hotkey} recommended={RECOMMENDED_HOTKEY} onChange={(hotkey) => { edit({ hotkey }) }} />
    </div>
    <div className="tb-hotkey-row"><span title='不设时点"继续"恢复'>恢复快捷键</span>
      <HotkeyField label="恢复快捷键" value={draft.resumeHotkey} onChange={(resumeHotkey) => { edit({ resumeHotkey }) }} />
    </div>
  </Section>
}

function SafetyWordsSection({ draft, edit }: EditProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const options = draft.safetyWords
  const add = () => {
    const word = text.trim()
    if (!word) return
    if (options.words.some(value => value.toLocaleLowerCase() === word.toLocaleLowerCase())) { setError('安全词已存在'); return }
    if (options.words.length >= MAX_SAFETY_WORDS) { setError(`安全词最多 ${MAX_SAFETY_WORDS} 个`); return }
    edit({ safetyWords: { ...options, words: [...options.words, word] } })
    setText(''); setError('')
  }
  return <Section title="安全词降速" heading={false}>
    <SwitchRow label="安全词降速" checked={options.enabled} onChange={enabled => { edit({ safetyWords: { ...options, enabled } }) }} />
    {options.enabled && <>
      <p className="tb-hint">消息包含任一安全词时，程序降一档速度，等 AI 新回复接管。</p>
      <div className="tb-safety-words">{options.words.map(word => <span key={word} className="tb-safety-word">
        <span>{word}</span><button type="button" aria-label={`删除安全词：${word}`} onClick={() => { edit({ safetyWords: { ...options, words: options.words.filter(value => value !== word) } }) }}>×</button>
      </span>)}</div>
      <div className="tb-row"><input aria-label="新增安全词" placeholder="输入安全词" maxLength={MAX_SAFETY_WORD_LENGTH} value={text}
        onChange={event => { setText(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add() } }} />
        <Button variant="outline" size="sm" disabled={!text.trim()} onClick={add}>添加</Button></div>
      {error && <p className="tb-error" role="alert">{error}</p>}
    </>}
  </Section>
}

function BehaviorSection({ draft, edit, save, cancel, saving, dirty }: EditProps & { save: (value: string) => void; cancel: () => void; saving: boolean; dirty: boolean }) {
  return <TextEditor label="补充互动规则" value={draft.behavior} onChange={behavior => { edit({ behavior }) }}
    maxLength={MAX_BEHAVIOR_LENGTH} dirty={dirty} saving={saving}
    onSave={() => { save(draft.behavior) }} onCancel={cancel} onReset={() => { save(DEFAULT_BEHAVIOR) }}
    resetDisabled={draft.behavior === DEFAULT_BEHAVIOR && !dirty} />
}

export const TOY_CSS = `
.${ROOT_CLASS}.tb-embedded { min-width: 0; width: 100%; }
.${ROOT_CLASS}.tb-embedded .tb-scroll { overflow: visible; }
/* 嵌在 QQ Bot 设置里时与其他页一致：分区用分隔线，不加卡片边框；折叠区与角色页的折叠区同款。 */
.${ROOT_CLASS}.tb-embedded .tb-live, .${ROOT_CLASS}.tb-embedded .tb-scroll { padding: 0; max-height: none; overflow: visible; }
.${ROOT_CLASS}.tb-embedded .tb-scroll { gap: 0; }
.${ROOT_CLASS}.tb-embedded .tb-draft { gap: 0; }
.${ROOT_CLASS}.tb-embedded .tb-card { border: 0; border-radius: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); padding: 16px 0; gap: 12px; }
.${ROOT_CLASS}.tb-embedded .tb-live .tb-card { padding: 0 0 16px; }
.${ROOT_CLASS}.tb-embedded .tb-footer { padding: 10px 0 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.${ROOT_CLASS} .tb-fold > summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer; font-weight: 600; }
.${ROOT_CLASS} .tb-fold > summary::-webkit-details-marker { display: none; }
.${ROOT_CLASS} .tb-fold > summary::before { content: '›'; font-size: 18px; line-height: 1; transition: transform .12s; }
.${ROOT_CLASS} .tb-fold[open] > summary::before { transform: rotate(90deg); }
.${ROOT_CLASS} .tb-subsettings[open] > :not(summary) { margin-top: 12px; }
.${ROOT_CLASS}.tb-embedded .tb-footer { position: sticky; bottom: 0; background: var(--dsw-alias-bg-layer-1); z-index: 1; }

span.${ROOT_CLASS} { display: contents; }
.${ROOT_CLASS} .tb-trigger { appearance: none; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; min-height: 30px; padding: 4px 8px;
  font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; color: var(--dsw-alias-label-secondary); flex: none; }
.${ROOT_CLASS} .tb-trigger:hover, .${ROOT_CLASS} .tb-trigger[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-1); }
.${ROOT_CLASS} .tb-trigger[data-active] { color: var(--dsw-alias-brand-primary); }
.${ROOT_CLASS} .tb-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
[role="dialog"].${ROOT_CLASS}.tb-window { display: flex; flex-direction: column; width: min(760px, 100%); max-height: 100%; padding: 0;
  gap: 0; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.${ROOT_CLASS} .tb-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2); flex: none; }
.${ROOT_CLASS} .tb-header h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.${ROOT_CLASS} .tb-scroll { overflow: auto; overscroll-behavior: contain; min-height: 0; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.${ROOT_CLASS} .tb-live { flex: none; padding: 12px 20px 0; max-height: 42vh; overflow: auto; }
.${ROOT_CLASS} .tb-live .tb-card { padding: 10px 12px; }
.${ROOT_CLASS} .tb-live-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.${ROOT_CLASS} .tb-live-actions > button { min-width: 0; padding-inline: 8px; white-space: nowrap; }
.${ROOT_CLASS}.tb-panel { height: min(800px, 100%); }
.${ROOT_CLASS}.tb-panel > .tb-scroll { flex: 1; }
.${ROOT_CLASS} .tb-draft { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
[role="dialog"].${ROOT_CLASS}.tb-confirm { width: min(420px, 100%); font-size: 14px; line-height: 22px; }
[role="dialog"].${ROOT_CLASS}.tb-device-intro { width: min(520px, 100%); max-height: 100%; font-size: 14px; line-height: 22px; }
.${ROOT_CLASS} .tb-intro-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.${ROOT_CLASS}.tb-device-intro > :last-child { flex-shrink: 0; }
.${ROOT_CLASS} .tb-intro-content { display: flex; flex-direction: column; gap: 16px; min-width: 0; overflow-wrap: anywhere; }
.${ROOT_CLASS} .tb-intro-content img { display: block; width: 100%; height: auto; border-radius: var(--dsw-radius-md, 8px); }
.${ROOT_CLASS} .tb-intro-content p { margin: 0; white-space: pre-wrap; }
.${ROOT_CLASS} .tb-scroll > p { margin: 0; }
.${ROOT_CLASS} .tb-footer { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-top: 0.5px solid var(--dsw-alias-border-l2); flex: none; justify-content: flex-end; }
.${ROOT_CLASS} .tb-footer-status { flex: 1; min-width: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${ROOT_CLASS} .tb-footer-status[data-error] { color: var(--dsw-alias-state-error-primary, #d43d45); }
.${ROOT_CLASS} .tb-card { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 12px); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.${ROOT_CLASS} .tb-card h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.${ROOT_CLASS} .tb-card p { margin: 0; }
.${ROOT_CLASS} .tb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.${ROOT_CLASS} .tb-safety-words { display: flex; flex-wrap: wrap; gap: 8px; }
.${ROOT_CLASS} .tb-safety-word { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 2px 8px; min-width: 0; overflow-wrap: anywhere; }
.${ROOT_CLASS} .tb-safety-word button { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0 4px; }
.${ROOT_CLASS} .tb-compact-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; min-width: 0; }
.${ROOT_CLASS} .tb-compact-field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.${ROOT_CLASS} .tb-compact-field > span { min-width: 70px; }
.${ROOT_CLASS} .tb-compact-field select { width: 140px; max-width: 100%; }
.${ROOT_CLASS} .tb-number.tb-number-compact { display: flex; flex-wrap: wrap; gap: 8px; }
.${ROOT_CLASS} .tb-number-compact .tb-number-value input { width: 76px; }
.${ROOT_CLASS} .tb-hotkey-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.${ROOT_CLASS} .tb-hotkey-row > span { flex: 0 0 84px; }
.${ROOT_CLASS} .tb-hotkey-row > .tb-row { min-width: 0; }
.${ROOT_CLASS} .tb-hotkey-row .tb-hotkey { width: 180px; max-width: 100%; flex: 0 1 180px; }
.${ROOT_CLASS} .tb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 16px; }
.${ROOT_CLASS} .tb-hint, .${ROOT_CLASS} small { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${ROOT_CLASS} .tb-hint[data-error], .${ROOT_CLASS} .tb-error { font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary, #d43d45); }
.${ROOT_CLASS} .tb-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.${ROOT_CLASS} .tb-field > span { font-weight: 500; }
.${ROOT_CLASS} .tb-field-inline { display: flex; align-items: center; gap: 6px; }
.${ROOT_CLASS} input:not([type]), .${ROOT_CLASS} input[type="number"], .${ROOT_CLASS} select, .${ROOT_CLASS} textarea {
  box-sizing: border-box; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; min-width: 0; }
.${ROOT_CLASS} input:not([type]), .${ROOT_CLASS} input[type="number"], .${ROOT_CLASS} select { height: 36px; }
/* 与宿主设置控件保持相同字号，只作用于联动弹窗。 */
.${ROOT_CLASS}.tb-window button:not([role="switch"]) { font-family: inherit; font-size: 14px; line-height: 22px; min-height: 36px; }
.${ROOT_CLASS} input:not([type]):focus-visible, .${ROOT_CLASS} input[type="number"]:focus-visible,
.${ROOT_CLASS} select:focus-visible, .${ROOT_CLASS} textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${ROOT_CLASS} input:disabled, .${ROOT_CLASS} select:disabled { color: var(--dsw-alias-label-secondary); }
.${ROOT_CLASS} textarea { resize: vertical; }
.${ROOT_CLASS} .tb-number, .${ROOT_CLASS} .tb-dual { display: grid; grid-template-columns: 96px minmax(0, 1fr) 124px; align-items: center; gap: 8px 12px; }
.${ROOT_CLASS} .tb-number-control { display: contents; }
.${ROOT_CLASS} .tb-number-value { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
.${ROOT_CLASS} .tb-number-value input { box-sizing: border-box; width: 66px; text-align: right; font-variant-numeric: tabular-nums; }
.${ROOT_CLASS} span[title] { cursor: help; }
.${ROOT_CLASS} .tb-slider { position: relative; height: 24px; min-width: 0; margin: 0 8px; }
.${ROOT_CLASS} .tb-slider-track { position: absolute; top: 10px; left: 0; right: 0; height: 4px; border-radius: 4px; pointer-events: none;
  background: linear-gradient(to right, var(--dsw-alias-border-l4) var(--tb-a), var(--dsw-alias-brand-primary) var(--tb-a),
    var(--dsw-alias-brand-primary) var(--tb-b), var(--dsw-alias-border-l4) var(--tb-b)); }
.${ROOT_CLASS} .tb-slider[data-cuts="stroke"] .tb-slider-track { background: var(--dsw-alias-border-l4); }
.${ROOT_CLASS} .tb-slider[data-cuts="speed"] .tb-slider-track { background: linear-gradient(to right,
  var(--tb-low) var(--tb-a), var(--tb-medium) var(--tb-a), var(--tb-medium) var(--tb-b), var(--tb-high) var(--tb-b)); }
.${ROOT_CLASS} .tb-slider input[type="range"] { position: absolute; top: 0; left: -8px; width: calc(100% + 16px); height: 24px; margin: 0; padding: 0;
  background: none; appearance: none; -webkit-appearance: none; cursor: pointer; }
.${ROOT_CLASS} .tb-slider[data-dual] input[type="range"] { pointer-events: none; }
.${ROOT_CLASS} .tb-slider input[type="range"]::-webkit-slider-runnable-track { height: 4px; background: transparent; }
.${ROOT_CLASS} .tb-slider input[type="range"]::-moz-range-track { height: 4px; background: transparent; }
.${ROOT_CLASS} .tb-slider input[type="range"]::-moz-range-progress { background: transparent; }
.${ROOT_CLASS} .tb-slider input[type="range"]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; box-sizing: border-box; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; pointer-events: auto; }
.${ROOT_CLASS} .tb-slider input[type="range"]::-moz-range-thumb { box-sizing: border-box; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, #fff); cursor: pointer; pointer-events: auto; }
.${ROOT_CLASS} .tb-slider[data-cuts="speed"] input:first-of-type::-webkit-slider-thumb { border-color: var(--tb-low); }
.${ROOT_CLASS} .tb-slider[data-cuts="speed"] input:last-of-type::-webkit-slider-thumb { border-color: var(--tb-high); }
.${ROOT_CLASS} .tb-slider[data-cuts="speed"] input:first-of-type::-moz-range-thumb { border-color: var(--tb-low); }
.${ROOT_CLASS} .tb-slider[data-cuts="speed"] input:last-of-type::-moz-range-thumb { border-color: var(--tb-high); }
.${ROOT_CLASS} .tb-slider input[type="range"]:focus-visible { outline: none; }
.${ROOT_CLASS} .tb-slider input[type="range"]:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${ROOT_CLASS} .tb-slider input[type="range"]:focus-visible::-moz-range-thumb { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${ROOT_CLASS} .tb-slider:has(input:disabled) { opacity: .5; }
.${ROOT_CLASS} .tb-slider input:disabled::-webkit-slider-thumb { cursor: default; }
.${ROOT_CLASS} .tb-slider input:disabled::-moz-range-thumb { cursor: default; }
.${ROOT_CLASS} .tb-dual output { text-align: right; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.${ROOT_CLASS} .tb-definition { display: grid; grid-template-columns: 96px minmax(0, 1fr); column-gap: 12px; margin: 4px 0; }
.${ROOT_CLASS} .tb-definition[data-kind="speed"] { --tb-low: #249965; --tb-medium: #d6a321; --tb-high: #e45962; }
.${ROOT_CLASS} .tb-definition-label { padding-top: 2px; }
.${ROOT_CLASS} .tb-definition-label small { display: block; }
.${ROOT_CLASS} .tb-definition-content { min-width: 0; }
.${ROOT_CLASS} .tb-cut-values { position: relative; height: 20px; margin: 0 8px; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.${ROOT_CLASS} .tb-cut-values > output { position: absolute; top: 0; white-space: nowrap; }
.${ROOT_CLASS} .tb-definition[data-kind="speed"] .tb-cut-values > output[data-index="0"] { color: color-mix(in srgb, var(--tb-low), var(--dsw-alias-label-primary) 22%); }
.${ROOT_CLASS} .tb-definition[data-kind="speed"] .tb-cut-values > output[data-index="1"] { color: color-mix(in srgb, var(--tb-high), var(--dsw-alias-label-primary) 22%); }
.${ROOT_CLASS} .tb-band-ranges { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 4px; font-size: 13px;
  line-height: 20px; text-align: center; font-variant-numeric: tabular-nums; }
.${ROOT_CLASS} .tb-band-ranges > span { display: flex; flex-direction: column; min-width: 0; }
.${ROOT_CLASS} .tb-band-ranges output { white-space: nowrap; }
.${ROOT_CLASS} .tb-definition[data-kind="speed"] .tb-band-ranges > span:nth-child(1) { color: color-mix(in srgb, var(--tb-low), var(--dsw-alias-label-primary) 22%); }
.${ROOT_CLASS} .tb-definition[data-kind="speed"] .tb-band-ranges > span:nth-child(2) { color: color-mix(in srgb, var(--tb-medium), var(--dsw-alias-label-primary) 22%); }
.${ROOT_CLASS} .tb-definition[data-kind="speed"] .tb-band-ranges > span:nth-child(3) { color: color-mix(in srgb, var(--tb-high), var(--dsw-alias-label-primary) 22%); }
.${ROOT_CLASS} .tb-high-preference { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.${ROOT_CLASS} .tb-high-choice { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.${ROOT_CLASS} .tb-high-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); align-items: start; gap: 12px; width: 100%; }
.${ROOT_CLASS} .tb-high-card { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 12px); }
.${ROOT_CLASS} .tb-high-card-select { display: flex; flex-direction: column; gap: 12px; min-width: 0; cursor: pointer; }
.${ROOT_CLASS} .tb-high-card[data-selected] { border-color: var(--tb-pool-color); background: color-mix(in srgb, var(--tb-pool-color), transparent 94%); }
.${ROOT_CLASS} .tb-high-card:focus-within { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${ROOT_CLASS} .tb-high-card input[type="radio"] { flex: none; width: 14px; height: 14px; margin: 0; accent-color: var(--tb-pool-color); }
.${ROOT_CLASS} .tb-high-card-title { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; }
.${ROOT_CLASS} .tb-high-card svg { display: block; min-width: 0; width: 100%; height: 72px; color: color-mix(in srgb, var(--tb-pool-color), var(--dsw-alias-label-primary) 22%); }
.${ROOT_CLASS} .tb-high-card-footer { min-width: 0; }
.${ROOT_CLASS} .tb-high-preference .tb-number { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin: 0; }
.${ROOT_CLASS} .tb-high-preference .tb-number-control { display: grid; grid-template-columns: minmax(0, 1fr) 74px; align-items: center; gap: 8px; min-width: 0; width: 100%; }
.${ROOT_CLASS} .tb-high-preference .tb-number-value input { width: 54px; }
.${ROOT_CLASS} .tb-hotkey { width: 180px; max-width: 100%; cursor: pointer; }
.${ROOT_CLASS} .tb-level-text { display: flex; flex-direction: column; gap: 6px; }
.${ROOT_CLASS} .tb-level-text > summary { cursor: pointer; }
.${ROOT_CLASS} .tb-level-text[open] > summary { margin-bottom: 6px; }
.${ROOT_CLASS} .tb-level-text textarea { width: 100%; box-sizing: border-box; }
@media (max-width: 560px) {
  .${ROOT_CLASS} .tb-header, .${ROOT_CLASS} .tb-footer { padding: 10px 12px; }
  .${ROOT_CLASS} .tb-scroll { padding: 12px; }
  .${ROOT_CLASS} .tb-live { padding: 8px 12px 0; }
  .${ROOT_CLASS} .tb-number, .${ROOT_CLASS} .tb-dual { grid-template-columns: 1fr 124px; gap: 6px 12px; }
  .${ROOT_CLASS} .tb-number-control > .tb-slider, .${ROOT_CLASS} .tb-dual > .tb-slider { grid-column: 1 / -1; grid-row: 2; }
  .${ROOT_CLASS} .tb-definition { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .${ROOT_CLASS} .tb-definition-label { display: flex; align-items: center; justify-content: space-between; padding: 0; }
  .${ROOT_CLASS} .tb-band-ranges { font-size: 13px; gap: 4px; }
  .${ROOT_CLASS} .tb-high-preference .tb-number-control > .tb-slider { grid-column: 1; grid-row: 1; }
}
`
