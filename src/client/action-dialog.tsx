/** QQ Bot 的确认与操作失败提示，共用宿主弹窗的焦点、Esc 和遮罩行为。 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export const ACTION_DIALOG_CLASS = 'dsh-qqbot-action-dialog'
export const ACTION_DIALOG_CSS = `
[role="dialog"].${ACTION_DIALOG_CLASS} { width: min(420px, 100%); max-height: 100%; font-size: 14px; line-height: 22px; }
.${ACTION_DIALOG_CLASS} .qa-message button { font-size: 14px; line-height: 22px; min-height: 36px; }
.${ACTION_DIALOG_CLASS} .qa-content { min-height: 0; overflow: auto; }
.${ACTION_DIALOG_CLASS} .qa-message { font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }
.${ACTION_DIALOG_CLASS} .qa-error { margin-top: 12px; color: var(--dsw-alias-state-warn-label); }
.${ACTION_DIALOG_CLASS} .qv-role-choice { display: flex; flex-direction: column; gap: 10px; white-space: normal; }
.${ACTION_DIALOG_CLASS} .qv-role-choice select { width: 100%; min-width: 0; padding: 8px; font: inherit; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l4); border-radius: 8px; }
.${ACTION_DIALOG_CLASS} .qc-import { display: flex; flex-direction: column; gap: 12px; white-space: normal; min-width: 0; }
.${ACTION_DIALOG_CLASS} .qc-options { display: flex; flex-wrap: wrap; gap: 10px 16px; padding: 0; border: 0; margin: 0; min-width: 0; }
.${ACTION_DIALOG_CLASS} .qc-options label { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.${ACTION_DIALOG_CLASS} .qc-options select { max-width: 100%; padding: 5px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l4); border-radius: 6px; font: inherit; }
.${ACTION_DIALOG_CLASS} .qc-preview { max-height: 30vh; overflow: auto; padding: 0; margin: 0; list-style: none; }
.${ACTION_DIALOG_CLASS} .qc-preview li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; }
.${ACTION_DIALOG_CLASS} .qc-preview li > span { min-width: 0; overflow-wrap: anywhere; }
.${ACTION_DIALOG_CLASS} .qc-preview small { flex: none; color: var(--dsw-alias-label-secondary); }
.${ACTION_DIALOG_CLASS} .qc-filename { overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.${ACTION_DIALOG_CLASS} .qc-password { display: flex; flex-direction: column; gap: 8px; }
.${ACTION_DIALOG_CLASS} .qc-password input { width: 100%; min-width: 0; box-sizing: border-box; padding: 8px; font: inherit; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l4); border-radius: 8px; }
`

export function ActionDialog({ title, children, onCancel, cancelLabel = '取消', onConfirm, confirmLabel = '确认', confirmDisabled = false, busy = false, error }: {
  readonly title: string; readonly children: ReactNode; readonly onCancel: () => void
  readonly cancelLabel?: string; readonly onConfirm?: (() => void) | undefined; readonly confirmLabel?: string
  readonly busy?: boolean; readonly error?: string | undefined
  readonly confirmDisabled?: boolean
}) {
  return <Modal open title={title} closeLabel="关闭" className={ACTION_DIALOG_CLASS} contentClassName="qa-content" backdropBlur={false}
    onClose={() => { if (!busy) onCancel() }}
    footer={<>
      <Button variant="outline" disabled={busy} data-modal-autofocus="" onClick={onCancel}>{cancelLabel}</Button>
      {onConfirm !== undefined && <Button variant="primary" disabled={busy || confirmDisabled} onClick={onConfirm}>
        {busy ? '处理中…' : confirmLabel}
      </Button>}
    </>}>
    <div className="qa-message">{children}</div>
    {error !== undefined && <div className="qa-message qa-error" role="alert">{error}</div>}
  </Modal>
}
