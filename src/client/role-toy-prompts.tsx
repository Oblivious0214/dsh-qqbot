import { useEffect, useRef, useState } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ROLE_PROACTIVITIES, ROLE_PROACTIVITY_LABELS, ROLE_PROACTIVITY_TEXT_LIMIT,
  type RoleProactivity, type RoleProactivityTexts,
} from '../library-types.ts'

import { TextEditor } from './text-editor.tsx'

const DESCRIPTIONS: Record<RoleProactivity, string> = {
  follow: '依照用户要求控制设备',
  situational: '以用户要求为主，结合剧情走向和人设性格控制设备',
  high: '依据剧情走向和人设性格自主决定设备动作',
}

export function RoleProactivitySelect({ value, disabled, onChange }: {
  readonly value: RoleProactivity
  readonly disabled: boolean
  readonly onChange: (value: RoleProactivity) => void
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal autoFocus minWidthFromAnchor selectedId={value}
    className="ql-proactivity-select" listClassName="dsh-qqbot-proactivity-menu"
    onClose={() => { setOpen(false) }} onSelect={id => {
      const next = ROLE_PROACTIVITIES.find(key => key === id)
      if (next !== undefined) onChange(next)
      setOpen(false)
    }} items={ROLE_PROACTIVITIES.map(key => ({ id: key,
      label: <span className="ql-proactivity-option"><strong>{ROLE_PROACTIVITY_LABELS[key]}</strong><span>{DESCRIPTIONS[key]}</span></span>,
    }))} anchor={<Button size="sm" variant="outline" disabled={disabled} aria-label="自主性"
      aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}>
      <span>{ROLE_PROACTIVITY_LABELS[value]} - {DESCRIPTIONS[value]}</span><span aria-hidden="true">⌄</span>
    </Button>} />
}

/** 动作库里的动作名称，供角色的偏好动作勾选；读不到时为空列表。只读接口不连接设备。 */
export function useToyActionNames(): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([])
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        const response = await fetch('api/qqbot/toy/state', { cache: 'no-store', signal: abort.signal })
        if (!response.ok) return
        const body = await response.json() as { actionLibrary?: { library?: { clips?: readonly { name?: unknown }[] } } }
        const clips = body.actionLibrary?.library?.clips ?? []
        const list = clips.flatMap(clip => typeof clip.name === 'string' && !/[,，]/.test(clip.name) ? [clip.name] : [])
        if (!abort.signal.aborted) setNames(list)
      } catch { /* 读不到时只显示角色卡里已有的名称。 */ }
    })()
    return () => { abort.abort() }
  }, [])
  return names
}

/** 默认说明由联动插件提供，QQbot 不复制设备提示词。只读接口不连接设备。 */
export function RoleToyPrompts({ level, disabled, value, onSave, onDirty, onDraft, create = false }: {
  readonly level: RoleProactivity
  readonly disabled: boolean
  readonly value: RoleProactivityTexts | undefined
  readonly onSave: (level: RoleProactivity, text: string | undefined) => Promise<boolean>
  readonly onDirty: (dirty: boolean) => void
  readonly onDraft?: ((texts: RoleProactivityTexts) => void) | undefined
  readonly create?: boolean
}) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(level)
  const [draft, setDraft] = useState<RoleProactivityTexts>({ ...value })
  const [defaults, setDefaults] = useState<Required<RoleProactivityTexts>>()
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [saving, setSaving] = useState(false)
  const previous = useRef(value), lock = useRef(false)
  const dirty = ROLE_PROACTIVITIES.some(key => draft[key] !== value?.[key])
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  useEffect(() => {
    const before = previous.current
    previous.current = value
    setDraft(current => Object.fromEntries(ROLE_PROACTIVITIES.flatMap(key => {
      const text = current[key] === before?.[key] ? value?.[key] : current[key]
      return text === undefined ? [] : [[key, text]]
    })))
  }, [value])
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setError('')
    void (async () => {
      try {
        const response = await fetch('api/qqbot/toy/state', { cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error('读取自主性提示词失败')
        const body = await response.json() as { proactivityDefaults?: Required<RoleProactivityTexts> }
        const texts = body.proactivityDefaults
        if (texts === undefined || ROLE_PROACTIVITIES.some(key => typeof texts[key] !== 'string')) throw new Error('请更新联动插件后重试')
        if (!abort.signal.aborted) setDefaults(texts)
      } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) }
    })()
    return () => abort.abort()
  }, [open, retry])
  const edit = (text: string | undefined) => {
    const next = { ...draft }
    if (text === undefined || text === defaults?.[selected]) delete next[selected]
    else next[selected] = text
    setDraft(next); onDraft?.(next); setError('')
  }
  const save = async (text = draft[selected], reset = false) => {
    if (lock.current) return
    lock.current = true; setSaving(true); setError('')
    if (reset) edit(undefined)
    try {
      if (!(await onSave(selected, reset ? undefined : text))) setError('保存失败，请重试。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setSaving(false) }
  }
  return <TextEditor label="自主性提示词" value={draft[selected] ?? defaults?.[selected] ?? ''}
    onOpen={() => { setOpen(true) }} onChange={edit} dirty={draft[selected] !== value?.[selected]}
    disabled={disabled || defaults === undefined} saving={saving} maxLength={ROLE_PROACTIVITY_TEXT_LIMIT}
    saveLabel={create ? '创建角色' : '保存提示词'} onSave={() => { void save() }} onCancel={() => {
      const next = { ...draft }
      if (value?.[selected] === undefined) delete next[selected]
      else next[selected] = value[selected]
      setDraft(next); onDraft?.(next); setError('')
    }}
    onReset={() => { void save(undefined, true) }} resetDisabled={draft[selected] === undefined && value?.[selected] === undefined}
    error={error} before={<>
      <label className="ql-field ql-inline qq-settings-row"><span>档位</span><select aria-label="提示词档位" value={selected} disabled={disabled || saving}
        onChange={event => { setSelected(event.target.value as RoleProactivity); setError('') }}>
        {ROLE_PROACTIVITIES.map(key => <option key={key} value={key}>{ROLE_PROACTIVITY_LABELS[key]}{draft[key] !== value?.[key] ? '（未保存）' : value?.[key] !== undefined ? '（已修改）' : ''}</option>)}
      </select></label>
      {defaults === undefined && !error && <p className="ql-note">正在读取提示词…</p>}
    </>} after={defaults === undefined && error && <Button size="sm" variant="outline" onClick={() => { setRetry(n => n + 1) }}>重新读取</Button>} />
}
