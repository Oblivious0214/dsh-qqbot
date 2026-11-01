/** 文件只经认证的插件接口处理，不直接改磁盘；先预览，确认后才提交。 */
import { writeHeaders } from './cleanup-epoch.ts'
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { CONFIG_PATH, type ConfigOptions, type ConfigPreview, type ConfigRequest, type ConfigResult } from '../config-types.ts'
import type { LibraryView } from '../library-types.ts'
import { ACTION_DIALOG_CLASS, ActionDialog } from './action-dialog.tsx'
import { ConfigPasswordError, readConfigFile } from './config-file.ts'

async function request(body: ConfigRequest, signal?: AbortSignal): Promise<{ preview?: ConfigPreview; imported?: ConfigResult; library?: LibraryView }> {
  const response = await fetch(CONFIG_PATH, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body), ...signal === undefined ? {} : { signal } })
  const result = await response.json() as { message?: string; preview?: ConfigPreview; imported?: ConfigResult; library?: LibraryView }
  if (!response.ok) throw new Error(result.message ?? '配置导入失败，请重试')
  return result
}

export function ConfigImport({ onClose, onImported }: {
  readonly onClose: () => void
  readonly onImported: (view: LibraryView, result: ConfigResult) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)
  const reading = useRef(0)
  const readAbort = useRef<AbortController>()
  const unlocking = useRef(false)
  const [locked, setLocked] = useState<{ file: File; error?: string }>()
  const [fileName, setFileName] = useState('')
  const [config, setConfig] = useState<unknown>()
  const [options, setOptions] = useState<ConfigOptions>({ presets: true, roles: true, conflict: 'skip' })
  const [preview, setPreview] = useState<ConfigPreview>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const changeOptions = (next: ConfigOptions) => { setPreview(undefined); setLoading(true); setOptions(next) }
  // 中断解压，并用序号防止已关闭弹窗或旧文件的结果覆盖当前选择。
  useEffect(() => () => { reading.current++; readAbort.current?.abort() }, [])
  useEffect(() => {
    setPreview(undefined)
    if (config === undefined) return
    const abort = new AbortController()
    setLoading(true)
    setError(undefined)
    request({ action: 'preview', config, options }, abort.signal).then(result => {
      if (!abort.signal.aborted) {
        if (result.preview === undefined) throw new Error('没有收到配置预览，请重试')
        setPreview(result.preview)
      }
    }).catch((error: unknown) => { if (!abort.signal.aborted) setError(messageOf(error)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [config, options, retry])
  const choose = async (file: File | undefined, password?: string) => {
    if (file === undefined) return
    readAbort.current?.abort()
    const abort = new AbortController()
    readAbort.current = abort
    const generation = ++reading.current
    setConfig(undefined)
    setPreview(undefined)
    setError(undefined)
    setFileName(file.name)
    setLoading(true)
    try {
      const parsed = await readConfigFile(file, abort.signal, password)
      if (generation !== reading.current) return
      setLocked(undefined)
      setConfig(parsed)
    } catch (error) {
      if (generation === reading.current) {
        if (error instanceof ConfigPasswordError) setLocked({ file, ...error.retry ? { error: error.message } : {} })
        else { setLocked(undefined); setError(messageOf(error)) }
        setLoading(false)
      }
    }
  }
  const cancelPassword = () => { reading.current++; readAbort.current?.abort(); setLocked(undefined); setLoading(false) }
  const confirm = async () => {
    if (submitting.current || preview === undefined || loading) return
    submitting.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await request({ action: 'import', config, options, revision: preview.revision })
      if (result.library === undefined || result.imported === undefined) throw new Error('未收到导入结果，请重新预览检查资料库')
      onImported(result.library, result.imported)
    } catch (error) {
      setError(messageOf(error))
      setPreview(undefined)
    } finally { submitting.current = false; setBusy(false) }
  }
  const additions = preview?.entries.filter(entry => entry.status === 'add').length ?? 0
  return <><ActionDialog title="导入配置" cancelLabel="关闭" confirmLabel="确认导入" busy={busy} error={error}
    confirmDisabled={loading || additions === 0} onCancel={onClose} onConfirm={() => { void confirm() }}>
    <div className="qc-import">
      <input ref={input} type="file" accept=".json,.zip,application/json,application/zip,application/x-zip-compressed" hidden aria-label="配置文件"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file) }} />
      <div><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => { input.current?.click() }}>选择配置文件</Button></div>
      {fileName && <div className="qc-filename">{fileName}</div>}
      {config !== undefined && <fieldset disabled={busy || loading} className="qc-options qq-settings-row">
        <label><input type="checkbox" checked={options.presets} onChange={e => { changeOptions({ ...options, presets: e.target.checked }) }} />通用提示词</label>
        <label><input type="checkbox" checked={options.roles} onChange={e => { changeOptions({ ...options, roles: e.target.checked }) }} />角色</label>
        <label>重名时<select value={options.conflict} onChange={e => { changeOptions({ ...options, conflict: e.target.value === 'copy' ? 'copy' : 'skip' }) }}>
          <option value="skip">跳过已有内容</option><option value="copy">另存一份</option>
        </select></label>
      </fieldset>}
      {loading && <div role="status">正在读取预览…</div>}
      {preview !== undefined && <>
        <div role="status">新增 {additions} 项，跳过 {preview.entries.length - additions} 项</div>
        <ul className="qc-preview" aria-label="导入预览">{preview.entries.map((entry, index) => <li key={index}>
          <span>{entry.kind === 'preset' ? '通用提示词' : '角色'} · {entry.target}</span>
          <small>{entry.status === 'skip' ? '跳过' : entry.name !== entry.target ? '另存' : '新增'}</small>
        </li>)}</ul>
      </>}
      {error !== undefined && config !== undefined && <div><Button size="sm" variant="outline" disabled={busy || loading}
        onClick={() => { setRetry(n => n + 1) }}>重新预览</Button></div>}
    </div>
  </ActionDialog>
    {locked !== undefined && <PasswordDialog busy={loading} error={locked.error} onCancel={cancelPassword} onUnlock={async password => {
      if (unlocking.current) return
      unlocking.current = true
      try { await choose(locked.file, password) } finally { unlocking.current = false }
    }} />}
  </>
}

function PasswordDialog({ busy, error, onCancel, onUnlock }: {
  readonly busy: boolean; readonly error: string | undefined; readonly onCancel: () => void
  readonly onUnlock: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) input.current?.focus()
    wasBusy.current = busy
  }, [busy])
  const submit = () => { if (!busy && password.length > 0) { const value = password; setPassword(''); void onUnlock(value) } }
  return <Modal open title="输入 ZIP 密码" closeLabel="关闭" className={ACTION_DIALOG_CLASS} backdropBlur={false} onClose={onCancel}
    footer={<><Button variant="outline" onClick={onCancel}>取消</Button>
      <Button variant="primary" disabled={busy || password.length === 0} onClick={submit}>{busy ? '正在解密…' : '解锁'}</Button></>}>
    <label className="qc-password qq-settings-field">密码<input ref={input} type="password" value={password} data-modal-autofocus="" autoComplete="off" disabled={busy}
      onChange={e => { setPassword(e.target.value) }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} /></label>
    {error !== undefined && <div className="qa-message qa-error" role="alert">{error}</div>}
  </Modal>
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
