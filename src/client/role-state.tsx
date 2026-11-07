import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { STATE_PATH, LIBRARY_STATE_PATH, type StateView } from '../role-dynamics/api-types.ts'
import type { StateValue } from '../role-dynamics/types.ts'
import { ActionDialog } from './action-dialog.tsx'
export const STATE_CLASS = 'dsh-qqbot-role-state'
export const STATE_CSS = `
[role="dialog"].${STATE_CLASS} { width:min(520px,100%); max-height:100%; }
.${STATE_CLASS} .qd-body { display:flex; flex-direction:column; gap:12px; min-width:0; overflow:auto; }
.${STATE_CLASS} .qd-field { display:flex; flex-wrap:wrap; align-items:center; gap:10px; min-width:0; }
.${STATE_CLASS} .qd-field > span { overflow-wrap:anywhere; }
.${STATE_CLASS} input:not([type="checkbox"]), .${STATE_CLASS} select, .${STATE_CLASS} textarea { box-sizing:border-box; width:220px; max-width:100%; min-width:0; padding:6px 8px; font:inherit; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3); border:1px solid var(--dsw-alias-border-l4); border-radius:8px; }
.${STATE_CLASS} .qd-error { color:var(--dsw-alias-state-warn-label); overflow-wrap:anywhere; }
`
async function requestState(session: string, signal: AbortSignal, body?: unknown, epoch?: string, roleId?: string): Promise<StateView> {
  const path = roleId === undefined ? STATE_PATH : LIBRARY_STATE_PATH
  const response = await fetch(`${path.slice(1)}?session=${encodeURIComponent(session)}${roleId === undefined ? '' : `&roleId=${encodeURIComponent(roleId)}`}`, {
    cache: 'no-store', signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-qqbot-data-epoch': epoch ?? '' }, body: JSON.stringify(body) }),
  })
  const result = await response.json() as { state?: StateView; message?: string }
  if (!response.ok || !result.state) throw new Error(result.message ?? '当前角色没有启用动态设定')
  return result.state
}
export function RoleStateDialog({ session, roleId, onClose, onApplied, onDirtyChange }: {
  session: string; roleId?: string | undefined; onClose(): void
  onApplied?: ((state: StateView) => void) | undefined; onDirtyChange?: ((dirty: boolean) => void) | undefined
}) {
  const [view, setView] = useState<StateView>()
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [discard, setDiscard] = useState<'close' | 'reload'>()
  const abort = useRef<AbortController | undefined>(undefined)
  const adopt = (state: StateView) => {
    setView(state); setValues(Object.fromEntries(state.config.fields.map(field => [field.name,
      typeof state.snapshot.values[field.name] === 'boolean' ? state.snapshot.values[field.name] as boolean : String(state.snapshot.values[field.name])]))); setDirty(false)
  }
  const load = () => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller
    setBusy(true); setError(undefined)
    void requestState(session, controller.signal, undefined, undefined, roleId).then(state => { if (!controller.signal.aborted) adopt(state) }, reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
  }
  useEffect(() => { load(); return () => { abort.current?.abort() } }, [session, roleId])
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn); return () => { window.removeEventListener('beforeunload', warn) }
  }, [dirty, busy])
  const close = () => { if (!busy) { if (dirty) setDiscard('close'); else onClose() } }
  const save = async () => {
    if (!view || busy) return
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller
    setBusy(true); setError(undefined)
    try {
      const changes = view.config.fields.map(field => {
        const raw = values[field.name]
        if (field.type === 'number' && (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(Number(raw)))) throw new Error(`${field.name}需要填写数字`)
        return { name: field.name, value: (field.type === 'number' ? Number(raw) : raw) as StateValue }
      }).filter(change => change.value !== view.snapshot.values[change.name])
      if (!changes.length) { setDirty(false); return }
      const { revision, configRevision, dataEpoch, progressId, generation } = view.snapshot
      const next = await requestState(session, controller.signal, { session, roleId: view.roleId,
        operation: { operationId: crypto.randomUUID(), baseRevision: revision, configRevision, dataEpoch, progressId, generation, changes } }, dataEpoch, roleId)
      if (!controller.signal.aborted) { adopt(next); onApplied?.(next) }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  return <Modal open title={view ? `${view.name} · 当前状态` : '当前状态'} closeLabel="关闭" className={STATE_CLASS} onClose={close}
    footer={<><Button variant="outline" disabled={busy} onClick={close}>关闭</Button>
      <Button variant="outline" disabled={busy} onClick={() => { if (dirty) setDiscard('reload'); else load() }}>重新读取</Button>
      <Button variant="primary" disabled={busy || !view || !dirty} onClick={() => { void save() }}>{busy ? '处理中…' : '应用'}</Button></>}>
    <div className="qd-body">
      {view?.config.fields.map(field => <label className="qd-field" key={field.name}><span>{field.name}</span>
        {field.type === 'boolean' ? <input type="checkbox" aria-label={field.name} disabled={busy} checked={values[field.name] === true}
          onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.checked })); setDirty(true) }} />
          : field.type === 'choice' ? <select aria-label={field.name} disabled={busy} value={String(values[field.name] ?? '')}
            onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setDirty(true) }}>
            {field.options.map(option => <option key={option}>{option}</option>)}</select>
            : <input aria-label={field.name} inputMode={field.type === 'number' ? 'decimal' : 'text'} disabled={busy} value={String(values[field.name] ?? '')}
              onChange={event => { setValues(current => ({ ...current, [field.name]: event.target.value })); setDirty(true) }} />}
      </label>)}
      {error && <p className="qd-error" role="alert">{error}</p>}
      {view && <details><summary>生效设定</summary>{view.config.entries.map(entry => {
        const matched = (view.diagnosis as { name: string; matched: boolean }[]).find(item => item.name === entry.name)?.matched
        return <p key={entry.name}>{entry.name}：{matched ? '生效' : '未生效'}</p>
      })}</details>}
    </div>
    {discard && <ActionDialog title="放弃未应用的改动？" cancelLabel="继续编辑" confirmLabel="放弃改动"
      onCancel={() => setDiscard(undefined)} onConfirm={() => { if (discard === 'reload') { setDiscard(undefined); load() } else onClose() }}>当前状态的改动尚未应用。</ActionDialog>}
  </Modal>
}
