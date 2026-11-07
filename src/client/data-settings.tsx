import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ActionDialog } from './action-dialog.tsx'
import type { MaintenanceClient } from './maintenance.ts'
import type { CleanupKind } from '../maintenance-types.ts'
import type { LibraryView } from '../library-types.ts'
import { CONFIG_MAX_BYTES } from '../config-types.ts'
import { serializeConfigurationPackage } from '../config-package.ts'

export function DataSettings({ view, onImport, maintenance, onBusy }: { view: LibraryView; onImport(): void; maintenance?: MaintenanceClient | undefined; onBusy(busy: boolean): void }) {
  const [error, setError] = useState('')
  function download(kind: 'roles' | 'presets' | 'all') {
    try {
      const config = serializeConfigurationPackage(view, kind)
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      if (blob.size > CONFIG_MAX_BYTES) throw new Error('配置超过 10 MB，无法导出为可导入文件。')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `QQBot-${kind}-${new Date().toISOString().slice(0, 10)}.json`
      document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setError('')
    } catch (e) { setError(e instanceof Error ? e.message : '导出失败。') }
  }
  return <div className="ql-main"><div className="ql-form">
    <section className="ql-data-section">
      <strong>导入配置</strong>
      <Button size="sm" variant="outline" onClick={onImport}>导入配置</Button>
    </section>
    <section className="ql-data-section">
      <strong>导出配置</strong>
      <p className="ql-note">角色配置包含关联的预设。导出不包含记忆、图片、音色、密钥和本机设置。</p>
      <div className="qq-settings-actions">
        <Button size="sm" variant="outline" onClick={() => download('roles')}>导出角色配置</Button>
        <Button size="sm" variant="outline" onClick={() => download('presets')}>导出预设</Button>
        <Button size="sm" variant="outline" onClick={() => download('all')}>合并导出配置</Button>
      </div>
    </section>
    {error && <p role="alert" className="ql-warn">{error}</p>}
    {maintenance && <CleanupSettings maintenance={maintenance} onBusy={onBusy} />}
  </div></div>
}

function CleanupSettings({ maintenance, onBusy }: { maintenance: MaintenanceClient; onBusy(busy: boolean): void }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState(maintenance.notice)
  const submitting = useRef(false)
  useEffect(() => () => { onBusy(false) }, [onBusy])
  const clear = async (kind: CleanupKind) => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); onBusy(true); setError(undefined); setNotice('')
    try {
      await maintenance.clear(kind)
      setConfirm(false); setNotice(maintenance.notice)
    } catch (error) { setError(error instanceof Error ? error.message : '清理未完成，请重试。') }
    finally { submitting.current = false; setBusy(false); onBusy(false) }
  }
  return <>
    <section className="ql-data-section">
      <strong>缓存</strong>
      <p className="ql-note">清理已生成的语音和页面临时缓存，保留角色与设置。</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { void clear('cache') }}>清理缓存</Button>
    </section>
    <section className="ql-data-section">
      <strong>全部数据</strong>
      <p className="ql-note">删除 QQ Bot 的全部资料并恢复初始配置，保留 DSH 聊天记录。</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setError(undefined); setConfirm(true) }}>清理全部数据</Button>
    </section>
    {busy && !confirm && <p className="ql-note" role="status">正在清理…</p>}
    {notice && <p className="ql-note" role="status">{notice}</p>}
    {error && !confirm && <p className="ql-warn" role="alert">{error}</p>}
    {confirm && <ActionDialog title="清理全部 QQ Bot 数据？" confirmLabel="清理全部数据" busy={busy} error={error}
      onCancel={() => { setConfirm(false); setError(undefined) }} onConfirm={() => { void clear('all') }}>
      角色、破限预设、记忆、头像与背景、语音连接及密钥、接话和联动设置都会删除，设备授权会撤回。清理后恢复初始配置，无法撤销。DSH 聊天记录保留。
    </ActionDialog>}
  </>
}
