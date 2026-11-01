import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** QQbot 的独立文本编辑区；只统一控件，持久化由各数据域负责。 */
export function TextEditor({ label, value, onChange, dirty, disabled = false, saving = false, saveDisabled = false,
  onSave, onCancel, onReset, resetLabel = '恢复默认', resetDisabled = false, saveLabel = '保存提示词',
  maxLength, placeholder, fold = true, onOpen, before, actions, after, error,
}: {
  label: string; value: string; onChange: (value: string) => void; dirty: boolean
  disabled?: boolean; saving?: boolean; saveDisabled?: boolean; saveLabel?: string
  onSave: () => void; onCancel: () => void; onReset?: (() => void) | undefined
  resetLabel?: string; resetDisabled?: boolean; maxLength?: number; placeholder?: string | undefined
  fold?: boolean; onOpen?: (() => void) | undefined; before?: ReactNode; actions?: ReactNode; after?: ReactNode; error?: string
}) {
  const body = <div className="ql-group-body qq-text-editor-body">
    {before}
    <label className="ql-field qq-settings-field"><textarea aria-label={label} rows={6} maxLength={maxLength}
      placeholder={placeholder} value={value} disabled={disabled || saving} onChange={event => { onChange(event.target.value) }} /></label>
    <div className="ql-actions qq-settings-actions">
      <Button size="sm" variant="outline" disabled={disabled || saving || !dirty || saveDisabled} onClick={onSave}>{saving ? '保存中…' : saveLabel}</Button>
      {dirty && <Button size="sm" variant="outline" disabled={disabled || saving} onClick={onCancel}>取消</Button>}
      {onReset && <Button size="sm" variant="outline" disabled={disabled || saving || resetDisabled} onClick={onReset}>{resetLabel}</Button>}
      {actions}
    </div>
    {error && <p className="qq-settings-status" role="alert">{error}</p>}
    {after}
  </div>
  return fold ? <details className="ql-group qq-settings-fold qq-text-editor" onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open) onOpen?.()
  }}><summary><strong>{label}</strong></summary>{body}</details> : <div className="qq-text-editor">{body}</div>
}
