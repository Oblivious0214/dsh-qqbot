/** 界面设置与右栏共用同一段落间隔；只保存设置，不启动设备。 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PACING_SECONDS } from '../core/pacing.ts'
import type { ToyController } from './controller.ts'

export function PacingSettings({ controller, label = '设备运动时', onBusy, onDirty }: {
  readonly controller: ToyController
  readonly label?: string
  readonly onBusy?: (busy: boolean) => void
  readonly onDirty?: (dirty: boolean) => void
}) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [text, setText] = useState<string>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const shown = text ?? String(toy.pacing.seconds)
  const seconds = Number(shown)
  const valid = shown.trim() !== '' && Number.isInteger(seconds) && seconds >= PACING_SECONDS.min && seconds <= PACING_SECONDS.max
  const dirty = text !== undefined && (!valid || seconds !== toy.pacing.seconds)
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  useEffect(() => { onBusy?.(saving) }, [saving, onBusy])
  useEffect(() => () => onBusy?.(false), [onBusy])

  const commit = async () => {
    if (inFlight.current || toy.settings === undefined) return
    if (!valid) { setError(`请输入 ${PACING_SECONDS.min}–${PACING_SECONDS.max} 的整数秒`); return }
    if (seconds === toy.pacing.seconds) { setText(undefined); setError(''); return }
    inFlight.current = true
    setSaving(true)
    setError('')
    try {
      await controller.setPacing(seconds)
      setText(undefined)
    } catch (reason) {
      setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  return <div className="qq-pacing-setting" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <label className="qq-settings-row" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
      <span title="新动作段落的停留时间；设置页和右栏共用">{label}</span>
      <input type="number" aria-label={label === '段落间隔' ? label : '设备运动时段落间隔'}
        min={PACING_SECONDS.min} max={PACING_SECONDS.max} step={1} value={shown}
        style={{ width: 76, minWidth: 0, flex: 'none' }} disabled={saving || toy.busy || toy.settings === undefined}
        aria-invalid={error !== '' || undefined}
        onChange={event => { setText(event.target.value); setError('') }} onBlur={() => { void commit() }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commit() } }} />
      <span>秒</span>
    </label>
    {error && <div className="qq-settings-actions">
      <span className="qq-settings-status" role="alert">{error}</span>
      {valid && <Button size="sm" variant="outline" disabled={saving || toy.busy} onClick={() => { void commit() }}>重试</Button>}
    </div>}
    {toy.loadError && <span className="qq-settings-status" role="alert">{toy.loadError}</span>}
  </div>
}
