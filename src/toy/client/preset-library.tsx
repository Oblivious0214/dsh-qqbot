import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { burstTier, HARD_LIMITS, TIERS, tierBudget, type Tier } from '../core/config.ts'
import { BURST_SECONDS, DEFAULT_BURST, type BurstSettings } from '../api-types.ts'
import { parseActionLibrary, type ActionLibrary } from '../motion-library/config.ts'
import { parseFunscript, sliceScript, type MotionScript } from '../motion-library/script.ts'
import { saveClip, updateClip, type MotionClip } from '../motion-library/library.ts'
import { analyzeLoops } from '../motion-library/analysis.ts'
import { POOL_WEIGHTS, type PoolWeight, type PresetPool } from '../motion-library/catalog.ts'

import { mergeActionLibrary } from './settings-merge.ts'
import { useClimaxPrompts } from './climax-prompts.tsx'
import type { ToyController } from './controller.ts'

type PoolKey = Tier | 'burst' | 'aftercare'
const LABELS: Record<PoolKey, string> = { low: '慢速', medium: '中速', high: '高速', burst: '高潮', aftercare: '温存' }
const WEIGHTS: Record<PoolWeight, string> = { low: '少', medium: '普通', high: '多' }
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const mapPools = (map: (tier: Tier) => ActionLibrary['pools'][Tier]): ActionLibrary['pools'] => ({ low: map('low'), medium: map('medium'), high: map('high') })
const poolOf = (value: ActionLibrary, tier: PoolKey, fallbackTier: Tier) => tier === 'burst' ? value.burstPool ?? value.pools[fallbackTier]
  : tier === 'aftercare' ? value.aftercarePool ?? value.pools[fallbackTier] : value.pools[tier]
/** 按顺序取当前速度上限下第一个可用的档；高潮从高往低，温存从低往高（与播放器一致）。 */
const usableTier = (motion: Parameters<typeof tierBudget>[0] | undefined, order: readonly Tier[]) => order.find(tier => {
  try { if (!motion) return false; tierBudget(motion, tier); return true } catch { return false }
}) ?? order[0]!

const CLIMAX_TITLE = '高潮／温存预设'

/**
 * 设置页与右栏共用的“高潮／温存预设”：一个入口，面板里依次设置高潮时长、速度、动作和提示词，
 * 再设置结束后是否温存及温存时长、动作和提示词。动作卡片只在点“选择…动作”后打开。
 */
export function ClimaxPreset({ controller, onOpen, compact = false }: {
  controller: ToyController
  onOpen?: (open: boolean) => void
  compact?: boolean
}) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [open, setOpen] = useState(false)
  const [pool, setPool] = useState<'burst' | 'aftercare'>()
  const { body, speed } = useClimaxSettings(controller, setPool)
  useEffect(() => { onOpen?.(open); return () => onOpen?.(false) }, [open, onOpen])
  const motion = toy.settings?.motion
  const fallbackTier = pool === 'aftercare' ? usableTier(motion, ['low', 'medium', 'high'])
    : (motion && burstTier(motion, speed)) ?? usableTier(motion, ['high', 'medium', 'low'])
  return <>
    <Button size={compact ? 'md' : 'sm'} variant="outline" className={compact ? undefined : 'tb-preset-tier'} data-tier="burst"
      aria-haspopup="dialog" aria-expanded={open} disabled={!toy.settings || !toy.actionLibrary} onClick={() => { setOpen(true) }}>
      {!compact && <span className="tb-preset-dot" aria-hidden="true" />}
      <span>{compact ? '高潮设置' : CLIMAX_TITLE}</span>
    </Button>
    {open && <Modal open title={CLIMAX_TITLE} closeLabel={`关闭${CLIMAX_TITLE}`} onClose={() => { setOpen(false) }}
      className="dsh-toy-buttplug qq-settings-scope tb-preset-window tb-climax-window" contentClassName="tb-preset-content" backdropBlur={false}>
      {body}
    </Modal>}
    {open && pool !== undefined && toy.actionLibrary && <PoolEditor key={pool} value={toy.actionLibrary} tier={pool} fallbackTier={fallbackTier}
      controller={controller} close={() => { setPool(undefined) }} />}
  </>
}

