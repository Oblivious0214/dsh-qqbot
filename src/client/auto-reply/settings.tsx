import { writeHeaders } from '../cleanup-epoch.ts'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { AUTO_REPLY_PATH, AUTO_REPLY_PROMPT_LIMIT, QUICK_REPLY_PROMPT_LIMIT, DEFAULT_OPTIONS, parseOptions, type AutoReplyPromptView, type QuickReplyClickMode } from '../../auto-reply/types.ts'
import type { UiExtensionProps } from '../ui-extensions.tsx'
import { TextEditor } from '../text-editor.tsx'
import { SwitchRow } from '../switch.tsx'
import type { AutoReplySessions } from './sessions.ts'
import type { QuickReplyState } from './quick-state.ts'

async function requestPrompt(session: string, action: string, prompt?: string, signal?: AbortSignal): Promise<AutoReplyPromptView> {
  const response = await fetch(AUTO_REPLY_PATH, { method: 'POST', headers: writeHeaders(),
    body: JSON.stringify({ session, action, prompt }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
  const view = await response.json() as AutoReplyPromptView & { message?: string }
  if (!response.ok) throw new Error(view.message || '提示词暂不可用。')
  return view
}

function PromptEditor({ session, kind, label, limit, onBusy, onDirty }: UiExtensionProps & {
  session: string; kind: 'prompt' | 'quick.prompt'; label: string; limit: number
}) {
  const [prompt, setPrompt] = useState('')
  const [savedPrompt, setSavedPrompt] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const dirty = savedPrompt !== undefined && prompt !== savedPrompt
  useEffect(() => {
    const abort = new AbortController()
    void requestPrompt(session, `${kind}.get`, undefined, abort.signal).then(view => {
      if (!abort.signal.aborted) { setPrompt(view.prompt); setSavedPrompt(view.prompt) }
    }, reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => abort.abort()
  }, [session, kind, retry])
  useEffect(() => { onBusy(saving); return () => onBusy(false) }, [saving, onBusy])
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  const save = async (reset = false) => {
    if (lock.current) return
    lock.current = true; setError(''); setSaving(true)
    try {
      const next = await requestPrompt(session, `${kind}.${reset ? 'reset' : 'set'}`, reset ? undefined : prompt)
      setPrompt(next.prompt); setSavedPrompt(next.prompt)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setSaving(false) }
  }
  return <TextEditor label={label} value={prompt} onChange={value => { setPrompt(value); setError('') }} dirty={dirty}
    disabled={savedPrompt === undefined} saving={saving} maxLength={limit} saveDisabled={!prompt.trim()}
    onSave={() => { void save() }} onCancel={() => { setPrompt(savedPrompt!); setError('') }}
    onReset={() => { void save(true) }} error={error}
    after={savedPrompt === undefined && error && <Button size="sm" variant="outline" onClick={() => { setError(''); setRetry(n => n + 1) }}>重新读取</Button>} />
}

export function AutoReplySettings({ session, sessions, quick, onBusy, onDirty }: UiExtensionProps & {
  session: string; sessions: AutoReplySessions; quick: QuickReplyState
}) {
  useSyncExternalStore(sessions.subscribe, sessions.getVersion)
  useSyncExternalStore(quick.subscribe, quick.getVersion)
  const entry = sessions.get(session)
  const [error, setError] = useState('')
  const [autoBusy, setAutoBusy] = useState(false), [quickBusy, setQuickBusy] = useState(false)
  const [autoDirty, setAutoDirty] = useState(false), [quickDirty, setQuickDirty] = useState(false)
  const [wait, setWait] = useState(String(entry?.options.waitSeconds ?? DEFAULT_OPTIONS.waitSeconds))
  const [limit, setLimit] = useState(String(entry?.options.maxReplies ?? DEFAULT_OPTIONS.maxReplies))
  const saving = autoBusy || quickBusy || quick.busy(session)
  const optionsDirty = wait !== String(entry?.options.waitSeconds ?? DEFAULT_OPTIONS.waitSeconds) || limit !== String(entry?.options.maxReplies ?? DEFAULT_OPTIONS.maxReplies)
  const [quickDraft, setQuickDraft] = useState<boolean | QuickReplyClickMode>()
  const [status, setStatus] = useState('')
  const quickLock = useRef(false)
  const dirty = autoDirty || quickDirty || optionsDirty || quickDraft !== undefined
  useEffect(() => {
    const abort = new AbortController()
    void quick.refresh(session).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => abort.abort()
  }, [session, quick])
  useEffect(() => { onBusy(saving); return () => onBusy(false) }, [saving, onBusy])
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  const view = entry?.client.snapshot
  const enabled = view?.enabled === true || entry?.client.starting === true
  const rememberOptions = () => {
    if (!entry) return false
    try {
      const next = parseOptions({ waitSeconds: Number(wait), maxReplies: Number(limit) })
      sessions.setOptions(session, next); setWait(String(next.waitSeconds)); setLimit(String(next.maxReplies)); setError(''); setStatus('')
      return true
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false }
  }
  const enter = (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() }
  const saveQuick = async (value: boolean | QuickReplyClickMode) => {
    if (quickLock.current) return
    quickLock.current = true; setQuickDraft(value); setError(''); setStatus('保存中…')
    try {
      if (typeof value === 'boolean') await quick.set(session, value)
      else await quick.setClickMode(session, value)
      setQuickDraft(undefined); setStatus('')
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setStatus('') }
    finally { quickLock.current = false }
  }
  const toggle = () => {
    if (!entry) return
    setError('')
    if (enabled) { entry.client.stop(); return }
    try {
      const options = parseOptions({ waitSeconds: Number(wait), maxReplies: Number(limit) })
      sessions.setOptions(session, options)
      void entry.client.start(options)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const stateText = view?.message || (view?.remainingSeconds != null ? `下次接话 ${view.remainingSeconds} 秒 · 已接话 ${view.count} / ${limit} 次`
    : view?.status === 'input' ? '等你输入或当前段落显示完毕'
    : view?.status === 'busy' ? '等待回复完成' : enabled ? `已接话 ${view?.count ?? 0} / ${limit} 次` : '')
  return <div className="ql-form ql-chat-assist">
    <section className="qq-section">
      <SwitchRow label="自动接话" title="离开页面或达到次数上限后自动关闭" checked={enabled} disabled={!entry} onChange={toggle} />
      <label className="ql-field ql-inline qq-settings-row"><span>等待时间（秒）</span><input aria-label="等待时间（秒）" type="number" min={10} max={3600}
        value={wait} disabled={enabled} onChange={event => { setWait(event.target.value); setStatus('') }} onBlur={rememberOptions} onKeyDown={enter} /></label>
      <label className="ql-field ql-inline qq-settings-row"><span>最多连续接话（次）</span><input aria-label="最多连续接话（次）" type="number" min={1} max={20}
        value={limit} disabled={enabled} onChange={event => { setLimit(event.target.value); setStatus('') }} onBlur={rememberOptions} onKeyDown={enter} /></label>
      {stateText && <p className="ql-note" role="status">{stateText}</p>}
      <PromptEditor key={`${session}:prompt`} session={session} kind="prompt" label="自动接话提示词" limit={AUTO_REPLY_PROMPT_LIMIT} onBusy={setAutoBusy} onDirty={setAutoDirty} />
    </section>
    <section className="qq-section">
      <SwitchRow label="快捷回复选项" title="每次回复后显示三条建议" checked={typeof quickDraft === 'boolean' ? quickDraft : quick.get(session)} disabled={quick.busy(session) || quickDraft !== undefined} onChange={value => {
        void saveQuick(value)
      }} />
      {(quickDraft === true || quick.get(session)) && <label className="ql-field ql-inline qq-settings-row"><span>点击后</span>
        <select aria-label="快捷回复点击后" value={typeof quickDraft === 'string' ? quickDraft : quick.clickMode(session)} disabled={quick.busy(session) || quickDraft !== undefined}
          onChange={event => { void saveQuick(event.target.value as QuickReplyClickMode) }}>
          <option value="send">直接发送</option><option value="draft">仅填入回复栏</option>
        </select>
      </label>}
      <PromptEditor key={`${session}:quick.prompt`} session={session} kind="quick.prompt" label="快捷回复选项提示词" limit={QUICK_REPLY_PROMPT_LIMIT} onBusy={setQuickBusy} onDirty={setQuickDirty} />
    </section>
    {quickDraft !== undefined && !quick.busy(session) && <Button size="sm" variant="outline" onClick={() => { void saveQuick(quickDraft) }}>重试保存</Button>}
    {status && <span className="qq-settings-status" role="status">{status}</span>}
    {error && <p className="ql-note ql-warn qq-settings-status" role="alert">{error}</p>}
  </div>
}
