import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PHONE_PATH, type PhoneAction, type PhoneView } from '../phone-types.ts'
import { writeHeaders } from './cleanup-epoch.ts'
import type { PhoneGuide } from './phone-guide.ts'
import { PhoneHelp } from './phone-help.tsx'
import { PhoneSettingsState } from './phone-settings-state.ts'

export const isPhonePage = () => document.querySelector('meta[name="qqbot-phone"][content="local"]') !== null
async function request(action?: PhoneAction, signal?: AbortSignal): Promise<PhoneView> {
  const response = await fetch(PHONE_PATH, { cache: 'no-store', ...signal ? { signal } : {},
    ...action ? { method: 'POST', headers: writeHeaders(), body: JSON.stringify(action) } : {} })
  const body = await response.json() as PhoneView & { message?: string; state?: PhoneView }
  if (!response.ok) throw Object.assign(new Error(body.message ?? '手机连接暂时不可用。'), { state: body.state })
  return body
}
export function PhoneSettings({ onBusy, onDirty, guide }: { onBusy(busy: boolean): void; onDirty?(dirty: boolean): void; guide?: PhoneGuide | undefined }) {
  const [helpBusy, setHelpBusy] = useState(false)
  const [state] = useState(() => new PhoneSettingsState(request))
  useSyncExternalStore(state.subscribe, state.getVersion)
  const { view, draft: { mode, address, port, accessCode: code }, error } = state
  const [notice, setNotice] = useState('')
  const phone = isPhonePage(), busy = state.operating
  useEffect(() => { if (!phone) void state.load() }, [state, phone])
  useEffect(() => { onBusy(state.busy || busy || helpBusy); return () => onBusy(false) }, [state.busy, busy, helpBusy, onBusy])
  useEffect(() => { onDirty?.(state.dirty); return () => onDirty?.(false) }, [state.dirty, onDirty])
  const commit = (patch: Partial<typeof state.draft>) => { setNotice(''); void state.commit(patch) }
  const select = (patch: Partial<typeof state.draft>) => { state.edit(patch); commit(patch) }
  const enter = (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNotice('已复制') }
    catch { setNotice('请长按或选中内容复制。') }
  }
  if (phone) return <div className="ql-main"><div className="ql-form"><p className="ql-note">请在电脑上管理手机连接。</p></div></div>
  return <div className="ql-main"><div className="ql-form">
    <section className="qq-section ql-phone">
      <div className="qq-settings-row"><h3>手机</h3>
        <PhoneHelp route={mode} guide={guide} disabled={state.busy || state.dirty || busy || helpBusy} onBusy={setHelpBusy} />
      </div>
      <fieldset className="ql-phone-modes" disabled={!view || view.running || busy || helpBusy} aria-label="连接方式">
        <label><input type="radio" name="qqbot-phone-mode" value="local" checked={mode === 'local'} onChange={() => select({ mode: 'local' })} /><span><strong>局域网</strong><small>手机和电脑在同一个 Wi-Fi 下，电脑上的 DSH 需保持运行。</small></span></label>
        <label><input type="radio" name="qqbot-phone-mode" value="tailscale" checked={mode === 'tailscale'} onChange={() => select({ mode: 'tailscale' })} /><span><strong>远程</strong><small>不在同一个 Wi-Fi 下，例如手机使用流量，电脑上的 DSH 需保持运行。</small></span></label>
      </fieldset>
      {!view ? <>{!error && <span className="ql-note">加载中…</span>}<Button variant="outline" size="sm" onClick={() => { void state.load() }}>重新读取</Button></>
        : <>
          {view.url && !state.dirty && mode === (view.mode ?? 'local') && <label className="ql-field qq-settings-field"><span>手机网址</span><div className="ql-actions qq-settings-actions"><input aria-label="手机网址" readOnly value={view.url} /><Button variant="outline" size="sm" onClick={() => { void copy(view.url) }}>复制网址</Button></div></label>}
          <label className="ql-field qq-settings-field"><span>访问码</span><div className="ql-actions qq-settings-actions"><input aria-label="访问码" type="password" autoComplete="off" value={code} readOnly={view.running} disabled={busy || helpBusy} onChange={event => state.edit({ accessCode: event.target.value })} onBlur={() => { if (code !== view.accessCode) commit({ accessCode: code }) }} onKeyDown={enter} maxLength={128} />
            <Button variant="outline" size="sm" disabled={busy || helpBusy} onClick={() => { void copy(code) }}>复制访问码</Button></div></label>
          <details className="ql-group qq-settings-fold"><summary><strong>连接设置</strong></summary><div className="ql-group-body">
            {mode === 'local' && <label className="ql-field ql-inline qq-settings-row"><span>使用网络</span><select aria-label="使用网络" value={address} disabled={view.running || busy || helpBusy} onChange={event => select({ address: event.target.value })}>
              <option value="">自动选择</option>
              {address && !view.networks.some(n => n.address === address) && <option value={address}>原网络已不可用</option>}
              {view.networks.map(n => <option key={n.address} value={n.address}>{n.name}</option>)}
            </select></label>}
            <label className="ql-field ql-inline qq-settings-row"><span>端口</span><input aria-label="端口" type="number" min="1024" max="65535" value={port} disabled={view.running || busy || helpBusy} onChange={event => state.edit({ port: event.target.value })} onBlur={() => { if (port !== String(view.port)) commit({ port }) }} onKeyDown={enter} /></label>
          </div></details>
          <div className="ql-actions qq-settings-actions"><Button variant="outline" size="sm" disabled={busy || helpBusy} onClick={() => { void state.run(view.running ? 'stop' : 'start') }}>{view.running ? '停止连接' : '启动连接'}</Button>
          {!view.running && error && state.dirty && <Button variant="outline" size="sm" disabled={state.busy || busy || helpBusy} onClick={() => { commit(state.draft) }}>重试保存</Button>}
          {!view.running && view.enabled && <Button variant="outline" size="sm" disabled={busy || helpBusy} onClick={() => { void state.run('stop') }}>关闭自动启动</Button>}</div>
        </>}
      {(error || view?.error) && <div className="ql-warn qq-settings-status" role="alert">{error || view?.error}</div>}
      {(notice || state.status) && <div className="ql-note qq-settings-status" role="status">{notice || state.status}</div>}
    </section>
  </div></div>
}

export const PHONE_SETTINGS_CSS = `
.dsh-qqbot-library .ql-phone-modes { display: flex; flex-direction: row; gap: 12px; border: 0; padding: 0; margin: 0; min-width: 0; }
.dsh-qqbot-library .ql-phone-modes label { display: flex; flex: 1; min-width: 0; gap: 8px; align-items: flex-start; cursor: pointer; }
.dsh-qqbot-library .ql-phone-modes input { flex: none; margin-top: 5px; }
.dsh-qqbot-library .ql-phone-modes span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-qqbot-library .ql-phone-modes small { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.dsh-qqbot-library .ql-phone > p { margin: 0; }
.dsh-qqbot-library .ql-phone .ql-field > .ql-actions { max-width: 620px; }
.dsh-qqbot-library .ql-phone .ql-actions > input { flex: 1 1 240px; min-width: 0; width: 240px; max-width: 480px; box-sizing: border-box; }
.dsh-qqbot-library .ql-phone .ql-actions > input[aria-label="访问码"] { flex: 0 1 280px; max-width: 100%; }
.dsh-qqbot-library .ql-phone > button { align-self: flex-start; }
`
