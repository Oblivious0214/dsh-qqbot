import { describe, expect, it } from 'vitest'
import { closeLoop, createStandbySample, deserializeLibrary, emptyLibrary, mapScene, parseFunscript, parseLibrary, previewScript, resolveScene, saveClip, serializeLibrary, sliceScript, SCRIPT_LIMITS, updateClip } from '../../../src/toy/motion-library/index.ts'

const raw = JSON.stringify({ version: '1.0', actions: [{ at: 1000, pos: 0 }, { at: 2000, pos: 100 }, { at: 3000, pos: 100 }, { at: 4000, pos: 0 }] })
const script = () => parseFunscript(raw)
const clip = () => sliceScript(script(), 1500, 3500)
const limits = { minPosition: 10, maxPosition: 90, maxSpeed: 100 }

describe('funscript data and slicing', () => {
  it('retains the exact trajectory, interpolated boundaries and hold', () => {
    const source = script()
    expect(sliceScript(source, 1500, 3500).points).toEqual([
      { at: 0, pos: 50 }, { at: 500, pos: 100 }, { at: 1500, pos: 100 }, { at: 2000, pos: 50 },
    ])
    expect(source).toEqual(script())
    expect(sliceScript(source, 1000, 4000).points).toHaveLength(4)
  })

  it('accepts BOM, normalizes inversion once and drops opaque metadata', () => {
    const parsed = parseFunscript('\uFEFF' + JSON.stringify({ inverted: true, metadata: { command: 'do not run' }, actions: [{ at: 0, pos: 20 }, { at: 100, pos: 80 }] }))
    expect(parsed).toEqual({ points: [{ at: 0, pos: 80 }, { at: 100, pos: 20 }] })
  })

  it.each([
    {}, [], { actions: [] }, { actions: [{ at: 0, pos: 1 }] },
    { actions: [{ at: 0, pos: 0 }, { at: 0, pos: 1 }] },
    { actions: [{ at: 2, pos: 0 }, { at: 1, pos: 1 }] },
    { actions: [{ at: 0, pos: 0 }, { at: 1, pos: 101 }] },
    { actions: [{ at: 0, pos: 0 }, { at: 1.5, pos: 1 }] },
    { actions: [{ at: 0, pos: 0 }, { at: 1, pos: '2' }] },
    { actions: [{ at: 0, pos: 0 }, { at: 3_600_001, pos: 1 }] },
    { ...JSON.parse(raw), version: '2.0' }, { ...JSON.parse(raw), inverted: 'yes' },
    { ...JSON.parse(raw), axes: [] }, { ...JSON.parse(raw), scripts: {} },
  ])('rejects malformed or unsupported input %#', value => {
    expect(() => parseFunscript(JSON.stringify(value))).toThrow()
  })

  it('bounds text, point count, numeric domain and slice windows', () => {
    expect(() => parseFunscript('x'.repeat(SCRIPT_LIMITS.jsonCharacters + 1))).toThrow('过大')
    expect(() => parseFunscript('{')).toThrow('JSON')
    expect(() => parseFunscript('{"actions":[{"at":0,"pos":0},{"at":1,"pos":1e400}]}')).toThrow()
    expect(() => parseFunscript(JSON.stringify({ actions: Array.from({ length: 20001 }, (_, at) => ({ at, pos: 0 })) }))).toThrow('数量')
    for (const [a, b] of [[999, 2000], [1000, 4001], [2000, 2000], [3000, 2000], [1500.5, 3000], [NaN, 3000]]) {
      expect(() => sliceScript(script(), a!, b!)).toThrow()
    }
    expect(() => sliceScript({ points: [{ at: 0, pos: 0 }, { at: 600001, pos: 1 }] }, 0, 600001)).toThrow('600')
  })

  it('closes a loop by returning to the start at the ending speed', () => {
    expect(closeLoop([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 50 }])).toEqual([
      { at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 50 }, { at: 3000, pos: 0 },
    ])
    const closed = [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }]
    expect(closeLoop(closed)).toEqual(closed)
    expect(closeLoop([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 100 }])).toEqual([
      { at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 100 }, { at: 3000, pos: 0 },
    ])
    const nearLimit = [{ at: 0, pos: 0 }, { at: 599000, pos: 100 }, { at: 599600, pos: 50 }]
    const repaired = closeLoop(nearLimit)
    expect(repaired.at(-1)).toEqual({ at: 599600, pos: 0 })
    expect(repaired.slice(0, 2)).toEqual(nearLimit.slice(0, 2))
  })

  it('repairs only the tail at duration or point limits, preserving the source and every valid bound', () => {
    const full = [{ at: 0, pos: 0 }, { at: 600000, pos: 100 }]
    expect(closeLoop(full)).toEqual([{ at: 0, pos: 0 }, { at: 540000, pos: 90 }, { at: 600000, pos: 0 }])
    expect(full.at(-1)!.pos).toBe(100)
    const dense = Array.from({ length: 20000 }, (_, at) => ({ at, pos: at / 200 }))
    const fixed = closeLoop(dense)
    expect(fixed.length).toBeLessThanOrEqual(20000)
    expect(fixed.at(-1)).toEqual({ at: 19999, pos: 0 })
    expect(fixed.filter(p => p.at < 18000)).toEqual(dense.filter(p => p.at < 18000))
    for (const points of [full, dense, [{ at: 0, pos: 25 }, { at: 1, pos: 75 }]]) {
      const loop = closeLoop(points)
      expect(loop[0]!.pos).toBe(loop.at(-1)!.pos)
      expect(loop.every((p, i) => Number.isSafeInteger(p.at) && p.pos >= 0 && p.pos <= 100 && (!i || p.at > loop[i-1]!.at))).toBe(true)
      expect(closeLoop(loop)).toEqual(loop)
    }
  })
})

