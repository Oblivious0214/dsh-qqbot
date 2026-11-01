import { describe, expect, it } from 'vitest'
import { defaultMotion } from '../../../src/toy/core/config.ts'
import { analyzeLoops, createReplyPlan, descriptionDraft, emptyLibrary, mapScene, previewPreset, previewScript, queryCatalog, reduceReplyPlan, resolveScene, saveClip, selectAction, selectTimeRange, updateClip, type MotionScript, type PresetPool, type PlanStopReason } from '../../../src/toy/motion-library/index.ts'

function repeated(count = 6): MotionScript {
  const points = [{ at: 0, pos: 0 }]
  for (let i = 0; i < count; i++) points.push({ at: i * 2000 + 700, pos: 80 }, { at: i * 2000 + 1000, pos: 80 }, { at: i * 2000 + 2000, pos: 0 })
  return { points }
}

function library() {
  let result = emptyLibrary()
  result = saveClip(result, '基础波形', repeated(1), 0, 2000, { playback: 'loop', description: '上行、短暂停留、较慢回程。' })
  result = saveClip(result, '短暂停留', repeated(2), 0, 4000, { description: '保留两次往返。' })
  return saveClip(result, '长片段', { points: [{ at: 0, pos: 10 }, { at: 180000, pos: 90 }] }, 0, 180000)
}

describe('editable descriptions and open catalog', () => {
  it('parses the requested seconds and returns a preview selection without changing the source', () => {
    const source = repeated()
    const selected = selectTimeRange(source, '我喜欢从 1.5 秒到 5 秒的感觉')
    expect([selected.fromMs, selected.toMs]).toEqual([1500, 5000])
    expect(selected.script.points[0]!.at).toBe(0)
    expect(selected.script.points.at(-1)!.at).toBe(3500)
    expect(source).toEqual(repeated())
    for (const text of ['从1秒到2秒，或从3秒到4秒', '前几秒', '从5秒到2秒', '从0秒到1000秒', '从1.1234秒到2秒']) {
      expect(() => selectTimeRange(source, text)).toThrow()
    }
  })

  it('falls back to objective descriptions on AI failure and keeps all drafts reviewable', () => {
    const objective = descriptionDraft(repeated())
    expect(objective.source).toBe('objective')
    expect(objective.text).toContain('停留约 15%')
    expect(objective.requiresReview).toBe(true)
    for (const result of [{ ok: false }, { ok: true, text: '' }, { ok: true, text: 'a'.repeat(241) }, { ok: true, text: {} }, { ok: true, text: 'a\nb' }]) {
      expect(descriptionDraft(repeated(), result)).toEqual(objective)
    }
    expect(descriptionDraft(repeated(), { ok: true, text: '先快后慢，有短暂停留。' })).toEqual({ text: '先快后慢，有短暂停留。', source: 'ai-draft', requiresReview: true })
  })

  it('edits text and names without breaking scene references; catalogs have no trajectories or internal keys', () => {
    const original = mapScene(library(), '演示', '基础波形')
    const edited = updateClip(original, '基础波形', { name: '演示波形', description: '用户描述' })
    expect(resolveScene(edited, '演示')?.name).toBe('演示波形')
    expect(resolveScene(original, '演示')?.name).toBe('基础波形')
    expect(queryCatalog(edited).map(c => c.name)).toEqual(['演示波形', '短暂停留', '长片段'])
    const text = JSON.stringify(queryCatalog(edited))
    expect(text).not.toContain('points')
    expect(text).not.toContain('motion-')
    expect(text).toContain('用户描述')
    expect(queryCatalog(edited, { offset: 1, limit: 1 })).toHaveLength(1)
    expect(() => updateClip(edited, '演示波形', { name: '长片段' })).toThrow('名称')
    expect(() => updateClip(edited, '演示波形', { description: 'a'.repeat(241) })).toThrow('描述')
  })
})

