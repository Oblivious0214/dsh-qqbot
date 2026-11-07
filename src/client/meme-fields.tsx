/** Copyright (c) 2026 yupaoa. MIT. 表情偏好流程参考 dsh-persona-switcher，按 QQ 角色编辑器重写。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_MEME_FREQUENCY, MEME_FREQUENCIES, MEME_FREQUENCY_LABELS,
  type LibraryRoleDraft } from '../library-types.ts'
import { readMemeCatalogue, type MemeCatalogue } from './meme-catalogue.ts'

export function MemeFrequencyField({ draft, onChange }: {
  readonly draft: LibraryRoleDraft
  readonly onChange: (draft: LibraryRoleDraft) => void
}) {
  return <label className="ql-field ql-inline"><span>表情频率</span><select aria-label="表情频率" value={draft.memeFrequency ?? ''} onChange={event => {
    const { memeFrequency: _, ...rest } = draft
    const value = MEME_FREQUENCIES.find(f => f === event.target.value)
    onChange(value === undefined ? rest : { ...rest, memeFrequency: value })
  }}><option value="">默认（{MEME_FREQUENCY_LABELS[DEFAULT_MEME_FREQUENCY]}）</option>
    {MEME_FREQUENCIES.map(f => <option key={f} value={f}>{MEME_FREQUENCY_LABELS[f]}</option>)}
  </select></label>
}

export function MemeFields({ draft, active, available, onChange, promptEditor }: {
  readonly draft: LibraryRoleDraft; readonly active: boolean; readonly available: boolean
  readonly onChange: (draft: LibraryRoleDraft) => void
  readonly promptEditor: ReactNode
}) {
  const [catalogue, setCatalogue] = useState<MemeCatalogue>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active || !available) return
    const abort = new AbortController()
    setError(undefined)
    setCatalogue(undefined)
    const timeout = AbortSignal.timeout(15_000)
    readMemeCatalogue(AbortSignal.any([abort.signal, timeout])).then(value => { if (!abort.signal.aborted) setCatalogue(value) }, () => {
      if (!abort.signal.aborted) setError(timeout.aborted ? '读取图库超时，请重试。' : '读取图库失败，请检查 dsh-meme 是否启用及允许当前访问方式。')
    })
    return () => { abort.abort() }
  }, [active, available, attempt])

  const packs = new Map(catalogue?.packs.map(p => [p.id, p]))
  for (const saved of draft.memePacks ?? []) if (!packs.has(saved.id)) packs.set(saved.id, saved)
  const selected = new Set(draft.memePacks?.map(p => p.id))
  const visiblePacks = selected.size === 0 ? catalogue?.packs ?? [] : [...packs.values()].filter(p => selected.has(p.id))
  const tags = [...new Set([...visiblePacks.flatMap(p => catalogue?.tagsByPack.get(p.id) ?? []), ...draft.memeTags ?? []])]
  const setTags = (values: readonly string[]) => {
    const { memeTags: _, ...rest } = draft
    onChange(values.length === 0 ? rest : { ...rest, memeTags: values })
  }
  return <>
    {!available && <div className="ql-note">dsh-meme 未启用。</div>}
    {available && catalogue === undefined && error === undefined && <div className="ql-note" role="status">正在读取图库…</div>}
    {error !== undefined && <div className="ql-state ql-warn" role="alert"><span>{error}</span>
      <Button size="sm" variant="outline" onClick={() => { setAttempt(n => n + 1) }}>重试</Button></div>}
    <fieldset className="qm-choices"><legend title="只使用勾选且已在 dsh-meme 启用的图库；未勾选时不发表情">可用图库</legend>
      {[...packs.values()].map(pack => <label className="ql-toggle" key={pack.id}>
        <input type="checkbox" checked={selected.has(pack.id)} onChange={event => {
          const { memePacks: _, ...rest } = draft
          const next = event.target.checked ? [...draft.memePacks ?? [], pack] : (draft.memePacks ?? []).filter(p => p.id !== pack.id)
          onChange(next.length === 0 ? rest : { ...rest, memePacks: next })
        }} /><span>{pack.name}{catalogue !== undefined && !catalogue.packs.some(p => p.id === pack.id) ? '（不可用）' : ''}</span>
      </label>)}
      {catalogue !== undefined && packs.size === 0 && <span className="ql-note">暂无图库</span>}
    </fieldset>
    <fieldset className="qm-choices"><legend title="按所选图库汇总；未选图库时显示全部标签">偏好标签</legend>
      {tags.map(tag => <label className="ql-toggle" key={tag}><input type="checkbox" checked={draft.memeTags?.includes(tag) ?? false}
        onChange={event => { setTags(event.target.checked ? [...draft.memeTags ?? [], tag] : (draft.memeTags ?? []).filter(t => t !== tag)) }} /><span>{tag}</span></label>)}
      {catalogue !== undefined && tags.length === 0 && <span className="ql-note">暂无标签</span>}
    </fieldset>
    {promptEditor}
    <div className="ql-actions"><Button size="sm" variant="outline" onClick={() => {
      const { memePacks: _p, memeTags: _t, memeFrequency: _f, ...rest } = draft
      onChange(rest)
    }}>清空表情偏好</Button></div>
  </>
}