describe('snapshot library and explicit scene mapping', () => {
  it('generates IDs, saves copied points, round-trips data and resolves only exact scene selections', () => {
    const base = emptyLibrary()
    const saved = saveClip(base, ' 匀速示例 ', script(), 1500, 3500)
    const mapped = mapScene(saved, '节奏演示', '匀速示例')
    expect(base.clips).toEqual([])
    expect(saved.mappings).toEqual([])
    expect(saved.clips[0]!.id).toBe('motion-1')
    expect(deserializeLibrary(serializeLibrary(mapped))).toEqual(mapped)
    expect(resolveScene(mapped, '节奏演示')?.points).toEqual(clip().points)
    expect(resolveScene(mapped, '请在节奏演示时播放')).toBeUndefined()
    expect(resolveScene(mapped, '未知情景')).toBeUndefined()
    expect(serializeLibrary(mapped)).not.toContain('metadata')
    expect(saveClip(saved, '第二段', script(), 1000, 2000).clips[1]!.id).toBe('motion-2')
  })

  it('checks normalized names and broken references without overwriting existing entries', () => {
    const saved = saveClip(emptyLibrary(), 'Demo', script(), 1000, 2000)
    expect(() => saveClip(saved, ' ＤＥＭＯ ', script(), 2000, 3000)).toThrow('已有同名动作')
    for (const label of ['', 'a\nb', 'a'.repeat(61)]) expect(() => saveClip(saved, label, script(), 1000, 2000)).toThrow('名称')
    expect(() => mapScene(saved, '演示', '缺失')).toThrow('找不到')
    const mapped = mapScene(saved, 'demo', 'demo')
    expect(() => mapScene(mapped, ' ＤＥＭＯ ', 'demo')).toThrow('情景名称')
    expect(() => parseLibrary({ ...saved, mappings: [{ scene: '演示', clipId: 'missing' }] })).toThrow('不存在')
    expect(() => parseLibrary({ ...saved, clips: [...saved.clips, ...saved.clips] })).toThrow('标识')
    expect(() => deserializeLibrary('{"format":"another","version":1}')).toThrow('格式')
    expect(saved.clips).toHaveLength(1)
  })

  it('keeps each clip within its own point limit without a shared library total', () => {
    const saved = saveClip(emptyLibrary(), '示例', script(), 1000, 2000)
    expect(() => parseLibrary({ ...saved, clips: Array(101).fill(saved.clips[0]) })).toThrow('100')
    expect(() => parseLibrary({ ...saved, mappings: Array(101).fill({ scene: 'x', clipId: 'motion-1' }) })).toThrow('100')
    expect(() => parseLibrary({ ...saved, clips: [{ ...saved.clips[0], points: script().points }] })).toThrow('从零')
    const points = Array.from({ length: 11000 }, (_, at) => ({ at, pos: 50 }))
    expect(parseLibrary({ ...saved, clips: [{ source: 'custom', kind: 'segment', id: 'motion-1', name: 'a', points }, { source: 'custom', kind: 'segment', id: 'motion-2', name: 'b', points }] }).clips).toHaveLength(2)
  })

  it('appends a closing point when saving or editing a loop whose ends differ', () => {
    const open = { points: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 40 }] }
    const saved = saveClip(emptyLibrary(), '开环', open, 0, 2000, { kind: 'loop' })
    expect(saved.clips[0]!.points.at(-1)).toEqual({ at: 2667, pos: 0 })
    const edited = saveClip(saved, '改截取', open, 0, 2000)
    expect(edited.clips[1]!.points).toEqual(open.points)
    const trimmed = updateClip(saved, '开环', { points: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 1500, pos: 70 }] })
    expect(trimmed.clips[0]!.points.at(-1)).toEqual({ at: 2667, pos: 0 })
    const segment = saveClip(emptyLibrary(), '片段', open, 0, 2000)
    expect(updateClip(segment, '片段', { playback: 'loop' }).clips[0]!.points.at(-1)).toEqual({ at: 2667, pos: 0 })
    expect(saveClip(emptyLibrary(), '停住', { points: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 100 }] }, 0, 2000, { kind: 'loop' }).clips[0]!.points.at(-1)).toEqual({ at: 3000, pos: 0 })
  })
})