describe('conservative repeat extraction', () => {
  it('finds an observed short loop, reports evidence, and never replaces the source automatically', () => {
    const source = repeated()
    const result = analyzeLoops(source)
    expect(result.reason).toBe('repeated-waveform-found')
    const candidate = result.candidates[0]!
    expect(candidate.periodMs).toBe(2000)
    expect(candidate.observedRepeats).toBe(6)
    expect(candidate.observedCoverage).toBe(1)
    expect(candidate.maxPositionError).toBe(0)
    expect(candidate.reviewRequired).toBe(true)
    expect(candidate.points).toEqual(repeated(1).points)
    expect(source).toEqual(repeated())
    expect(result.fallback).toBe('keep-original')
  })

  it('refuses an isolated closed cycle, open seam, flat or nonrepeating waveform', () => {
    const inputs = [repeated(1), { points: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 20 }] },
      { points: [{ at: 0, pos: 20 }, { at: 20000, pos: 20 }] },
      { points: [{ at: 0, pos: 0 }, { at: 1000, pos: 20 }, { at: 2000, pos: 0 }, { at: 3000, pos: 40 }, { at: 4000, pos: 0 }, { at: 5000, pos: 90 }, { at: 6000, pos: 0 }] }]
    for (const input of inputs) {
      expect(analyzeLoops(input).candidates).toEqual([])
      expect(analyzeLoops(input).fallback).toBe('keep-original')
    }
    expect(() => saveClip(emptyLibrary(), '不闭合', inputs[1]!, 0, 2000, { playback: 'loop' })).toThrow('不闭合')
  })

  it('does not infer a reliable loop from changing narrow peaks missed by a coarse grid', () => {
    const points = [{ at: 0, pos: 0 }]
    for (let cycle = 0; cycle < 3; cycle++) {
      const at = cycle * 2000
      points.push({ at: at + 500, pos: 80 }, { at: at + 501, pos: 80 + cycle * 8 }, { at: at + 502, pos: 80 }, { at: at + 2000, pos: 0 })
    }
    expect(analyzeLoops({ points }).candidates).toEqual([])
  })

  it('analyzes long imports while preserving the long original as a fallback', () => {
    const result = analyzeLoops(repeated(150))
    expect(result.candidates[0]!.periodMs).toBe(2000)
    expect(result.candidates[0]!.observedCoverage).toBeLessThan(1)
    const selected = selectTimeRange(repeated(150), '从0秒到300秒')
    expect(selected.script.points.at(-1)!.at).toBe(300000)
  })
})

