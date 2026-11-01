/** 挂在 QQbot 界面页；仍由联动插件保存和应用，只改变只读标注。 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToyController } from './controller.ts'
import { SwitchRow } from '../../client/switch.tsx'

export function ToyDebugSettings({ controller, onBusy, onDirty }: { readonly controller: ToyController; readonly onBusy: (busy: boolean) => void; readonly onDirty?: (dirty: boolean) => void }) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [status, setStatus] = useState('')
  const saving = useRef(false)
  const [pending, setPending] = useState<Partial<{ actions: boolean; countdown: boolean }>>()
  useEffect(() => { onDirty?.(pending !== undefined); return () => onDirty?.(false) }, [pending, onDirty])
  useEffect(() => { void controller.load() }, [controller])
  const options = { ...toy.settings?.display ?? { actions: false, countdown: false }, ...pending }
  const save = async (patch: Partial<typeof options>) => {
    const settings = controller.getSnapshot().settings
    if (settings === undefined || saving.current) return
    const changes = { ...pending, ...patch }
    setPending(changes)
    saving.current = true
    onBusy(true)
    setStatus('保存中…')
    try {
      await controller.updateSettings(latest => ({ ...latest, display: { ...latest.display ?? { actions: false, countdown: false }, ...changes } }))
      setPending(undefined)
      setStatus('')
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      saving.current = false
      onBusy(false)
    }
  }
  const disabled = toy.busy || toy.settings === undefined
  return <section className="qq-section qq-settings-scope" aria-label="气泡标注">
    <div className="ql-grid">
      <SwitchRow label="隐藏动作信息" checked={!options.actions} disabled={disabled} onChange={hidden => { void save({ actions: !hidden }) }} />
      <SwitchRow label="隐藏段落倒计时" checked={!options.countdown} disabled={disabled} onChange={hidden => { void save({ countdown: !hidden }) }} />
    </div>
    {pending && status.startsWith('保存失败') && <Button variant="outline" size="sm" disabled={toy.busy} onClick={() => { void save(pending) }}>重试</Button>}
    {(toy.loadError || status) && <span className="ql-note qq-settings-status" role="status">{toy.loadError || status}</span>}
  </section>
}

/** 设置预览只订阅显示偏好，不连接设备、不驱动真实播放。 */
export function ToyDisplayPreview({ controller }: { readonly controller: ToyController }) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const display = toy.settings?.display ?? { actions: false, countdown: false }
  const [remaining, setRemaining] = useState(3)
  useEffect(() => {
    if (!display.countdown) return
    const timer = window.setInterval(() => { setRemaining(value => value <= 1 ? 3 : value - 1) }, 1000)
    return () => window.clearInterval(timer)
  }, [display.countdown])
  return <div className="ql-note" aria-label="示例气泡标注" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
    {display.actions && <span>第 1 段：全程 · 慢速 · 稳定节奏</span>}
    {display.countdown && <span>剩余 {remaining.toFixed(1)} 秒</span>}
  </div>
}
