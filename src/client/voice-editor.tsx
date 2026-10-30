/** 语音服务、音色与朗读偏好。仅供 QQ Bot 使用，不进入提示词。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryRole } from '../library-types.ts'
import {
  DEFAULT_PROXY_URL, ENGINE_DEFAULTS, ENGINE_KEY, ENGINE_KIND_LABELS, ENGINE_KINDS, PREVIEW_TEXT,
  SOVITS_LANG_LABELS, SOVITS_LANGS, VOICE_DISPLAY_LABELS, VOICE_DISPLAYS, VOICE_MODES, VOICE_MODE_LABELS,
  type EngineDraft, type EngineKind, type VoiceAction, type VoiceDraft, type VoiceEngineView,
  type VoiceEntry, type VoiceParams, type VoiceSettings,
} from '../voice-types.ts'
import { requestSpeech, requestVoice, type VoiceState } from './voice-state.ts'
import { ActionDialog } from './action-dialog.tsx'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
function freeName(base: string, taken: readonly { readonly name: string }[]): string {
  const names = new Set(taken.map(item => item.name))
  if (!names.has(base)) return base
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`
}
function fishReference(value: string): string {
  return /fish\.audio\/.*?\b([0-9a-f]{32})\b/i.exec(value)?.[1] ?? value
}
function useVoiceAction(voice: VoiceState, onBusy: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const mounted = useRef(true)
  const submitting = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusy(false) } }, [onBusy])
  const run = async (action: VoiceAction): Promise<string | undefined | false> => {
    if (submitting.current) return false
    submitting.current = true; onBusy(true)
    setBusy(true); setError(undefined); setSaved(false)
    try {
      const view = await requestVoice(action)
      voice.adopt(view)
      setSaved(true)
      if (!mounted.current) return false
      return view.saved
    } catch (caught) { setError(messageOf(caught)); return false }
    finally { submitting.current = false; setBusy(false); onBusy(false) }
  }
  return { busy, error, saved, run, clearError: () => { setError(undefined) } }
}
function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return <label className="ql-field"><span title={hint}>{label}</span>{children}</label>
}
function ErrorMessage({ error }: { readonly error: string | undefined }) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => { if (error !== undefined) element.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  return error === undefined ? null : <div ref={element} role="alert" className="ql-state ql-warn">{error}</div>
}

/** 页面上只挂载一个试听器；返回、切换音色或更改参数时停止并取消请求。 */
function Preview({ voice, draft, autoPlay = false, onStart, onSuccess }: {
  readonly voice: VoiceState; readonly draft: VoiceDraft | undefined
  readonly autoPlay?: boolean; readonly onStart?: () => void; readonly onSuccess?: () => void
}) {
  const [text, setText] = useState(PREVIEW_TEXT)
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [error, setError] = useState<string>()
  const current = useRef<{ abort: AbortController; audio?: HTMLAudioElement; url?: string }>()
  const stop = () => {
    const playing = current.current
    current.current = undefined
    playing?.abort.abort(); playing?.audio?.pause()
    if (playing?.url !== undefined) URL.revokeObjectURL(playing.url)
    setState('idle')
  }
  const play = async () => {
    if (draft === undefined) return
    stop()
    onStart?.()
    const session: NonNullable<typeof current.current> = { abort: new AbortController() }
    current.current = session
    setError(undefined); setState('loading')
    try {
      const blob = await requestSpeech(draft, text.trim() || PREVIEW_TEXT, session.abort.signal)
      if (current.current !== session) return
      session.url = URL.createObjectURL(blob)
      session.audio = new Audio(session.url)
      session.audio.volume = voice.settings.volume
      session.audio.addEventListener('ended', () => { if (current.current === session) stop() })
      await session.audio.play()
      if (current.current !== session) return
      setState('playing'); onSuccess?.()
    } catch (caught) {
      if (current.current !== session) return
      const cancelled = session.abort.signal.aborted
      stop()
      if (!cancelled) setError(messageOf(caught))
    }
  }
  const signature = JSON.stringify(draft)
  useEffect(() => {
    setError(undefined)
    if (autoPlay) void play()
    return stop
  }, [signature])
  return <div className="qv-preview">
    <Field label="试听文字"><input value={text} maxLength={200} onChange={event => { setText(event.target.value) }} /></Field>
    <div className="ql-actions"><Button size="sm" variant="outline" disabled={draft === undefined} onClick={() => { if (state === 'idle') void play(); else stop() }}>
      {state === 'idle' ? '试听' : state === 'loading' ? '取消生成' : '停止播放'}
    </Button>{state === 'loading' && <span className="qv-meta" role="status">生成中…</span>}</div>
    <ErrorMessage error={error} />
  </div>
}