describe('three speed pools and shape-preserving retiming', () => {
  const pool: PresetPool = [{ name: '基础波形', weight: 'low' }, { name: '短暂停留', weight: 'high' }]

  it('selects once deterministically by weight, honors names in the pool and draws for the rest', () => {
    const lib = library()
    const counts = new Map<string, number>()
    for (let seed = 0; seed < 400; seed++) {
      const selected = selectAction(lib, pool, seed)
      expect(selectAction(lib, pool, seed)).toEqual(selected)
      counts.set(selected.name, (counts.get(selected.name) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual(['基础波形', '短暂停留'])
    // 权重 1:3。
    expect(counts.get('短暂停留')!).toBeGreaterThan(counts.get('基础波形')! * 2)
    expect(selectAction(lib, pool, 0, '基础波形').name).toBe('基础波形')
    expect(selectAction(lib, pool, 0, ' 短暂停留 ').name).toBe('短暂停留')
    // 不在池里的名称（含库里有的）按 auto 抽。
    expect(selectAction(lib, pool, 7, '长片段')).toEqual(selectAction(lib, pool, 7))
    expect(selectAction(lib, pool, 7, 'missing')).toEqual(selectAction(lib, pool, 7))
    expect(() => selectAction(lib, [], 0)).toThrow('为空')
  })

  it('keeps all relative leg durations when a sharp leg forces slower motion', () => {
    const preview = previewScript({ points: [{ at: 0, pos: 0 }, { at: 100, pos: 100 }, { at: 400, pos: 100 }, { at: 1000, pos: 0 }] },
      { minPosition: 0, maxPosition: 100, maxSpeed: 100 })
    expect(preview.timeStretch).toBe(10)
    expect(preview.legs.slice(1).map(leg => leg.durationMs)).toEqual([1000, 3000, 6000])
    expect(preview.retimedLegs).toBe(3)
  })

  it('previews all speed groups without replacing the source shape or forcing minimum speed on holds', () => {
    const source = library().clips[0]!
    const previews = (['low', 'medium', 'high'] as const).map(tier => previewPreset(source, tier, defaultMotion(), { tempo: 'tier' }))
    for (const preview of previews) {
      expect(preview.legs.map(p => p.target)).toEqual([0, 80, 80, 0])
      expect(preview.legs[2]!.kind).toBe('hold')
    }
    expect(previews[0]!.durationMs).toBeGreaterThanOrEqual(previews[1]!.durationMs)
    expect(previews[1]!.durationMs).toBeGreaterThanOrEqual(previews[2]!.durationMs)
    expect(source.points).toEqual(repeated(1).points)
  })

  it('keeps a closed seam under bounded random variation', () => {
    for (let seed = 0; seed < 100; seed++) {
      const preview = previewPreset(library().clips[0]!, 'low', defaultMotion(), { positionJitter: 10, timingJitter: 0.25, seed })
      expect(preview.legs.at(-1)!.target).toBe(preview.legs[0]!.target)
      expect(preview.legs[2]!.kind).toBe('hold')
    }
  })
})

describe('one reply, many independent bubbles', () => {
  const options = { reply: 'reply-1', tier: 'low' as const, seed: 42, budgetMs: 30000 }
  it('keeps a long continuous plan across bubbles without restarting or extending its lease', () => {
    let plan = createReplyPlan(library().clips[2]!, defaultMotion(), options)
    expect(plan.finish).toBe('protection-will-stop')
    expect(plan.preview.sourceDurationMs).toBe(180000)
    plan = reduceReplyPlan(plan, { type: 'elapsed', ms: 500 })
    const before = plan
    for (let i = 0; i < 6; i++) expect(reduceReplyPlan(plan, { type: 'bubble', reply: 'reply-1' })).toBe(before)
    expect(reduceReplyPlan(plan, { type: 'bubble', reply: 'unrelated' })).toBe(before)
    expect(plan.elapsedMs).toBe(500)
    plan = reduceReplyPlan(plan, { type: 'elapsed', ms: 30000 })
    expect(plan.phase).toBe('stopped')
    expect(plan.elapsedMs).toBe(30000)
    expect(plan.stopReason).toBe('timeout')
  })

  it('freezes progress on pause, keeps the seed and stops at reply end', () => {
    let plan = createReplyPlan(library().clips[0]!, defaultMotion(), options)
    plan = reduceReplyPlan(plan, { type: 'elapsed', ms: 1200 })
    const preview = plan.preview
    plan = reduceReplyPlan(plan, { type: 'pause' })
    expect(reduceReplyPlan(plan, { type: 'elapsed', ms: 9000 })).toBe(plan)
    plan = reduceReplyPlan(plan, { type: 'resume' })
    expect(plan.elapsedMs).toBe(1200)
    expect(plan.preview).toBe(preview)
    expect(plan.seed).toBe(42)
    plan = reduceReplyPlan(plan, { type: 'reply-ended' })
    expect(plan.stopReason).toBe('reply-ended')
    expect(reduceReplyPlan(plan, { type: 'resume' })).toBe(plan)
  })

  it.each<PlanStopReason>(['user-interrupted', 'replaced', 'timeout', 'detached', 'disconnected', 'disabled', 'revoked'])('terminal %s wins over pause, bubble and resume', reason => {
    const active = createReplyPlan(library().clips[0]!, defaultMotion(), options)
    const stopped = reduceReplyPlan(reduceReplyPlan(active, { type: 'pause' }), { type: reason })
    expect(stopped.phase).toBe('stopped')
    expect(stopped.stopReason).toBe(reason)
    expect(reduceReplyPlan(stopped, { type: 'resume' })).toBe(stopped)
    expect(reduceReplyPlan(stopped, { type: 'bubble', reply: 'reply-1' })).toBe(stopped)
  })

  it('ends a one-shot at completion while loops remain bounded by protection', () => {
    const single = createReplyPlan(library().clips[1]!, defaultMotion(), options)
    expect(single.finish).toBe('full-clip')
    expect(reduceReplyPlan(single, { type: 'elapsed', ms: 30000 }).stopReason).toBe('completed')
    const loop = createReplyPlan(library().clips[0]!, defaultMotion(), options)
    expect(loop.finish).toBe('finite-loop-budget')
    expect(reduceReplyPlan(loop, { type: 'elapsed', ms: 30000 }).stopReason).toBe('timeout')
    expect(() => createReplyPlan(library().clips[0]!, defaultMotion(), { ...options, budgetMs: 120001 })).toThrow()
  })
})