/** 即时设置的输入留在入口组件中，关闭面板后仍可恢复失败或未完成的输入。 */
function useClimaxSettings(controller: ToyController, openPool: (pool: 'burst' | 'aftercare') => void) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [patch, setPatch] = useState<Partial<BurstSettings>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  type NumberField = 'seconds' | 'aftercareSeconds' | 'speed'
  const [inputs, setInputs] = useState<Partial<Record<NumberField, string>>>({})
  const inputValues = useRef(inputs)
  const pending = useRef<Partial<BurstSettings>>({})
  const busy = useRef(false)
  const prompt = useClimaxPrompts(controller, toy)
  const draft = { ...toy.settings?.burst ?? DEFAULT_BURST, ...patch }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy.current || Object.keys(pending.current).length || Object.keys(inputValues.current).length) {
        event.preventDefault(); event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  const submit = async () => {
    if (busy.current || !Object.keys(pending.current).length) return
    busy.current = true; setSaving(true); setError('')
    try {
      while (Object.keys(pending.current).length) {
        const changes = pending.current; pending.current = {}
        try {
          await controller.updateSettings(latest => ({ ...latest, burst: { ...latest.burst ?? DEFAULT_BURST, ...changes } }))
        } catch (reason) {
          pending.current = { ...changes, ...pending.current }
          throw reason
        }
        setPatch(current => Object.fromEntries(Object.entries(current).filter(([key, value]) =>
          value !== changes[key as keyof BurstSettings] || pending.current[key as keyof BurstSettings] !== undefined)))
        const remainingInputs = { ...inputValues.current }
        for (const key of ['seconds', 'aftercareSeconds', 'speed'] as const) {
          if (changes[key] !== undefined && Number(remainingInputs[key]) === changes[key] && pending.current[key] === undefined) {
            delete remainingInputs[key]
          }
        }
        inputValues.current = remainingInputs
        setInputs(remainingInputs)
      }
    } catch (reason) { setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { busy.current = false; setSaving(false) }
  }
  const edit = (changes: Partial<BurstSettings>) => {
    pending.current = { ...pending.current, ...changes }
    setPatch(current => ({ ...current, ...changes }))
    void submit()
  }
  const speedMax = toy.settings?.motion.maxSpeed ?? HARD_LIMITS.maxSpeed
  const commit = (key: NumberField) => {
    const text = inputValues.current[key]
    if (text === undefined) return
    const value = Number(text)
    const [min, max] = key === 'speed' ? [HARD_LIMITS.minSpeed, speedMax] : [BURST_SECONDS.min, BURST_SECONDS.max]
    if (!text.trim() || !Number.isInteger(value) || value < min || value > max) {
      setError(key === 'speed' ? `速度需在 ${min}–${max} unit/s 之间。` : `时间需在 ${min}–${max} 秒之间。`); return
    }
    edit({ [key]: value })
  }
  const numberProps = (key: NumberField) => ({
    value: inputs[key] ?? (draft[key] as number),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      inputValues.current = { ...inputValues.current, [key]: event.target.value }
      setInputs(inputValues.current); setError('')
    },
    onBlur: () => commit(key),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() },
  })
  const speed = draft.speed ?? 'high'
  /** 切到“自己填”时先填上当前档位的上限，方便在此基础上改。 */
  const pickSpeed = (choice: string) => {
    if (choice !== 'custom') { edit({ speed: choice as 'medium' | 'high' }); return }
    if (typeof speed === 'number') return
    const motion = toy.settings?.motion
    let start = speedMax
    try { if (motion) { const tier = burstTier(motion, speed); if (tier) start = Math.min(speedMax, tierBudget(motion, tier).max) } } catch { /* 用上限 */ }
    edit({ speed: start })
  }
  const body = <fieldset className="tb-burst-settings" disabled={toy.phase !== undefined}>
    <section className="tb-climax-section" aria-label="高潮">
      <div className="tb-burst-row">
        <h3>高潮</h3>
        <label><span>持续</span><input aria-label="高潮持续时间" type="number" min={BURST_SECONDS.min} max={BURST_SECONDS.max} {...numberProps('seconds')} /><span>秒</span></label>
        <label><span>速度</span><select aria-label="高潮速度" value={typeof speed === 'number' ? 'custom' : speed} onChange={event => { pickSpeed(event.target.value) }}>
          <option value="medium">中速</option><option value="high">高速</option><option value="custom">自己填</option>
        </select></label>
        {typeof speed === 'number' && <label><input aria-label="高潮速度数值" type="number" min={HARD_LIMITS.minSpeed} max={speedMax} {...numberProps('speed')} /><span>unit/s</span></label>}
        <Button variant="outline" size="sm" disabled={!toy.actionLibrary} aria-haspopup="dialog" onClick={() => { openPool('burst') }}>选择高潮动作</Button>
      </div>
      {prompt('climax')}
    </section>
    <section className="tb-climax-section" aria-label="温存">
      <div className="tb-burst-row">
        <h3>温存</h3>
        <label><span>高潮结束后</span><select aria-label="高潮结束后" value={draft.after} onChange={event => edit({ after: event.target.value as BurstSettings['after'] })}>
          <option value="aftercare">进入温存</option><option value="stop">停止</option>
        </select></label>
        {draft.after === 'aftercare' && <>
          <label><span>持续</span><input aria-label="温存持续时间" type="number" min={BURST_SECONDS.min} max={BURST_SECONDS.max} {...numberProps('aftercareSeconds')} /><span>秒</span></label>
          <Button variant="outline" size="sm" disabled={!toy.actionLibrary} aria-haspopup="dialog" onClick={() => { openPool('aftercare') }}>选择温存动作</Button>
        </>}
      </div>
      {draft.after === 'aftercare' && prompt('aftercare')}
    </section>
    {error && Object.keys(pending.current).length > 0 && <Button variant="outline" size="sm" disabled={saving} onClick={() => { void submit() }}>重试</Button>}
    {error && <p className="tb-error" role="alert">{error}</p>}
  </fieldset>
  return { body, speed }
}

