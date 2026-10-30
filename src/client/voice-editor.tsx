/**
 * 编辑器里的"语音"页（朗读设置、连接、音色和试听）和角色表单里的音色选择。
 * 改动只影响浏览器端朗读，不进提示词，不影响前缀缓存。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ENGINE_DEFAULTS, ENGINE_KEY, ENGINE_KIND_LABELS, ENGINE_KINDS, PREVIEW_TEXT, SOVITS_LANG_LABELS, SOVITS_LANGS, VOICE_DISPLAY_LABELS, VOICE_DISPLAYS,
  type EngineDraft, type EngineKind, type VoiceAction, type VoiceDraft, type VoiceEngineView, type VoiceEntry, type VoiceParams, type VoiceSettings,
} from '../voice-types.ts'
import { requestSpeech, requestVoice, type VoiceState } from './voice-state.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 名称不能重复：新建时找一个没用过的。 */
function freeName(base: string, taken: readonly { readonly name: string }[]): string {
  const names = new Set(taken.map(item => item.name))
  if (!names.has(base)) return base
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`
}

/** fish.audio 音色页的地址里带着 32 位的音色 ID，粘贴整个地址时取出来。 */
function fishReference(value: string): string {
  return /fish\.audio\/.*?\b([0-9a-f]{32})\b/i.exec(value)?.[1] ?? value
}

function useVoiceAction(voice: VoiceState) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const run = async (action: VoiceAction): Promise<string | undefined | false> => {
    setBusy(true)
    setError(undefined)
    try {
      const view = await requestVoice(action)
      voice.adopt(view)
      return view.saved
    } catch (caught) {
      setError(messageOf(caught))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function Field({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return <label className="ql-field">
    <span>{label}</span>
    {children}
    {hint !== undefined && <small>{hint}</small>}
  </label>
}

/** 试听：用表单里还没保存的设置合成一句。 */
function Preview({ voice, draft }: { readonly voice: VoiceState; readonly draft: VoiceDraft | undefined }) {
  const [text, setText] = useState(PREVIEW_TEXT)
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [error, setError] = useState<string | undefined>()
  const current = useRef<{ abort: AbortController; audio?: HTMLAudioElement; url?: string } | undefined>(undefined)
  const stop = () => {
    const playing = current.current
    current.current = undefined
    playing?.abort.abort()
    playing?.audio?.pause()
    if (playing?.url !== undefined) URL.revokeObjectURL(playing.url)
    setState('idle')
  }
  useEffect(() => stop, [])
  const play = async () => {
    if (draft === undefined) return
    stop()
    const session: { abort: AbortController; audio?: HTMLAudioElement; url?: string } = { abort: new AbortController() }
    current.current = session
    setError(undefined)
    setState('loading')
    try {
      const blob = await requestSpeech(draft, text.trim() || PREVIEW_TEXT, session.abort.signal)
      if (current.current !== session) return
      session.url = URL.createObjectURL(blob)
      session.audio = new Audio(session.url)
      session.audio.volume = voice.settings.volume
      session.audio.addEventListener('ended', () => { if (current.current === session) stop() })
      await session.audio.play()
      setState('playing')
    } catch (caught) {
      if (current.current !== session) return
      stop()
      if (!session.abort.signal.aborted) setError(messageOf(caught))
    }
  }
  return <div className="ql-field">
    <span>试听</span>
    <div className="ql-actions">
      <input style={{ flex: 1, minWidth: 160 }} value={text} maxLength={200} onChange={(event) => { setText(event.target.value) }} />
      {state === 'idle'
        ? <Button size="sm" variant="outline" disabled={draft === undefined} onClick={() => { void play() }}>试听</Button>
        : <Button size="sm" variant="outline" onClick={stop}>{state === 'loading' ? '生成中…' : '停止'}</Button>}
    </div>
    {error !== undefined && <div className="ql-state ql-warn">{error}</div>}
  </div>
}

function EngineForm({ voice, engine, busy, run, onDirty, onSaved, onRemoved }: {
  readonly voice: VoiceState
  readonly engine: VoiceEngineView | undefined
  readonly busy: boolean
  readonly run: (action: VoiceAction) => Promise<string | undefined | false>
  readonly onDirty: (dirty: boolean) => void
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
}) {
  const create = engine === undefined
  const [kind, setKind] = useState<EngineKind>(engine?.kind ?? 'fish')
  const [name, setName] = useState(engine?.name ?? freeName(ENGINE_KIND_LABELS.fish, voice.engines))
  const [config, setConfig] = useState(engine?.config ?? ENGINE_DEFAULTS.fish)
  const [apiKey, setApiKey] = useState('')
  const [confirming, setConfirming] = useState(false)
  const dirty = () => { onDirty(true) }
  const keyMode = ENGINE_KEY[kind]
  const save = async (key?: string | null) => {
    const draft: EngineDraft = {
      ...create ? {} : { id: engine.id }, name, kind, config,
      ...key !== undefined ? { apiKey: key } : apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() },
    }
    const saved = await run({ action: 'engine.save', engine: draft })
    if (typeof saved === 'string') { setApiKey(''); onSaved(saved) }
  }
  const users = create ? [] : voice.voices.filter(item => item.engine === engine.id)

  return <div className="ql-form">
    <div className="ql-grid">
      <Field label="类型">
        <select value={kind} disabled={!create || busy} title={create ? undefined : '类型不能改，要换请新建一个连接'} onChange={(event) => {
          const next = ENGINE_KINDS.find(k => k === event.target.value)
          if (next === undefined) return
          setKind(next)
          setConfig(ENGINE_DEFAULTS[next])
          setName(freeName(ENGINE_KIND_LABELS[next], voice.engines))
          dirty()
        }}>
          {ENGINE_KINDS.map(k => <option key={k} value={k}>{ENGINE_KIND_LABELS[k]}</option>)}
        </select>
      </Field>
      <Field label="名称">
        <input value={name} onChange={(event) => { setName(event.target.value); dirty() }} />
      </Field>
    </div>
    {kind !== 'fish' && <Field label="地址" hint={kind === 'gpt-sovits' ? '运行 api_v2.py 的地址' : '到 /v1 为止'}>
      <input value={config.baseUrl} placeholder={ENGINE_DEFAULTS[kind].baseUrl}
        onChange={(event) => { setConfig(c => ({ ...c, baseUrl: event.target.value })); dirty() }} />
    </Field>}
    {kind !== 'gpt-sovits' && <Field label="模型">
      <input value={config.model} placeholder={ENGINE_DEFAULTS[kind].model}
        onChange={(event) => { setConfig(c => ({ ...c, model: event.target.value })); dirty() }} />
    </Field>}
    {keyMode !== 'none' && <Field label="API key">
      <div className="ql-actions">
        <input type="password" autoComplete="off" style={{ flex: 1, minWidth: 160 }} value={apiKey} disabled={!voice.keyStore}
          placeholder={!voice.keyStore ? 'DSH 没有可用的凭据库' : engine?.hasKey === true ? '已保存，留空不改' : keyMode === 'required' ? '必填' : '本地服务一般不用填'}
          onChange={(event) => { setApiKey(event.target.value); dirty() }} />
        {engine?.hasKey === true && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void save(null) }}>删除 key</Button>}
      </div>
    </Field>}
    <div className="ql-actions">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{create ? '添加连接' : '保存'}</Button>
      {!create && !confirming && <Button size="sm" variant="ghost" disabled={busy || users.length > 0}
        title={users.length > 0 ? `${users.map(item => item.name).join('、')}在用这个连接` : undefined}
        onClick={() => { setConfirming(true) }}>删除</Button>}
    </div>
    {!create && confirming && <div className="ql-state ql-warn">
      <span>删除这个连接和它的 key。</span>
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { void run({ action: 'engine.remove', id: engine.id }).then((ok) => { if (ok !== false) onRemoved() }) }}>确认删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>取消</Button>
    </div>}
  </div>
}

const BLANK_PARAMS: VoiceParams = { reference: '', promptText: '', promptLang: 'zh', textLang: 'zh' }
function VoiceForm({ voice, entry, busy, run, onDirty, onSaved, onRemoved }: {
  readonly voice: VoiceState
  readonly entry: VoiceEntry | undefined
  readonly busy: boolean
  readonly run: (action: VoiceAction) => Promise<string | undefined | false>
  readonly onDirty: (dirty: boolean) => void
  readonly onSaved: (id: string) => void
  readonly onRemoved: () => void
}) {
  const create = entry === undefined
  const [name, setName] = useState(entry?.name ?? freeName('新音色', voice.voices))
  const [engineId, setEngineId] = useState(entry?.engine ?? voice.engines[0]?.id ?? '')
  const [params, setParams] = useState<VoiceParams>(entry?.params ?? BLANK_PARAMS)
  const [confirming, setConfirming] = useState(false)
  const engine = voice.engine(engineId)
  const edit = (patch: Partial<VoiceParams>) => { setParams(p => ({ ...p, ...patch })); onDirty(true) }
  const draft: VoiceDraft | undefined = engine === undefined || params.reference.trim() === ''
    ? undefined
    : { ...create ? {} : { id: entry.id }, name: name.trim() || '试听', engine: engine.id, params }
  const save = async () => {
    const saved = await run({ action: 'voice.save', voice: { ...create ? {} : { id: entry.id }, name, engine: engineId, params } })
    if (typeof saved === 'string') onSaved(saved)
  }

  return <div className="ql-form">
    <div className="ql-grid">
      <Field label="名称">
        <input value={name} onChange={(event) => { setName(event.target.value); onDirty(true) }} />
      </Field>
      <Field label="连接">
        <select value={engineId} onChange={(event) => { setEngineId(event.target.value); onDirty(true) }}>
          {voice.engines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>
    </div>
    {engine?.kind === 'fish' && <Field label="音色 ID" hint="Fish Audio 音色页地址里的 32 位 ID，也可以直接粘贴整个地址">
      <input value={params.reference} onChange={(event) => { edit({ reference: fishReference(event.target.value.trim()) }) }} />
    </Field>}
    {engine?.kind === 'openai' && <Field label="音色名称" hint="服务支持的 voice，例如 alloy">
      <input value={params.reference} onChange={(event) => { edit({ reference: event.target.value }) }} />
    </Field>}
    {engine?.kind === 'gpt-sovits' && <>
      <Field label="参考音频路径" hint="运行 GPT-SoVITS 的那台电脑上的路径">
        <input value={params.reference} placeholder="D:\GPT-SoVITS\ref\小雅.wav" onChange={(event) => { edit({ reference: event.target.value }) }} />
      </Field>
      <Field label="参考音频的文字">
        <input value={params.promptText} onChange={(event) => { edit({ promptText: event.target.value }) }} />
      </Field>
      <div className="ql-grid">
        <Field label="参考音频的语言">
          <select value={params.promptLang} onChange={(event) => { const lang = SOVITS_LANGS.find(l => l === event.target.value); if (lang !== undefined) edit({ promptLang: lang }) }}>
            {SOVITS_LANGS.map(l => <option key={l} value={l}>{SOVITS_LANG_LABELS[l]}</option>)}
          </select>
        </Field>
        <Field label="朗读语言">
          <select value={params.textLang} onChange={(event) => { const lang = SOVITS_LANGS.find(l => l === event.target.value); if (lang !== undefined) edit({ textLang: lang }) }}>
            {SOVITS_LANGS.map(l => <option key={l} value={l}>{SOVITS_LANG_LABELS[l]}</option>)}
          </select>
        </Field>
      </div>
    </>}
    <Preview voice={voice} draft={draft} />
    <div className="ql-actions">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{create ? '添加音色' : '保存'}</Button>
      {!create && !confirming && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setConfirming(true) }}>删除</Button>}
    </div>
    {!create && confirming && <div className="ql-state ql-warn">
      <span>选了它的角色之后显示文字。</span>
      <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { void run({ action: 'voice.remove', id: entry.id }).then((ok) => { if (ok !== false) onRemoved() }) }}>确认删除</Button>
      <Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>取消</Button>
    </div>}
  </div>
}

/** 朗读设置：每改一项立即保存。 */
function VoiceSettingsForm({ voice, busy, run }: {
  readonly voice: VoiceState
  readonly busy: boolean
  readonly run: (action: VoiceAction) => Promise<string | undefined | false>
}) {
  const settings = voice.settings
  const save = (patch: Partial<VoiceSettings>) => { void run({ action: 'settings.save', settings: { ...voice.settings, ...patch } }) }
  return <div className="ql-actions">
    <label className="ql-toggle">
      <input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(event) => { save({ enabled: event.target.checked }) }} />
      <span>语音</span>
    </label>
    <select value={settings.display} disabled={busy || !settings.enabled} aria-label="显示方式"
      onChange={(event) => { const display = VOICE_DISPLAYS.find(d => d === event.target.value); if (display !== undefined) save({ display }) }}>
      {VOICE_DISPLAYS.map(d => <option key={d} value={d}>{VOICE_DISPLAY_LABELS[d]}</option>)}
    </select>
    <label className="ql-toggle" title="关掉时点了语音条才生成，按字数计费的服务可以省一些">
      <input type="checkbox" checked={settings.pregenerate} disabled={busy || !settings.enabled}
        onChange={(event) => { save({ pregenerate: event.target.checked }) }} />
      <span>新回复提前生成</span>
    </label>
    <label className="ql-toggle">
      <span>音量</span>
      <input type="range" min={0} max={1} step={0.05} defaultValue={settings.volume} disabled={busy || !settings.enabled}
        onPointerUp={(event) => { save({ volume: Number(event.currentTarget.value) }) }}
        onKeyUp={(event) => { save({ volume: Number(event.currentTarget.value) }) }} />
    </label>
  </div>
}

type Selection = { readonly kind: 'engine' | 'voice'; readonly id?: string }

/** "语音"页。onDirty 交给编辑器：有没保存的改动时，切换标签要先确认。 */
export function VoicePage({ voice, onDirty, guard }: {
  readonly voice: VoiceState
  readonly onDirty: (dirty: boolean) => void
  /** 有没保存的改动时先确认，确认后才执行。 */
  readonly guard: (next: () => void) => void
}) {
  useSyncExternalStore(voice.subscribe, voice.getVersion)
  const { busy, error, run } = useVoiceAction(voice)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [selection, setSelection] = useState<Selection | undefined>()
  const [revision, setRevision] = useState(0)
  useEffect(() => { voice.reload().catch((caught: unknown) => { setLoadError(messageOf(caught)) }) }, [voice])

  if (loadError !== undefined && !voice.ready) return <div className="ql-state ql-warn">{loadError}</div>
  if (!voice.ready) return <div className="ql-empty">加载中…</div>
  const fallback: Selection = voice.voices[0] !== undefined ? { kind: 'voice', id: voice.voices[0].id }
    : voice.engines.length === 0 ? { kind: 'engine' } : { kind: 'voice' }
  const selected = selection ?? fallback
  const go = (next: Selection | undefined) => { guard(() => { onDirty(false); setSelection(next) }) }
  const done = (next: Selection | undefined) => { onDirty(false); setSelection(next); setRevision(n => n + 1) }
  const formProps = { voice, busy, run, onDirty }
  const engine = selected.kind === 'engine' && selected.id !== undefined ? voice.engine(selected.id) : undefined
  const entry = selected.kind === 'voice' && selected.id !== undefined ? voice.voice(selected.id) : undefined
  const missing = selected.id !== undefined && engine === undefined && entry === undefined

  return <div className="ql-form">
    <VoiceSettingsForm voice={voice} busy={busy} run={run} />
    {error !== undefined && <div className="ql-state ql-warn">{error}</div>}
    <div className="ql-main">
      <div className="ql-list">
        <div className="ql-empty">音色</div>
        {voice.voices.map(item => <button key={item.id} type="button" className="ql-row"
          aria-current={selected.kind === 'voice' && selected.id === item.id} onClick={() => { go({ kind: 'voice', id: item.id }) }}>
          <span className="ql-name">{item.name}</span>
        </button>)}
        <Button size="sm" variant="outline" disabled={voice.engines.length === 0} title={voice.engines.length === 0 ? '先添加一个连接' : undefined}
          onClick={() => { go({ kind: 'voice' }) }}>添加音色</Button>
        <div className="ql-empty" style={{ marginTop: 12 }}>连接</div>
        {voice.engines.map(item => <button key={item.id} type="button" className="ql-row"
          aria-current={selected.kind === 'engine' && selected.id === item.id} onClick={() => { go({ kind: 'engine', id: item.id }) }}>
          <span className="ql-name">{item.name}</span>
        </button>)}
        <Button size="sm" variant="outline" onClick={() => { go({ kind: 'engine' }) }}>添加连接</Button>
      </div>
      {missing
        ? <div className="ql-empty">已经不在了，可能已在别处删除。</div>
        : selected.kind === 'engine'
          ? <EngineForm key={`${engine?.id ?? 'new'}:${revision}`} {...formProps} engine={engine}
            onSaved={(id) => { done({ kind: 'engine', id }) }} onRemoved={() => { done(undefined) }} />
          : voice.engines.length === 0
            ? <div className="ql-empty">先添加一个连接。</div>
            : <VoiceForm key={`${entry?.id ?? 'new'}:${revision}`} {...formProps} entry={entry}
              onSaved={(id) => { done({ kind: 'voice', id }) }} onRemoved={() => { done(undefined) }} />}
    </div>
  </div>
}

/** 角色表单里的音色。value 为空表示不用语音。 */
export function RoleVoiceField({ voice, value, onChange, onManage }: {
  readonly voice: VoiceState
  readonly value: string | undefined
  readonly onChange: (value: string | undefined) => void
  /** 打开"语音"页。 */
  readonly onManage: () => void
}) {
  useSyncExternalStore(voice.subscribe, voice.getVersion)
  useEffect(() => { if (!voice.ready) voice.reload().catch(() => {}) }, [voice])
  const missing = value !== undefined && voice.ready && voice.voice(value) === undefined
  return <div className="ql-field">
    <span>音色</span>
    <div className="ql-actions">
      <select value={value ?? ''} onChange={(event) => { onChange(event.target.value === '' ? undefined : event.target.value) }}>
        <option value="">不用语音</option>
        {missing && <option value={value}>（已删除）</option>}
        {voice.voices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <Button size="sm" variant="ghost" onClick={onManage}>{voice.voices.length === 0 ? '添加音色' : '管理音色'}</Button>
    </div>
  </div>
}