type ActionRunner = ReturnType<typeof useVoiceAction>
interface FormProps {
  readonly voice: VoiceState; readonly action: ActionRunner
  readonly onDirty: (dirty: boolean) => void; readonly onSaved: (id: string) => void; readonly onCancel: () => void
}
function EngineForm({ voice, engine, action, onDirty, onSaved, onCancel }: FormProps & { readonly engine: VoiceEngineView | undefined }) {
  const create = engine === undefined
  const [kind, setKind] = useState<EngineKind>(engine?.kind ?? 'fish')
  const [name, setName] = useState(engine?.name ?? freeName(ENGINE_KIND_LABELS.fish, voice.engines))
  const [config, setConfig] = useState(engine?.config ?? ENGINE_DEFAULTS.fish)
  const [apiKey, setApiKey] = useState('')
  const [changingKey, setChangingKey] = useState(false)
  const [removeKey, setRemoveKey] = useState(false)
  const proxy = config.proxy ?? ENGINE_DEFAULTS.fish.proxy!
  const keyMode = ENGINE_KEY[kind]
  const { busy, error, run } = action
  const dirty = () => { onDirty(true) }
  const save = async () => {
    const draft: EngineDraft = {
      ...create ? {} : { id: engine.id }, name, kind, config,
      ...removeKey ? { apiKey: null } : apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() },
    }
    const id = await run({ action: 'engine.save', engine: draft })
    if (typeof id === 'string') onSaved(id)
  }
  return <fieldset className="qv-fields" disabled={busy}>
    {create && <Field label="服务类型"><select value={kind} onChange={event => {
      const next = ENGINE_KINDS.find(k => k === event.target.value)
      if (next === undefined) return
      setKind(next); setConfig(ENGINE_DEFAULTS[next]); setName(freeName(ENGINE_KIND_LABELS[next], voice.engines))
      setApiKey(''); setChangingKey(false); setRemoveKey(false); dirty()
    }}>{ENGINE_KINDS.map(k => <option key={k} value={k}>{ENGINE_KIND_LABELS[k]}</option>)}</select></Field>}
    {kind !== 'fish' && <Field label="服务地址" hint={kind === 'gpt-sovits' ? '运行 api_v2.py 的地址' : '地址填到 /v1'}>
      <input value={config.baseUrl} placeholder={ENGINE_DEFAULTS[kind].baseUrl}
        onChange={event => { setConfig(c => ({ ...c, baseUrl: event.target.value })); dirty() }} />
    </Field>}
    {keyMode !== 'none' && <div className="ql-field"><span>API 密钥{keyMode === 'optional' ? '（可选）' : ''}</span>
      {engine?.hasKey === true && !changingKey && !removeKey
        ? <div className="ql-actions"><span className="qv-meta">已配置</span><Button size="sm" variant="outline" onClick={() => { setChangingKey(true) }}>更换</Button></div>
        : removeKey ? <span className="qv-meta">保存后移除密钥</span>
          : <input type="password" autoComplete="off" aria-label="API 密钥" value={apiKey} disabled={!voice.keyStore}
            placeholder={!voice.keyStore ? 'DSH 凭据库不可用' : engine?.hasKey === true ? '留空保留原密钥' : keyMode === 'required' ? '填写 Fish Audio API 密钥' : '本地服务通常留空'}
            onChange={event => { setApiKey(event.target.value); dirty() }} />}
    </div>}
    {kind === 'fish' && <div className="qv-proxy">
      <label className="qv-setting" title="填代理软件的 HTTP 或混合端口，不支持 SOCKS"><span>使用代理</span>
        <input type="checkbox" checked={proxy.enabled} onChange={event => {
          setConfig(c => ({ ...c, proxy: { ...proxy, enabled: event.target.checked } })); dirty()
        }} /></label>
      {proxy.enabled && <Field label="代理地址"><input value={proxy.url} placeholder={DEFAULT_PROXY_URL}
        onChange={event => { setConfig(c => ({ ...c, proxy: { ...proxy, url: event.target.value } })); dirty() }} /></Field>}
    </div>}
    <details className="qv-more"><summary>更多设置</summary><div className="qv-fields">
      <Field label="名称"><input value={name} onChange={event => { setName(event.target.value); dirty() }} /></Field>
      {kind !== 'gpt-sovits' && <Field label="模型"><input value={config.model} placeholder={ENGINE_DEFAULTS[kind].model}
        onChange={event => { setConfig(c => ({ ...c, model: event.target.value })); dirty() }} /></Field>}
      {engine?.hasKey === true && keyMode !== 'none' && <label className="ql-toggle">
        <input type="checkbox" checked={removeKey} onChange={event => { setRemoveKey(event.target.checked); setApiKey(''); dirty() }} /><span>移除已保存的密钥</span>
      </label>}
    </div></details>
    <ErrorMessage error={error} />
    <div className="qv-footer"><Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
      <Button size="sm" variant="primary" onClick={() => { void save() }}>{busy ? '保存中…' : '保存服务'}</Button></div>
  </fieldset>
}

