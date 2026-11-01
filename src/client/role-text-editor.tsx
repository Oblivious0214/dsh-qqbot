import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TextEditor } from './text-editor.tsx'

/** 独立草稿不混入角色表单；保存失败保留输入，外部更新不覆盖正在编辑的文字。 */
export function RoleTextEditor({ value, onSave, onDirty, onDraft, disabled, label, maxLength, clear = false,
  fold = true, placeholder, actions, create = false,
}: {
  value: string; onSave: (value: string) => Promise<string | undefined>; onDirty: (dirty: boolean) => void
  onDraft?: ((value: string) => void) | undefined; disabled: boolean; label: string; maxLength: number
  clear?: boolean; fold?: boolean; placeholder?: string; actions?: ReactNode; create?: boolean
}) {
  const [text, setText] = useState(value), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const previous = useRef(value), lock = useRef(false)
  const dirty = text !== value
  useEffect(() => {
    const before = previous.current
    previous.current = value
    setText(current => current === before ? value : current)
  }, [value])
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  const edit = (next: string) => { setText(next); onDraft?.(next); setError('') }
  const save = async (next = text) => {
    if (lock.current) return
    lock.current = true; setSaving(true); edit(next)
    try {
      const saved = await onSave(next)
      if (saved === undefined) setError('保存失败，请重试。')
      else { setText(saved); setError('') }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setSaving(false) }
  }
  return <TextEditor label={label} value={text} onChange={edit} dirty={dirty} disabled={disabled} saving={saving}
    maxLength={maxLength} fold={fold} placeholder={placeholder} saveLabel={create ? '创建角色' : fold ? '保存提示词' : '保存记忆'}
    onSave={() => { void save() }} onCancel={() => { edit(value) }} error={error} actions={actions}
    {...clear ? { resetLabel: '清空', resetDisabled: text === '' && value === '', onReset: () => { void save('') } } : {}} />
}
