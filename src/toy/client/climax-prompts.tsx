/** 高潮／温存提示词的编辑区，放在“高潮／温存预设”面板里；独立保存，草稿留在入口组件，关闭面板后仍在。 */
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_CLIMAX_PROMPTS, MAX_CLIMAX_PROMPT_LENGTH, type ClimaxPromptKey } from '../climax-prompt.ts'
import { TextEditor } from '../../client/text-editor.tsx'
import type { ToyController, ToySnapshot } from './controller.ts'

const LABELS: Record<ClimaxPromptKey, string> = { climax: '高潮提示词', aftercare: '温存提示词' }

export function useClimaxPrompts(controller: ToyController, toy: ToySnapshot) {
  const [drafts, setDrafts] = useState<Partial<Record<ClimaxPromptKey, string>>>({})
  const [saving, setSaving] = useState<ClimaxPromptKey>()
  const [errors, setErrors] = useState<Partial<Record<ClimaxPromptKey, string>>>({})
  const dirty = useRef(false)
  dirty.current = Object.keys(drafts).length > 0
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  const saved = (key: ClimaxPromptKey) => toy.settings?.climaxPrompts?.[key] ?? DEFAULT_CLIMAX_PROMPTS[key]
  const forget = (key: ClimaxPromptKey) => setDrafts(({ [key]: _, ...rest }) => rest)
  const save = async (key: ClimaxPromptKey, text: string) => {
    if (saving !== undefined) return
    if (text.trim() === '') { setErrors(e => ({ ...e, [key]: '提示词不能为空' })); return }
    setSaving(key); setErrors(e => ({ ...e, [key]: '' }))
    try {
      await controller.updateSettings(latest => ({ ...latest, climaxPrompts: { ...latest.climaxPrompts, [key]: text } }))
      forget(key)
    } catch (reason) { setErrors(e => ({ ...e, [key]: `保存失败：${reason instanceof Error ? reason.message : String(reason)}` })) }
    finally { setSaving(undefined) }
  }
  return (key: ClimaxPromptKey) => {
    const value = drafts[key] ?? saved(key)
    return <TextEditor key={key} label={LABELS[key]} value={value} maxLength={MAX_CLIMAX_PROMPT_LENGTH}
      dirty={drafts[key] !== undefined && drafts[key] !== saved(key)} saving={saving === key} disabled={toy.settings === undefined}
      onChange={text => { setDrafts(d => ({ ...d, [key]: text })); setErrors(e => ({ ...e, [key]: '' })) }}
      onSave={() => { void save(key, value) }} onCancel={() => { forget(key); setErrors(e => ({ ...e, [key]: '' })) }}
      onReset={() => { void save(key, DEFAULT_CLIMAX_PROMPTS[key]) }}
      resetDisabled={value === DEFAULT_CLIMAX_PROMPTS[key] && saved(key) === DEFAULT_CLIMAX_PROMPTS[key]}
      before={<p className="ql-note" title="发送时按当前时长填入">{'{秒数}'}、{'{段数}'} 会自动填入</p>}
      {...errors[key] ? { error: errors[key] } : {}} />
  }
}