export function PresetPools({ value, controller, onOpen, highPreference }: {
  value: ActionLibrary
  controller: ToyController
  onOpen: (open: boolean) => void
  highPreference?: ReactNode
}) {
  const [tier, setTier] = useState<Tier>()
  useEffect(() => { onOpen(tier !== undefined); return () => onOpen(false) }, [tier, onOpen])
  return <div className="tb-preset-pools" role="group" aria-label="动作预设">
    <div className="tb-preset-tier-buttons">{TIERS.map(t => <Button className="tb-preset-tier" data-tier={t} size="sm" key={t}
      variant="outline" aria-haspopup="dialog" onClick={() => { setTier(t) }}>
      <span className="tb-preset-dot" aria-hidden="true" />
      <span>{LABELS[t]}预设<span className="tb-preset-count"> · {value.pools[t].length}项</span></span>
    </Button>)}<ClimaxPreset key={controller.settingsDraftGeneration} controller={controller} onOpen={onOpen} /></div>
    {tier !== undefined && <PoolEditor key={tier} value={value} tier={tier} controller={controller}
      highPreference={highPreference} close={() => { setTier(undefined) }} />}
  </div>
}

function PoolEditor({ value, tier, fallbackTier = 'high', controller, highPreference, close }: {
  value: ActionLibrary
  tier: PoolKey
  fallbackTier?: Tier
  controller: ToyController
  highPreference?: ReactNode
  close: () => void
}) {
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [preview, setPreview] = useState<MotionClip>()
  const [pool, setPool] = useState(poolOf(value, tier, fallbackTier))
  const base = useRef(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // A saved rename/import in the inner library must not erase this pool's pending choices.
  useEffect(() => {
    const previous = base.current
    if (previous === value) return
    const rename = (name: string) => {
      const id = previous.library.clips.find(c => c.name === name)?.id
      return value.library.clips.find(c => c.id === id)?.name
    }
    setPool(current => {
      const next = [...poolOf(value, tier, fallbackTier)]
      for (const entry of poolOf(previous, tier, fallbackTier)) {
        const name = rename(entry.name)
        if (!name) continue
        const edited = current.find(e => e.name === entry.name)
        const index = next.findIndex(e => e.name === name)
        if (!edited && index >= 0) next.splice(index, 1)
        else if (edited && edited.weight !== entry.weight && index >= 0) next[index] = { ...edited, name }
      }
      for (const entry of current) {
        const name = rename(entry.name)
        if (name && !poolOf(previous, tier, fallbackTier).some(e => e.name === entry.name) && !next.some(e => e.name === name)) next.push({ ...entry, name })
      }
      return next
    })
    base.current = value
  }, [value, tier, fallbackTier])
  const save = async () => {
    if (saving) return
    setSaving(true); setError('')
    try {
      await controller.saveActionLibrary({ ...base.current, ...(tier === 'burst' ? { burstPool: pool }
        : tier === 'aftercare' ? { aftercarePool: pool } : { pools: { ...base.current.pools, [tier]: pool } }) }, base.current)
      close()
    } catch (error) { setError(`保存失败：${reason(error)}`); await controller.load() }
    finally { setSaving(false) }
  }
  const totalWeight = pool.reduce((total, entry) => total + POOL_WEIGHTS[entry.weight], 0)
  const change = (next: PresetPool) => { setPool(next); setError('') }
  const toggle = (clip: MotionClip) => {
    const selected = pool.some(entry => entry.name === clip.name)
    if (saving || (selected && pool.length === 1)) return
    change(selected ? pool.filter(entry => entry.name !== clip.name) : [...pool, { name: clip.name, weight: 'low' }])
  }
  const title = tier === 'burst' || tier === 'aftercare' ? `${LABELS[tier]}动作` : `${LABELS[tier]}预设`
  return <>
    <Modal open title={title} closeLabel={`关闭${title}`} onClose={() => { if (!saving) close() }}
      className={`dsh-toy-buttplug qq-settings-scope tb-preset-window tb-preset-${tier}`} contentClassName="tb-preset-content"
      backdropBlur={false} footer={<div className="qq-settings-actions">
        <span className="qq-settings-status" role="status">{error || (saving ? '保存中…' : '')}</span>
        <Button variant="outline" disabled={saving} onClick={close}>取消</Button>
        <Button variant="primary" disabled={saving} onClick={() => { void save() }}>{saving ? '保存中…' : '保存'}</Button>
      </div>}>
      <div className="tb-preset-toolbar">
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setLibraryOpen(true) }}>管理动作库</Button>
      </div>
      {tier === 'high' && highPreference !== undefined && <div className="tb-preset-high-preference">{highPreference}</div>}
      <div className="tb-preset-grid">{value.library.clips.map(clip => {
        const selected = pool.find(entry => entry.name === clip.name)
        const lastSelected = selected !== undefined && pool.length === 1
        return <section className="tb-preset-card qq-settings-card" data-selected={selected !== undefined || undefined} key={clip.id}
          role="group" aria-label={`${clip.name}卡片`} tabIndex={0}
          onClick={event => {
            if ((event.target as Element).closest('label,input,button,select')) return
            event.currentTarget.focus()
            toggle(clip)
          }} onKeyDown={event => {
            if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
            event.preventDefault(); event.stopPropagation(); toggle(clip)
          }}>
          <label className="tb-preset-name" title={lastSelected ? '至少保留一个动作' : clip.description}>
            <input type="checkbox" checked={selected !== undefined} disabled={saving || lastSelected} onChange={() => { toggle(clip) }} />
            <span>{clip.name}</span>
          </label>
          <button type="button" className="tb-preset-thumbnail" aria-label={`放大${clip.name}轨迹图`} title="放大轨迹图"
            onClick={event => { event.stopPropagation(); setPreview(clip) }}>
            <Curve script={clip} label={`${clip.name}轨迹图`} />
          </button>
          {selected !== undefined && <div className="tb-preset-frequency" role="group" aria-label={`${clip.name}出现频率`}>
            <div className="tb-preset-frequency-buttons">{(Object.keys(WEIGHTS) as PoolWeight[]).map(weight => <Button key={weight}
              disabled={saving} size="sm" variant={selected.weight === weight ? 'primary' : 'ghost'} aria-label={`${clip.name}出现频率：${WEIGHTS[weight]}`}
              aria-pressed={selected.weight === weight} onClick={() => {
                change(pool.map(entry => entry.name === clip.name ? { ...entry, weight } : entry))
              }}>{WEIGHTS[weight]}</Button>)}</div>
            <output aria-label={`${clip.name}抽中比例`}>{Number((POOL_WEIGHTS[selected.weight] / totalWeight * 100).toFixed(1))}%</output>
          </div>}
        </section>
      })}</div>
    </Modal>
    {libraryOpen && <LibraryEditor value={value} controller={controller} close={() => { setLibraryOpen(false) }} />}
    {preview !== undefined && <Modal open title={`${preview.name} · 轨迹预览`} closeLabel="关闭轨迹预览" onClose={() => { setPreview(undefined) }}
      className="dsh-toy-buttplug tb-preset-window tb-preset-preview qq-settings-scope" contentClassName="tb-preset-content" backdropBlur={false}>
      <Curve script={preview} label={`${preview.name}轨迹图`} />
      <div className="tb-preset-axis"><span>起点</span><span>{Number((preview.points.at(-1)!.at / 1000).toFixed(2))} 秒</span></div>
      <p className="tb-preset-description">{preview.description}</p>
    </Modal>}
  </>
}

