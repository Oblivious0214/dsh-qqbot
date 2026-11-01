import PLUGIN_VERSION from 'virtual:qqbot-version'
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { UPDATE_PATH, type UpdateView } from '../update-types.ts'
import { writeHeaders } from './cleanup-epoch.ts'

export function UpdateButton({ active, onClick }: { active: boolean; onClick(): void }) {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let gone = false
    const read = () => { void fetch(UPDATE_PATH, { cache: 'no-store' }).then(async r => {
      if (r.ok) { const state = await r.json() as UpdateView; if (!gone) setAvailable(Boolean(state.release)) }
    }).catch(() => {}) }
    read(); const timer = setInterval(read, 10000)
    return () => { gone = true; clearInterval(timer) }
  }, [])
  return <Button size="sm" variant={active ? 'outline' : 'ghost'} onClick={onClick} aria-label={available ? "有新版本，打开更新" : "检查插件更新"}><span>v{PLUGIN_VERSION}</span>{available && <span><span className="ql-update-dot" />更新</span>}</Button>
}

export function UpdateSettings() {
  const [view, setView] = useState<UpdateView>(), [error, setError] = useState(''), [pending, setPending] = useState(false)
  async function request(action?: string) {
    const response = await fetch(UPDATE_PATH, { cache: 'no-store', ...action ? {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ action, version: view?.release?.version }),
    } : {} })
    const state = await response.json() as UpdateView
    if (!response.ok) throw new Error(state.message ?? '更新服务暂时不可用。')
    return state
  }
  useEffect(() => {
    let gone = false
    const poll = () => { void request().then(v => { if (!gone) { setView(v); setError('') } }, () => { if (!gone) setError('更新服务暂时不可用，请稍后重试。') }) }
    poll(); const timer = setInterval(poll, 3000)
    return () => { gone = true; clearInterval(timer) }
  }, [])
  async function run(action: string) {
    setPending(true); setError('')
    try { setView(await request(action)) } catch (e) { setError(e instanceof Error ? e.message : '更新失败。') }
    finally { setPending(false) }
  }
  return <div className="ql-main"><div className="ql-form">
    <h3>插件更新</h3>
    {view && <p>当前版本 {view.current}</p>}
    <div className="ql-actions qq-settings-actions">
      <Button variant="outline" size="sm" disabled={pending || view?.busy} onClick={() => { void run('check') }}>检查更新</Button>
      {view?.release && <Button variant="outline" size="sm" disabled={pending || view.busy} onClick={() => { void run('install') }}>一键升级到 {view.release.version}</Button>}
    </div>
    <p className="qq-settings-status" role="status">{error || view?.message || '正在检查…'}</p>
    {view?.release && <><a href={view.release.page} target="_blank" rel="noreferrer">查看发布版本</a><pre style={{ whiteSpace: 'pre-wrap', font: 'inherit' }}>{view.release.notes}</pre></>}
  </div></div>
}