const BLANK_PARAMS: VoiceParams = { reference: '', promptText: '', promptLang: 'zh', textLang: 'zh' }
function VoiceForm({ voice, entry, initialEngine, action, onDirty, onSaved, onCancel }: FormProps & {
  readonly entry: VoiceEntry | undefined; readonly initialEngine?: string
}) {
  const [name, setName] = useState(entry?.name ?? freeName('新音色', voice.voices))
  const [engineId, setEngineId] = useState(entry?.engine ?? initialEngine ?? voice.engines[0]?.id ?? '')
  const [params, setParams] = useState<VoiceParams>(entry?.params ?? BLANK_PARAMS)
  const engine = voice.engine(engineId)
  const { busy, error, run } = action
  const edit = (patch: Partial<VoiceParams>) => { setParams(p => ({ ...p, ...patch })); onDirty(true) }
  const draft: VoiceDraft | undefined = engine === undefined || params.reference.trim() === '' ? undefined
    : { ...entry === undefined ? {} : { id: entry.id }, name: name.trim() || '试听', engine: engine.id, params }
  const save = async () => {
    const id = await run({ action: 'voice.save', voice: { ...entry === undefined ? {} : { id: entry.id }, name, engine: engineId, params } })
    if (typeof id === 'string') onSaved(id)
  }
  return <fieldset className="qv-fields" disabled={busy}>
    <Field label="音色名称"><input value={name} onChange={event => { setName(event.target.value); onDirty(true) }} /></Field>
    {voice.engines.length === 1 ? <div className="ql-field"><span>语音服务</span><span className="qv-meta">{engine?.name}</span></div>
      : <Field label="语音服务"><select value={engineId} onChange={event => {
        const next = voice.engine(event.target.value)
        if (next?.kind !== engine?.kind) setParams(BLANK_PARAMS)
        setEngineId(event.target.value); onDirty(true)
      }}>{voice.engines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
    {engine?.kind === 'fish' && <Field label="音色链接或 ID" hint="可粘贴 Fish Audio 音色页完整地址">
      <input value={params.reference} placeholder="粘贴 Fish Audio 音色链接或 ID" onChange={event => { edit({ reference: fishReference(event.target.value.trim()) }) }} />
    </Field>}
    {engine?.kind === 'openai' && <Field label="服务中的音色名称" hint="填写服务支持的 voice，例如 alloy">
      <input value={params.reference} placeholder="例如 alloy" onChange={event => { edit({ reference: event.target.value }) }} />
    </Field>}
    {engine?.kind === 'gpt-sovits' && <>
      <Field label="参考音频路径" hint="运行 GPT-SoVITS 的电脑上的文件路径"><input value={params.reference} onChange={event => { edit({ reference: event.target.value }) }} /></Field>
      <Field label="参考音频的文字"><input value={params.promptText} onChange={event => { edit({ promptText: event.target.value }) }} /></Field>
      <div className="ql-grid">
        <Field label="参考音频的语言"><select value={params.promptLang} onChange={event => {
          const lang = SOVITS_LANGS.find(l => l === event.target.value); if (lang !== undefined) edit({ promptLang: lang })
        }}>{SOVITS_LANGS.map(l => <option key={l} value={l}>{SOVITS_LANG_LABELS[l]}</option>)}</select></Field>
        <Field label="朗读语言"><select value={params.textLang} onChange={event => {
          const lang = SOVITS_LANGS.find(l => l === event.target.value); if (lang !== undefined) edit({ textLang: lang })
        }}>{SOVITS_LANGS.map(l => <option key={l} value={l}>{SOVITS_LANG_LABELS[l]}</option>)}</select></Field>
      </div>
    </>}
    <Preview voice={voice} draft={draft} />
    <ErrorMessage error={error} />
    <div className="qv-footer"><Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
      <Button size="sm" variant="primary" onClick={() => { void save() }}>{busy ? '保存中…' : '保存音色'}</Button></div>
  </fieldset>
}

function VoiceSettingsForm({ voice, action }: { readonly voice: VoiceState; readonly action: ActionRunner }) {
  const settings = voice.settings
  const [volume, setVolume] = useState(settings.volume)
  useEffect(() => { setVolume(settings.volume) }, [settings.volume])
  const save = async (patch: Partial<VoiceSettings>) => {
    if (await action.run({ action: 'settings.save', settings: { ...voice.settings, ...patch } }) === false) setVolume(voice.settings.volume)
  }
  const commitVolume = () => { if (volume !== voice.settings.volume && !action.busy) void save({ volume }) }
  return <fieldset className="qv-fields" disabled={action.busy || !settings.enabled}>
    <label className="qv-setting"><span>发送方式</span><select aria-label="发送方式" value={settings.mode} onChange={event => {
      const mode = VOICE_MODES.find(m => m === event.target.value); if (mode !== undefined) void save({ mode })
    }}>{VOICE_MODES.map(m => <option key={m} value={m}>{VOICE_MODE_LABELS[m]}</option>)}</select></label>
    <label className="qv-setting"><span>显示方式</span><select value={settings.display} onChange={event => {
      const display = VOICE_DISPLAYS.find(d => d === event.target.value); if (display !== undefined) void save({ display })
    }}>{VOICE_DISPLAYS.map(d => <option key={d} value={d}>{VOICE_DISPLAY_LABELS[d]}</option>)}</select></label>
    <label className="qv-setting"><span>生成时机</span><select value={settings.pregenerate ? 'early' : 'click'}
      onChange={event => { void save({ pregenerate: event.target.value === 'early' }) }}>
      <option value="click">点击时生成</option><option value="early">新回复提前生成</option>
    </select></label>
    <label className="qv-setting"><span>音量</span><span className="qv-volume"><input type="range" min={0} max={1} step={0.05}
      value={volume} onChange={event => { setVolume(Number(event.target.value)) }}
      onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume} /><output>{Math.round(volume * 100)}%</output></span></label>
  </fieldset>
}
function MoreMenu({ name, disabled, onRemove }: { readonly name: string; readonly disabled: boolean; readonly onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal align="end" onClose={() => { setOpen(false) }}
    anchor={<Button size="sm" variant="ghost" disabled={disabled} aria-label={`${name}的更多操作`} onClick={() => { setOpen(!open) }}>⋯</Button>}
    items={[{ id: 'remove', label: '删除', danger: true }]} onSelect={() => { setOpen(false); onRemove() }} />
}
type Selection = { readonly kind: 'engine' | 'voice'; readonly id?: string; readonly engine?: string }

export function VoicePage({ voice, roles, onDirty, onBusy, guard, onOpenRole, onAssignVoice }: {
  readonly voice: VoiceState; readonly roles: readonly LibraryRole[]
  readonly onDirty: (dirty: boolean) => void; readonly guard: (next: () => void) => void
  readonly onBusy: (busy: boolean) => void
  readonly onOpenRole: (id?: string) => void
  readonly onAssignVoice: (roleId: string, voiceId: string) => Promise<void>
}) {
  useSyncExternalStore(voice.subscribe, voice.getVersion)
  const action = useVoiceAction(voice, onBusy)
  const [loadError, setLoadError] = useState<string>()
  const [selection, setSelection] = useState<Selection>()
  const [removing, setRemoving] = useState<Selection>()
  const [preview, setPreview] = useState<string>()
  const [tested, setTested] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<{ text: string; engine?: string; voice?: string }>()
  const [assigning, setAssigning] = useState<string>()
  const [targetRole, setTargetRole] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  const assignLock = useRef(false)
  const [assignError, setAssignError] = useState<string>()
  const assign = (id: string) => { setPreview(undefined); setTargetRole(''); setAssignError(undefined); setAssigning(id) }
  const confirmAssign = async () => {
    if (assignLock.current || assigning === undefined || targetRole === '') return
    assignLock.current = true; setAssignBusy(true); onBusy(true); setAssignError(undefined)
    try {
      await onAssignVoice(targetRole, assigning)
      setNotice({ text: `已将“${voice.voice(assigning)?.name}”用于“${roles.find(r => r.id === targetRole)?.name}”` })
      setAssigning(undefined)
    } catch (error) { setAssignError(messageOf(error)) }
    finally { assignLock.current = false; setAssignBusy(false); onBusy(false) }
  }
  useEffect(() => { voice.reload().catch((caught: unknown) => { setLoadError(messageOf(caught)) }) }, [voice])
  const go = (next?: Selection) => { guard(() => {
    onDirty(false); action.clearError(); setPreview(undefined); setRemoving(undefined); setNotice(undefined); setSelection(next)
  }) }
  const done = (text: string, next: { engine?: string; voice?: string } = {}) => {
    onDirty(false); action.clearError(); setTested([]); setSelection(undefined); setNotice({ text, ...next })
  }
  if (loadError !== undefined && !voice.ready) return <ErrorMessage error={loadError} />
  if (!voice.ready) return <div className="ql-empty">加载中…</div>
  const engine = selection?.id === undefined ? undefined : voice.engine(selection.id)
  const entry = selection?.id === undefined ? undefined : voice.voice(selection.id)
  const formProps = { voice, action, onDirty, onCancel: () => { go() } }
  if (selection !== undefined) return <div className="qv-page">
    <div className="qv-form-head"><Button size="sm" variant="ghost" disabled={action.busy} onClick={() => { go() }}>‹ 返回语音</Button>
      <h3>{selection.kind === 'engine' ? engine?.name ?? '添加语音服务' : entry?.name ?? '添加音色'}</h3></div>
    <div className="qv-editor">
      {selection.id !== undefined && (selection.kind === 'engine' ? engine : entry) === undefined
        ? <div className="ql-empty">已被删除，请返回语音页。</div>
        : selection.kind === 'engine'
          ? <EngineForm key={selection.id ?? 'new'} {...formProps} engine={engine} onSaved={id => { done('语音服务已保存', { engine: id }) }} />
          : <VoiceForm key={selection.id ?? 'new'} {...formProps} entry={entry} {...selection.engine === undefined ? {} : { initialEngine: selection.engine }}
            onSaved={id => { done('音色已保存', { voice: id }) }} />}
    </div>
  </div>
  const remove = async () => {
    if (removing?.id === undefined) return
    const ok = await action.run({ action: removing.kind === 'engine' ? 'engine.remove' : 'voice.remove', id: removing.id })
    if (ok !== false) { setRemoving(undefined); setPreview(undefined); setTested([]); setNotice(undefined) }
  }
  const usedVoices = removing?.kind === 'engine' ? voice.voices.filter(v => v.engine === removing.id) : []
  const usedRoles = roles.filter(r => r.voice === removing?.id)
  const removedName = removing?.kind === 'engine' ? voice.engine(removing.id ?? '')?.name : voice.voice(removing?.id)?.name
  const removePrompt = removing === undefined ? null : <ActionDialog
    title={usedVoices.length > 0 ? '暂时不能删除这个服务' : `删除“${removedName}”？`}
    busy={action.busy} error={action.error} cancelLabel={usedVoices.length > 0 ? '知道了' : '取消'} confirmLabel="确认删除"
    onCancel={() => { setRemoving(undefined); action.clearError() }}
    onConfirm={usedVoices.length > 0 ? undefined : () => { void remove() }}>
    {usedVoices.length > 0 ? `${usedVoices.map(v => v.name).join('、')}正在使用这个服务，请先删除或更换这些音色的服务。`
      : removing.kind === 'engine' ? '会同时移除这个服务保存的密钥。' : usedRoles.length > 0 ? `${usedRoles.map(r => r.name).join('、')}将改为显示文字。` : '这个音色将从列表移除。'}
  </ActionDialog>
  return <div className="qv-page">
    <div className="qv-heading"><h3>语音</h3><label className="ql-toggle"><span>启用语音</span><input type="checkbox"
      checked={voice.settings.enabled} disabled={action.busy} onChange={event => {
        if (!event.target.checked) { setPreview(undefined); setRemoving(undefined); setAssigning(undefined) }
        void action.run({ action: 'settings.save', settings: { ...voice.settings, enabled: event.target.checked } })
      }} /></label></div>
    {removing === undefined && action.error !== undefined && <ActionDialog title="语音设置未保存" cancelLabel="知道了" onCancel={action.clearError}>
      {action.error}
    </ActionDialog>}
    {voice.settings.enabled && <>
    {notice !== undefined && <div className="qv-notice" role="status"><span>{notice.text}</span>
      {notice.engine !== undefined && <Button size="sm" variant="outline" onClick={() => { go({ kind: 'voice', engine: notice.engine! }) }}>添加音色</Button>}
      {notice.voice !== undefined && <Button size="sm" variant="outline" onClick={() => { assign(notice.voice!) }}>用于角色</Button>}
    </div>}
    <details className="qv-section qv-services" open={voice.engines.length === 0}>
      <summary>语音服务{voice.engines.length > 0 && <span className="qv-meta"> · {voice.engines.map(e => e.name).join('、')}</span>}</summary>
      <div className="qv-heading"><h3>语音服务</h3><Button size="sm" variant={voice.engines.length === 0 ? 'primary' : 'outline'}
        disabled={action.busy} onClick={() => { go({ kind: 'engine' }) }}>添加服务</Button></div>
      {voice.engines.length === 0 ? <p className="qv-meta">先添加一个语音服务，再选择音色。</p> : <div className="qv-cards">
        {voice.engines.map(item => <div className="qv-card" key={item.id}>
          <div className="qv-row"><div className="qv-info"><strong>{item.name}</strong><span className="qv-meta">
            {ENGINE_KIND_LABELS[item.kind]} · {ENGINE_KEY[item.kind] === 'none' ? '无需密钥' : item.hasKey ? '密钥已配置' : ENGINE_KEY[item.kind] === 'required' ? '未配置密钥' : '未配置密钥（可选）'}
            {item.kind === 'fish' && ` · ${item.config.proxy?.enabled === true ? '代理开启' : '跟随 DSH 网络设置'}`}
          </span></div><div className="ql-actions"><Button size="sm" variant="outline" disabled={action.busy}
            onClick={() => { go({ kind: 'engine', id: item.id }) }}>设置</Button>
            <MoreMenu name={item.name} disabled={action.busy} onRemove={() => { action.clearError(); setPreview(undefined); setRemoving({ kind: 'engine', id: item.id }) }} /></div></div>
        </div>)}
      </div>}
    </details>
    <section className="qv-section" aria-label="音色">
      <div className="qv-heading"><h3>音色</h3>{voice.engines.length > 0 && <Button size="sm" variant={voice.voices.length === 0 ? 'primary' : 'outline'}
        disabled={action.busy} onClick={() => { go({ kind: 'voice' }) }}>添加音色</Button>}</div>
      {voice.voices.length === 0 ? <p className="qv-meta">{voice.engines.length === 0 ? '添加服务后，可在这里管理音色。' : '添加一个喜欢的音色，试听后给角色使用。'}</p> : <div className="qv-cards">
        {voice.voices.map(item => {
          const users = roles.filter(r => r.voice === item.id)
          return <div className="qv-card" key={item.id}>
            <div className="qv-row"><div className="qv-info"><strong>{item.name}</strong><span className="qv-meta">
              {voice.engine(item.engine)?.name ?? '服务已删除'} · {users.length === 0 ? '暂无角色使用' : `${users.map(r => r.name).join('、')}正在使用`}
              {tested.includes(item.id) && ' · 上次试听成功'}
            </span></div><div className="ql-actions">
              <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { setPreview(preview === item.id ? undefined : item.id) }}>{preview === item.id ? '收起试听' : '试听'}</Button>
              <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { go({ kind: 'voice', id: item.id }) }}>编辑</Button>
              <Button size="sm" variant="outline" disabled={action.busy} onClick={() => { assign(item.id) }}>用于角色</Button>
              <MoreMenu name={item.name} disabled={action.busy} onRemove={() => { action.clearError(); setPreview(undefined); setRemoving({ kind: 'voice', id: item.id }) }} />
            </div></div>
            {preview === item.id && <Preview voice={voice} draft={item} autoPlay
              onStart={() => { setTested(ids => ids.filter(id => id !== item.id)) }}
              onSuccess={() => { setTested(ids => ids.includes(item.id) ? ids : [...ids, item.id]) }} />}
          </div>
        })}
      </div>}
    </section>
    <section className="qv-section" aria-label="朗读偏好"><div className="qv-heading"><h3>朗读偏好</h3><span className="qv-meta" role="status">{action.busy ? '保存中…' : action.saved ? '已保存' : '自动保存'}</span></div>
      <VoiceSettingsForm voice={voice} action={action} />
    </section>
    {removePrompt}
    {assigning !== undefined && <ActionDialog title={`将“${voice.voice(assigning)?.name}”用于角色`} busy={assignBusy} error={assignError}
      cancelLabel="取消" confirmLabel="确认使用" onCancel={() => { setAssigning(undefined) }}
      confirmDisabled={targetRole === ''} onConfirm={roles.length === 0 ? undefined : () => { void confirmAssign() }}>
      {roles.length === 0 ? <><span>还没有角色。</span><Button size="sm" onClick={() => { setAssigning(undefined); onOpenRole() }}>去创建角色</Button></>
        : <label className="qv-role-choice">选择角色<select aria-label="目标角色" value={targetRole} disabled={assignBusy}
          onChange={event => { setTargetRole(event.target.value); setAssignError(undefined) }}>
          <option value="">请选择角色</option>{roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>{targetRole !== '' && <span>确认后替换这个角色当前的音色并保存。</span>}</label>}
    </ActionDialog>}
    </>}
  </div>
}

/** 角色页仍只负责选择音色。 */
export function RoleVoiceField({ voice, value, onChange, onManage }: {
  readonly voice: VoiceState; readonly value: string | undefined
  readonly onChange: (value: string | undefined) => void; readonly onManage: () => void
}) {
  useSyncExternalStore(voice.subscribe, voice.getVersion)
  useEffect(() => { if (!voice.ready) voice.reload().catch(() => {}) }, [voice])
  const missing = value !== undefined && voice.ready && voice.voice(value) === undefined
  return <div className="ql-field ql-inline"><span>音色</span><div className="ql-actions">
    <select value={value ?? ''} onChange={event => { onChange(event.target.value === '' ? undefined : event.target.value) }}>
      <option value="">不用语音</option>{missing && <option value={value}>（已删除）</option>}
      {voice.voices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select><Button size="sm" variant="ghost" onClick={onManage}>{voice.voices.length === 0 ? '添加音色' : '管理音色'}</Button>
  </div></div>
}