describe('bounded preview, never playback', () => {
  it('returns a reviewable fixed input/output including entry cost and preserved hold', () => {
    const result = previewScript(clip(), limits)
    expect(result).toEqual({
      kind: 'motion-preview', executable: false, sourceDurationMs: 2000, durationMs: 4500,
      retimedLegs: 0, timeStretch: 1, seed: 0, bounds: [10, 90], legs: [
        { kind: 'entry', target: 50, durationMs: 2500, endsAtMs: 2500, sourceAtMs: 0 },
        { kind: 'move', target: 90, durationMs: 500, endsAtMs: 3000, sourceAtMs: 500 },
        { kind: 'hold', target: 90, durationMs: 1000, endsAtMs: 4000, sourceAtMs: 1500 },
        { kind: 'move', target: 50, durationMs: 500, endsAtMs: 4500, sourceAtMs: 2000 },
      ],
    })
  })

  it('retimes fast input instead of exceeding speed or concealing the delay', () => {
    const fast = { points: [{ at: 0, pos: 0 }, { at: 1, pos: 100 }] }
    const result = previewScript(fast, { ...limits, maxSpeed: 40, speedScale: 4 })
    expect(result.legs[1]!.durationMs).toBe(2000)
    expect(result.retimedLegs).toBe(1)
    expect(result.durationMs).toBe(6500)
    expect(() => previewScript(fast, { ...limits, maxDurationMs: 1000 })).toThrow('时长上限')
  })

  it('is reproducible across seeds, intersects bounds, limits every leg and does not jitter holds', () => {
    const options = { ...limits, minPosition: 10.2, window: [0, 80.9] as const, positionJitter: 10, timingJitter: 0.25 }
    for (let seed = 0; seed < 150; seed++) {
      const result = previewScript(clip(), { ...options, seed })
      expect(result).toEqual(previewScript(clip(), { ...options, seed }))
      expect(result.bounds).toEqual([11, 80])
      expect(result.legs[2]!.kind).toBe('hold')
      for (let i = 0; i < result.legs.length; i++) {
        const leg = result.legs[i]!
        expect(Number.isInteger(leg.target)).toBe(true)
        expect(leg.target).toBeGreaterThanOrEqual(11)
        expect(leg.target).toBeLessThanOrEqual(80)
        expect(leg.durationMs).toBeGreaterThanOrEqual(100)
        const distance = i === 0 ? Math.max(leg.target, 100 - leg.target) : Math.abs(leg.target - result.legs[i - 1]!.target)
        expect(distance / leg.durationMs * 1000).toBeLessThanOrEqual(i === 0 ? 20 : limits.maxSpeed)
      }
    }
    expect(previewScript(clip(), { ...options, seed: 1 })).not.toEqual(previewScript(clip(), { ...options, seed: 2 }))
  })

  it.each([
    { minPosition: 99, maxPosition: 99.5 }, { minPosition: -1 }, { maxPosition: 101 },
    { maxSpeed: 501 }, { maxSpeed: 0 }, { maxSpeed: NaN }, { startSpeed: Infinity },
    { speedScale: 0 }, { timingJitter: 0.3 }, { positionJitter: 11 }, { seed: -1 },
    { maxDurationMs: 3_600_001 }, { window: [95, 100] as const }, { window: [50, 50] as const },
  ])('rejects invalid preview controls %#', options => {
    expect(() => previewScript(clip(), { ...limits, ...options })).toThrow()
  })

  it('produces finite reproducible standby data without activating an idle loop', () => {
    const options = { cycles: 4, highRange: [20, 60] as const, speedRange: [30, 80] as const, seed: 42 }
    const sample = createStandbySample(options)
    expect(sample).toEqual(createStandbySample(options))
    expect(sample.points).toHaveLength(9)
    sample.points.forEach((point, i) => {
      if (i % 2 === 0) expect(point.pos).toBe(0)
      else { expect(point.pos).toBeGreaterThanOrEqual(20); expect(point.pos).toBeLessThanOrEqual(60) }
    })
    expect(previewScript(sample, limits).executable).toBe(false)
    expect(() => createStandbySample({ ...options, cycles: 21 })).toThrow()
    expect(() => createStandbySample({ ...options, cycles: 20, highRange: [100, 100], speedRange: [2, 2] })).toThrow('600')
    expect(() => createStandbySample({ ...options, speedRange: [50, 20] })).toThrow()
  })
})