function Curve({ script, label = '行程随时间变化曲线' }: { script: MotionScript; label?: string }) {
  const last = script.points.at(-1)!.at
  const points = script.points.map(p => `${p.at / Math.max(1, last) * 400},${100 - p.pos}`).join(' ')
  return <svg className="tb-library-curve" viewBox="0 0 400 100" preserveAspectRatio="none" role="img" aria-label={label}><path d="M0 100H400M0 50H400M0 0H400" fill="none" stroke="currentColor" opacity=".12" /><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
}

function LibraryEditor({ value, close, controller }: { value: ActionLibrary; close: () => void; controller: ToyController }) {
  const base = useRef(value)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState(value)
  const [selected, setSelected] = useState(value.library.clips[0]?.id)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const applyCurrent = useRef<(() => ActionLibrary | undefined) | undefined>(undefined)
  const clip = draft.library.clips.find(c => c.id === selected)
  const commit = (next: ActionLibrary) => {
    try { setDraft(parseActionLibrary(next)); setError(''); return true }
    catch (error) { setError(reason(error)); return false }
  }
  const edit = (name: string, description: string, playback: 'once' | 'loop') => {
    if (!clip) return undefined
    try {
      const library = updateClip(draft.library, clip.name, { name, description, playback })
      const renamed = name.normalize('NFKC').trim()
      const pools = mapPools(tier => draft.pools[tier].map(entry => entry.name === clip.name ? { ...entry, name: renamed } : entry))
      const rename = (pool: PresetPool | undefined) => pool?.map(entry => entry.name === clip.name ? { ...entry, name: renamed } : entry)
      const burstPool = rename(draft.burstPool), aftercarePool = rename(draft.aftercarePool)
      const next = { ...draft, library, pools, ...(burstPool === undefined ? {} : { burstPool }), ...(aftercarePool === undefined ? {} : { aftercarePool }) }
      return commit(next) ? next : undefined
    } catch (error) { setError(reason(error)) }
  }
  const persist = async (next: ActionLibrary) => {
    setSaving(true)
    try { await controller.saveActionLibrary(parseActionLibrary(next), base.current); close() }
    catch (error) {
      await controller.load()
      const latest = controller.getSnapshot().actionLibrary
      if (latest) {
        const previous = base.current
        setDraft(current => { try { return mergeActionLibrary(previous, current, latest, false) } catch { return current } })
        base.current = latest
      }
      throw error
    } finally { setSaving(false) }
  }
  const remove = () => {
    if (!clip) return
    if (TIERS.some(t => draft.pools[t].length === 1 && draft.pools[t][0]!.name === clip.name)) { setError('这是某一档动作池里唯一的动作，请先在动作池里加入其他动作'); setDeleting(false); return }
    if (draft.burstPool?.length === 1 && draft.burstPool[0]!.name === clip.name) { setError('这是高潮动作里唯一的一个，请先加入其他动作'); setDeleting(false); return }
    if (draft.aftercarePool?.length === 1 && draft.aftercarePool[0]!.name === clip.name) { setError('这是温存动作里唯一的一个，请先加入其他动作'); setDeleting(false); return }
    const pools = mapPools(t => draft.pools[t].filter(entry => entry.name !== clip.name))
    const burstPool = draft.burstPool?.filter(entry => entry.name !== clip.name)
    const aftercarePool = draft.aftercarePool?.filter(entry => entry.name !== clip.name)
    if (commit({ ...draft, pools, ...(burstPool === undefined ? {} : { burstPool }), ...(aftercarePool === undefined ? {} : { aftercarePool }), library: { ...draft.library, clips: draft.library.clips.filter(c => c.id !== clip.id), mappings: draft.library.mappings.filter(m => m.clipId !== clip.id) } })) {
      setSelected(draft.library.clips.find(c => c.id !== clip.id)?.id)
      setDeleting(false)
    }
  }
  return <Modal open title="动作库" closeLabel="关闭动作库" onClose={() => { if (!saving) close() }} className="dsh-toy-buttplug tb-library-window qq-settings-scope"
    contentClassName="tb-preset-content" backdropBlur={false} footer={<>
    <span className="qq-settings-status" role="status">{saving ? '保存中…' : ''}</span>
    <Button variant="outline" disabled={saving} onClick={close}>取消</Button><Button variant="primary" disabled={saving || importing} onClick={() => {
      void (async () => {
        try {
          const next = clip ? applyCurrent.current?.() : draft
          if (!next) return
          await persist(next)
        } catch (error) { setError(`保存失败：${reason(error)}`) }
      })()
    }}>{saving ? '保存中…' : '保存'}</Button>
  </>}>
    <fieldset disabled={saving} className="tb-draft tb-library-editor">
      <div className="tb-row qq-settings-row"><select aria-label="选择动作" value={selected ?? ''} disabled={importing} onChange={event => {
        if (clip && applyCurrent.current?.() === undefined) return
        setSelected(event.target.value); setDeleting(false); setError('')
      }}>{draft.library.clips.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Button variant="outline" size="sm" onClick={() => {
        if (!importing && clip && applyCurrent.current?.() === undefined) return
        setImporting(!importing)
      }}>{importing ? '取消导入' : '导入脚本'}</Button></div>
      {importing && <ImportClip value={draft} accept={persist} />}
      {clip && !importing && <ClipEditor key={`${clip.id}:${clip.name}:${clip.description}:${clip.playback}`} clip={clip} save={edit} apply={applyCurrent} />}
      {clip && !importing && <div className="tb-row qq-settings-row">{deleting ? <><span>删除“{clip.name}”及其情景关联？</span><Button variant="outline" size="sm" onClick={remove}>确认删除</Button><Button size="sm" variant="outline" onClick={() => { setDeleting(false) }}>取消</Button></> : <Button size="sm" variant="outline" onClick={() => { setDeleting(true) }}>删除动作</Button>}</div>}
      {error && <p className="tb-error" role="alert">{error}</p>}
    </fieldset>
  </Modal>
}

function ClipEditor({ clip, save, apply }: { clip: MotionClip; save: (name: string, description: string, playback: 'once' | 'loop') => ActionLibrary | undefined; apply: MutableRefObject<(() => ActionLibrary | undefined) | undefined> }) {
  const [name, setName] = useState(clip.name)
  const [description, setDescription] = useState(clip.description)
  const [playback, setPlayback] = useState(clip.playback)
  apply.current = () => save(name, description, playback)
  return <div className="tb-library-editor">
    <Curve script={clip} /><small>{(clip.points.at(-1)!.at / 1000).toFixed(2)} 秒</small>
    <label className="tb-library-field qq-settings-field">名称<input value={name} maxLength={60} onChange={event => { setName(event.target.value) }} /></label>
    <label className="tb-library-field tb-library-description qq-settings-field">描述<textarea className="qq-text-input" aria-label="动作描述" rows={4} value={description} maxLength={240} onChange={event => { setDescription(event.target.value) }} /></label>
    <label className="tb-library-field qq-settings-field">播放方式<select value={playback} onChange={event => { setPlayback(event.target.value as 'once' | 'loop') }}><option value="once">单次</option><option value="loop">循环</option></select></label>
  </div>
}

function ImportClip({ value, accept }: { value: ActionLibrary; accept: (value: ActionLibrary) => Promise<void> }) {
  const [script, setScript] = useState<MotionScript>()
  const [name, setName] = useState('')
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState(0)
  const [loop, setLoop] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const preview = useMemo(() => {
    if (!script) return undefined
    try { return sliceScript(script, Math.round(from * 1000), Math.round(to * 1000)) } catch { return undefined }
  }, [script, from, to])
  const loops = useMemo(() => script === undefined ? [] : analyzeLoops(script).candidates, [script])
  return <section className="tb-card tb-library-editor qq-settings-card" aria-label="导入动作片段">
    <input type="file" accept=".funscript,.json" aria-label="选择动作脚本" onChange={event => {
      const file = event.target.files?.[0]
      if (!file) return
      const token = ++sequence.current
      setError(''); setLoading(true); setScript(undefined)
      void (async () => {
        try {
          if (file.size > 2_000_000) throw new Error('脚本文件不能超过 2 MB')
          const source = parseFunscript(await file.text())
          if (token !== sequence.current) return
          setScript(source); setName(file.name.replace(/\.[^.]+$/u, '')); setFrom(source.points[0]!.at / 1000); setTo(Math.min(source.points.at(-1)!.at, source.points[0]!.at + 600000) / 1000); setLoop(false)
        } catch (error) { if (token === sequence.current) setError(reason(error)) }
        finally { if (token === sequence.current) setLoading(false) }
      })()
    }} />
    {script && <>
      <label className="tb-library-field qq-settings-field">名称<input value={name} maxLength={60} onChange={event => { setName(event.target.value) }} /></label>
      <div className="tb-row qq-settings-row"><label>从 <input aria-label="片段开始秒数" type="number" step="0.001" value={from} onChange={event => { setFrom(Number(event.target.value)) }} /> 秒</label><label>到 <input aria-label="片段结束秒数" type="number" step="0.001" value={to} onChange={event => { setTo(Number(event.target.value)) }} /> 秒</label></div>
      {loops.map(candidate => <Button variant="outline" size="sm" key={candidate.fromMs} onClick={() => { setFrom(candidate.fromMs / 1000); setTo(candidate.toMs / 1000); setLoop(true) }}>循环候选：{candidate.fromMs / 1000}–{candidate.toMs / 1000} 秒</Button>)}
      {preview ? <Curve script={preview} /> : <p className="tb-error">请选择脚本内大于零且不超过 600 秒的片段</p>}
      <label><input type="checkbox" checked={loop} onChange={event => { setLoop(event.target.checked) }} />循环播放</label>
      <Button variant="outline" size="sm" disabled={!preview || loading} onClick={() => {
        void (async () => {
          setLoading(true)
          try { await accept({ ...value, library: saveClip(value.library, name, script, Math.round(from * 1000), Math.round(to * 1000), { playback: loop ? 'loop' : 'once' }) }); setError('') }
          catch (error) { setError(`保存失败：${reason(error)}`) }
          finally { setLoading(false) }
        })()
      }}>加入动作库</Button>
    </>}
    {error && <p className="tb-error" role="alert">{error}</p>}
  </section>
}

export const PRESET_LIBRARY_CSS = `
.dsh-toy-buttplug .tb-burst-settings { display:grid; gap:16px; min-width:0; border:0; margin:0; padding:0; }
.dsh-toy-buttplug .tb-climax-section { display:grid; gap:12px; min-width:0; }
.dsh-toy-buttplug .tb-climax-section + .tb-climax-section { padding-top:16px; border-top:1px solid var(--dsw-alias-border-l2); }
.dsh-toy-buttplug .tb-climax-section h3 { flex:none; margin:0; font-size:14px; font-weight:600; }
.dsh-toy-buttplug .tb-burst-row > button { flex:none; }
.dsh-toy-buttplug .tb-burst-row, .dsh-toy-buttplug .tb-burst-settings label { display:flex; align-items:center; gap:8px; min-width:0; }
.dsh-toy-buttplug .tb-burst-row { flex-wrap:wrap; gap:12px; }
.dsh-toy-buttplug .tb-burst-settings label > span { flex:none; }
.dsh-toy-buttplug .tb-burst-settings input { width:64px; }
.dsh-toy-buttplug .tb-burst-settings select { width:auto; max-width:100%; }
.dsh-toy-buttplug .tb-burst-settings > button { justify-self:start; }
.dsh-toy-buttplug .tb-burst-settings .tb-error { margin:0; }
.dsh-toy-buttplug .tb-preset-tier-buttons { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(140px,100%),1fr)); gap:8px; }
.dsh-toy-buttplug .tb-preset-tier { --tb-pool-color:#249965; --dsh-button-outline-color:color-mix(in srgb,var(--tb-pool-color),transparent 55%); height:auto; min-height:36px; padding:8px; gap:6px; white-space:normal; color:color-mix(in srgb,var(--tb-pool-color),var(--dsw-alias-label-primary) 22%); }
.dsh-toy-buttplug .tb-preset-tier[data-tier="medium"] { --tb-pool-color:#d6a321; }
.dsh-toy-buttplug .tb-preset-tier[data-tier="high"] { --tb-pool-color:#e45962; }
.dsh-toy-buttplug .tb-preset-tier[data-tier="burst"] { --tb-pool-color:#9b6bdd; }
.dsh-toy-buttplug .tb-preset-tier[data-tier="aftercare"] { --tb-pool-color:#d872a8; }
.dsh-toy-buttplug .tb-preset-dot { width:7px; height:7px; border-radius:50%; background:var(--tb-pool-color); flex:none; }
.dsh-toy-buttplug .tb-preset-count { font-size:12px; white-space:nowrap; }
.dsh-toy-buttplug.tb-preset-window, .dsh-toy-buttplug.tb-library-window { max-height:100%; width:min(920px,100%); }
.dsh-toy-buttplug.tb-climax-window { width:min(800px,100%); }
.dsh-toy-buttplug.tb-preset-low { --tb-pool-color:#249965; }
.dsh-toy-buttplug.tb-preset-burst { --tb-pool-color:#9b6bdd; }
.dsh-toy-buttplug.tb-preset-aftercare { --tb-pool-color:#d872a8; }
.dsh-toy-buttplug.tb-preset-medium { --tb-pool-color:#d6a321; }
.dsh-toy-buttplug.tb-preset-high { --tb-pool-color:#e45962; }
.dsh-toy-buttplug .tb-preset-content { min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.dsh-toy-buttplug .tb-preset-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
.dsh-toy-buttplug .tb-preset-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr)); gap:12px; }
.dsh-toy-buttplug .tb-preset-card { display:flex; flex-direction:column; gap:12px; min-width:0; padding:12px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md,12px); cursor:pointer; }
.dsh-toy-buttplug .tb-preset-card[data-selected] { border-color:var(--tb-pool-color); background:color-mix(in srgb,var(--tb-pool-color),transparent 94%); }
.dsh-toy-buttplug .tb-preset-card:focus-visible, .dsh-toy-buttplug .tb-preset-thumbnail:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dsh-toy-buttplug .tb-preset-name { display:flex; align-items:center; gap:8px; min-width:0; font-size:14px; line-height:20px; cursor:pointer; overflow-wrap:anywhere; }
.dsh-toy-buttplug .tb-preset-name input { flex:none; margin:0; accent-color:var(--tb-pool-color); }
.dsh-toy-buttplug .tb-preset-thumbnail { display:block; width:100%; padding:0; border:0; border-radius:4px; background:transparent; color:inherit; cursor:zoom-in; }
.dsh-toy-buttplug .tb-preset-thumbnail .tb-library-curve { display:block; height:72px; color:color-mix(in srgb,var(--tb-pool-color),var(--dsw-alias-label-primary) 22%); }
.dsh-toy-buttplug .tb-preset-frequency { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px; }
.dsh-toy-buttplug .tb-preset-frequency-buttons { display:flex; flex-wrap:wrap; gap:2px; }
.dsh-toy-buttplug .tb-preset-frequency-buttons button { padding-inline:7px; }
.dsh-toy-buttplug .tb-preset-frequency output { font-size:12px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dsh-toy-buttplug .tb-preset-high-preference { margin-bottom:16px; padding-bottom:16px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.dsh-toy-buttplug.tb-preset-preview .tb-library-curve { display:block; height:clamp(160px,38vh,340px); }
.dsh-toy-buttplug .tb-preset-axis { display:flex; justify-content:space-between; margin-top:8px; color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsh-toy-buttplug .tb-preset-description { margin:16px 0 0; font-size:14px; line-height:1.6; overflow-wrap:anywhere; }
.dsh-toy-buttplug .tb-library-field { display:flex; align-items:stretch; flex-wrap:wrap; gap:8px; margin:10px 0; }
.dsh-toy-buttplug .tb-library-field > select, .dsh-toy-buttplug .tb-library-field > textarea { flex:1; min-width:140px; }
.dsh-toy-buttplug .tb-library-field > input[type=number] { width:76px; }
.dsh-toy-buttplug .tb-library-editor { display:flex; flex-direction:column; gap:12px; min-width:0; }
.dsh-toy-buttplug .tb-library-curve { width:100%; height:120px; color:var(--dsw-alias-brand-primary,#7299ee); overflow:visible; }
.dsh-toy-buttplug .tb-library-editor input[type=number] { width:90px; }
.dsh-toy-buttplug .tb-library-editor input, .dsh-toy-buttplug .tb-library-editor select, .dsh-toy-buttplug .tb-library-editor textarea { max-width:100%; }
.dsh-toy-buttplug .tb-library-editor textarea { min-height:72px; }
@media (max-width:480px) {
  .dsh-toy-buttplug .tb-preset-tier-buttons { gap:6px; }
  .dsh-toy-buttplug .tb-preset-tier { padding:8px 4px; gap:4px; font-size:12px; }
  .dsh-toy-buttplug .tb-preset-count { display:block; font-size:11px; }
  .dsh-toy-buttplug .tb-preset-dot { width:6px; height:6px; }
}
`
