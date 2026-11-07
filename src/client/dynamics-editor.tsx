import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LibraryRoleDraft } from '../library-types.ts'
import { validateConfig, initialValues } from '../role-dynamics/validate.ts'
import { diagnose } from '../role-dynamics/projection.ts'
import type { RoleDynamicsConfig } from '../role-dynamics/types.ts'
import { LIBRARY_STATE_PATH, type StateView } from '../role-dynamics/api-types.ts'
import { ActionDialog } from './action-dialog.tsx'
import { RoleStateDialog, STATE_CSS } from './role-state.tsx'

export const MINIMAL_DYNAMICS: RoleDynamicsConfig = {
  version: 1, enabled: true,
  fields: [{ name: '好感', type: 'number', initial: 20, min: 0, max: 100, visible: true, aiWritable: true, updateRule: '根据本轮互动调整好感。' }],
  entries: [{ name: '熟悉', when: { field: '好感', op: 'gte', value: 30 }, text: '对话更亲近自然。' }],
}
export const DYNAMICS_CSS = `
${STATE_CSS}
.dsh-qqbot-library .ql-dynamics .ql-group-body { gap:8px; }
.dsh-qqbot-library .ql-dynamics-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-qqbot-library .ql-dynamics-actions select { max-width:min(240px,100%); }
.dsh-qqbot-library .ql-dynamics-values { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 24px; margin:0; }
.dsh-qqbot-library .ql-dynamics-values > div { display:flex; align-items:baseline; gap:8px; min-width:0; }
.dsh-qqbot-library .ql-dynamics-values dt { color:var(--dsw-alias-label-secondary); flex:none; }
.dsh-qqbot-library .ql-dynamics-values dd { margin:0; min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; }
.dsh-qqbot-library .ql-dynamics-values .ql-dynamics-matched { grid-column:1/-1; }
[role="dialog"].dsh-qqbot-dynamics-config { width:min(680px,100%); }
.dsh-qqbot-dynamics-config textarea { box-sizing:border-box; width:100%; min-height:280px; max-height:55vh; resize:vertical; padding:8px 10px; border:1px solid var(--dsw-alias-border-l4); border-radius:8px; background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); font:14px/22px var(--dsw-font-mono,monospace); }
.dsh-qqbot-dynamics-config .ql-warn { color:var(--dsw-alias-state-warn-label); overflow-wrap:anywhere; }
@media(max-width:600px) { .dsh-qqbot-library .ql-dynamics-values { grid-template-columns:minmax(0,1fr); } }
`
export interface DynamicsContext {
  catalog: { subscribe(listener: () => void): () => void; getSnapshot(): SessionListState }
  current?: string | undefined
}
export interface DynamicsDraft { text: string; touched: boolean; removed: boolean }
export const dynamicsDraft = (config?: RoleDynamicsConfig | null): DynamicsDraft => ({ text: config ? JSON.stringify(config, null, 2) : '', touched: false, removed: false })
export function dynamicsPatch(value: DynamicsDraft, baseRevision?: string): Partial<LibraryRoleDraft> {
  if (!value.touched) return {}
  return { dynamics: value.removed ? null : validateConfig(JSON.parse(value.text)),
    ...(baseRevision === undefined ? {} : { dynamicsBaseRevision: baseRevision }) }
}
const NO_SUBSCRIBE = () => () => {}
const NO_CATALOG = () => undefined
async function getState(query: URLSearchParams, signal: AbortSignal): Promise<{ sessions?: string[]; state?: StateView }> {
  const response = await fetch(`${LIBRARY_STATE_PATH.slice(1)}?${query}`, { cache:'no-store', signal })
  const result = await response.json() as { sessions?: string[]; state?: StateView; message?: string }
  if (!response.ok) throw new Error(result.message ?? '读取状态失败')
  return result
}
export function DynamicsEditor({ value, onChange, error, disabled, roleId, context, onPendingChange }: {
  value: DynamicsDraft; onChange(value: DynamicsDraft): void; error?: string | undefined; disabled: boolean
  roleId?: string | undefined; context?: DynamicsContext | undefined; onPendingChange?: ((dirty: boolean) => void) | undefined
}) {
  const catalog = useSyncExternalStore(context?.catalog.subscribe ?? NO_SUBSCRIBE, context?.catalog.getSnapshot ?? NO_CATALOG)
  const [editor, setEditor] = useState<string>(), [problem, setProblem] = useState<string>()
  const [discard, setDiscard] = useState(false), [remove, setRemove] = useState(false), [stateOpen, setStateOpen] = useState(false)
  const [ids, setIds] = useState<string[]>([]), [session, setSession] = useState(''), [state, setState] = useState<StateView>()
  const [catalogError, setCatalogError] = useState<string>(), [stateError, setStateError] = useState<string>(), [reload, setReload] = useState(0)
  let valid: RoleDynamicsConfig | undefined, invalid: string | undefined
  if (value.text && !value.removed) {
    try { valid = validateConfig(JSON.parse(value.text)) } catch (reason) { invalid = reason instanceof Error ? reason.message : '配置无效' }
  }
  const configKey = valid === undefined ? '' : JSON.stringify(valid)
  const editorDirty = editor !== undefined && editor !== value.text
  useEffect(() => { onPendingChange?.(editorDirty); return () => onPendingChange?.(false) }, [editorDirty, onPendingChange])
  useEffect(() => {
    if (!roleId || !valid || value.touched) { setIds([]); setSession(''); return }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const query = new URLSearchParams({ roleId }); if (context?.current) query.set('current', context.current)
        const result = await getState(query, controller.signal)
        if (!controller.signal.aborted) {
          const next = result.sessions ?? []; setIds(next)
          setSession(previous => next.includes(previous) ? previous : context?.current && next.includes(context.current) ? context.current : next[0] ?? '')
          setCatalogError(undefined)
        }
      } catch (reason) { if (!controller.signal.aborted) { setState(undefined); setCatalogError(reason instanceof Error ? reason.message : String(reason)) } }
      if (!controller.signal.aborted) timer = setTimeout(() => { void load() }, 5000)
    }
    void load(); return () => { controller.abort(); clearTimeout(timer) }
  }, [roleId, context?.current, configKey, value.touched, reload])
  const sessions = ids.filter(id => {
    const row = catalog?.byId[id as keyof NonNullable<typeof catalog>['byId']]
    return row?.projectionValues?.agentPreset === 'qqbot'
  })
  const selected = sessions.includes(session) ? session : sessions[0] ?? ''
  useEffect(() => {
    setState(undefined); setStateError(undefined)
    if (!roleId || !selected || value.touched) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const result = await getState(new URLSearchParams({ roleId, session:selected, preview:'1' }), controller.signal)
        if (!controller.signal.aborted) { setState(result.state); setStateError(undefined) }
      } catch (reason) { if (!controller.signal.aborted) { setState(undefined); setStateError(reason instanceof Error ? reason.message : String(reason)) } }
      if (!controller.signal.aborted) timer = setTimeout(() => { void load() }, 3000)
    }
    void load(); return () => { controller.abort(); clearTimeout(timer) }
  }, [roleId, selected, configKey, value.touched, reload])
  const current = !catalogError && state?.roleId === roleId && state?.snapshot.sessionId === selected && JSON.stringify(state.config) === configKey ? state : undefined
  const values = valid ? current?.snapshot.values ?? initialValues(valid) : {}
  const matched = valid?.enabled ? diagnose(valid, values).filter(item => item.matched).map(item => item.name) : []
  const close = () => { if (editorDirty) setDiscard(true); else { setEditor(undefined); setProblem(undefined) } }
  const apply = () => {
    try {
      const next = validateConfig(JSON.parse(editor!))
      onChange({ text:JSON.stringify({ ...next, enabled:true }, null, 2), touched:true, removed:false })
      setEditor(undefined); setProblem(undefined)
    } catch (reason) { setProblem(reason instanceof Error ? reason.message : '配置无效') }
  }
  return <details className="ql-group qq-settings-fold ql-dynamics" open>
    <summary><strong>动态设定</strong></summary>
    <div className="ql-group-body">
      {!value.text || value.removed ? <div className="ql-dynamics-actions"><Button size="sm" variant="outline" disabled={disabled}
        onClick={() => { setEditor(JSON.stringify(MINIMAL_DYNAMICS, null, 2)); setProblem(undefined) }}>添加动态设定</Button></div> : <>
        <div className="ql-dynamics-actions">
          <select aria-label="状态所属对话" value={selected} disabled={disabled || !sessions.length || value.touched}
            onChange={event => { setSession(event.target.value); setState(undefined) }}>
            {!sessions.length && <option value="">初始状态</option>}
            {sessions.map(id => <option key={id} value={id}>{catalog?.byId[id as keyof NonNullable<typeof catalog>['byId']]?.title || '未命名对话'}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={disabled || !selected || !current || !valid?.enabled || value.touched} title={value.touched ? '先保存角色' : undefined}
            onClick={() => setStateOpen(true)}>编辑数值</Button>
        </div>
        {valid && <dl className="ql-dynamics-values">
          {valid.fields.map(field => <div key={field.name}><dt>{field.name}</dt><dd>{selected && !current && !value.touched ? '…'
            : typeof values[field.name] === 'boolean' ? values[field.name] ? '是' : '否'
            : `${String(values[field.name] ?? '')}${field.type === 'number' && field.min === 0 && field.max !== undefined ? ` / ${field.max}` : ''}`}</dd></div>)}
          <div className="ql-dynamics-matched"><dt>生效设定</dt><dd>{selected && !current && !value.touched ? '…' : matched.join('、') || '无'}</dd></div>
        </dl>}
      </>}
      {(error || invalid || catalogError || stateError) && <p className="ql-warn" role="alert">{error || invalid || catalogError || stateError}</p>}
      {!!value.text && !value.removed && <div className="ql-dynamics-actions">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setEditor(value.text); setProblem(undefined) }}>修改设定</Button>
      </div>}
    </div>
    {editor !== undefined && <Modal open title="动态设定" closeLabel="关闭" className="dsh-qqbot-dynamics-config" onClose={close}
      footer={<><Button variant="outline" onClick={close}>取消</Button>
        {!!value.text && !value.removed && <Button variant="outline" onClick={() => setRemove(true)}>移除动态设定</Button>}
        <Button variant="primary" onClick={apply}>确定</Button></>}>
      <textarea aria-label="动态设定配置" spellCheck={false} value={editor} onChange={event => { setEditor(event.target.value); setProblem(undefined) }} />
      {problem && <p className="ql-warn" role="alert">{problem}</p>}
      {discard && <ActionDialog title="放弃未应用的改动？" cancelLabel="继续编辑" confirmLabel="放弃改动" onCancel={() => setDiscard(false)}
        onConfirm={() => { setDiscard(false); setEditor(undefined); setProblem(undefined) }}>动态设定的改动尚未应用。</ActionDialog>}
      {remove && <ActionDialog title="移除动态设定？" cancelLabel="取消" confirmLabel="移除" onCancel={() => setRemove(false)}
        onConfirm={() => { onChange({ ...value, touched:true, removed:true }); setRemove(false); setEditor(undefined) }}>保存角色后会移除动态设定及其进度。</ActionDialog>}
    </Modal>}
    {stateOpen && selected && <RoleStateDialog session={selected} roleId={roleId} onDirtyChange={onPendingChange}
      onApplied={() => setReload(n => n+1)} onClose={() => { setStateOpen(false); setReload(n => n+1) }} />}
  </details>
}
