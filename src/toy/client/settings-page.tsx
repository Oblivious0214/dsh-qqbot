/** QQ Bot 设置的联动页。开关保存到 host，设备仍需手动连接和接入。 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UiExtensionProps } from '../../client/ui-extensions.tsx'
import type { ToyController } from './controller.ts'
import { SwitchRow } from '../../client/switch.tsx'
import { Consent, ToyPanel } from './panel.tsx'
import { DeviceIntro } from './device-intro.tsx'
import { ActionDialog } from '../../client/action-dialog.tsx'

export function ToySettingsPage({ controller, onBusy, onDirty, onOpenRoleProactivity }: UiExtensionProps & {
  readonly controller: ToyController
}) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [consent, setConsent] = useState(false)
  const [intro, setIntro] = useState(false)
  const [proactivityGuide, setProactivityGuide] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [childBusy, setChildBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const changeDirty = useCallback((value: boolean) => { setDirty(value) }, [])
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
  useEffect(() => { void controller.load() }, [controller])
  useEffect(() => { onBusy(saving || childBusy || toy.busy) }, [saving, childBusy, toy.busy, onBusy])
  useEffect(() => () => { onBusy(false) }, [onBusy])
  const enable = async (enabled: boolean) => {
    if (submitting.current) return
    submitting.current = true
    setSaving(true)
    setError('')
    const firstEnable = enabled && toy.settings?.deviceIntroSeen !== true
    try {
      await controller.setEnabled(enabled)
      if (firstEnable && controller.getSnapshot().enabled) setIntro(true)
    }
    catch (reason) { setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { submitting.current = false; setSaving(false) }
  }
  return <div className="ql-form qq-settings-scope">
    <SwitchRow label="启用设备联动" title={dirty ? '先保存修改' : undefined} checked={toy.settings !== undefined && toy.settings.enabled !== false}
      disabled={toy.settings === undefined || toy.busy || dirty || saving}
      onChange={enabled => { void enable(enabled) }} />
    {(error || toy.loadError || toy.conflict) && <p className="ql-warn" role="alert">{error || toy.loadError || toy.conflict}</p>}
    {(!toy.enabled || !toy.settings?.authorized) && toy.notice && <p className="ql-note" role="status">{toy.notice}</p>}
    {toy.loadError && <Button variant="outline" size="sm" onClick={() => { void controller.load() }}>重试</Button>}
    {toy.enabled && (toy.settings?.authorized
      ? <>
        <ToyPanel controller={controller} embedded
          afterReplySettings={onOpenRoleProactivity && <div className="qq-settings-row">
            <span>AI主动性</span>
            <Button size="sm" variant="outline" disabled={saving || childBusy || toy.busy}
              onClick={() => { setProactivityGuide(true) }}>设置</Button>
          </div>}
          close={() => { setConsent(false) }} onBusy={setChildBusy} onDirty={changeDirty} />
      </>
      : <div className="ql-actions qq-settings-actions"><Button size="sm" variant="outline" onClick={() => { setConsent(true) }}>首次联动授权</Button></div>)}
    {consent && toy.enabled && <Consent controller={controller} close={() => { setConsent(false) }} accept={firstEnable => {
      setConsent(false)
      if (firstEnable) setIntro(true)
    }} />}
    {intro && toy.enabled && <DeviceIntro close={() => { setIntro(false) }} />}
    {proactivityGuide && <ActionDialog title="AI主动性" cancelLabel="关闭" confirmLabel="前往角色设置"
      onCancel={() => { setProactivityGuide(false) }}
      onConfirm={() => { setProactivityGuide(false); onOpenRoleProactivity?.() }}>
      AI主动性在角色面板的“联动设备 → 自主性”中设置，每个角色分别保存。请选择要调整的角色，自行设置。
    </ActionDialog>}
  </div>
}
