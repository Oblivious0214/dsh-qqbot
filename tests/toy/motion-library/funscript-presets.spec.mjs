import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { builtinLibrary } from '../../../src/toy/motion-library/builtins.ts'
import { assetRoot, convertPreset, jsonText, readSources, runConversion, sha256 } from '../../../scripts/convert-motion-presets.mjs'
import { verifyAssets, verifyPreset } from '../../../scripts/verify-motion-presets.mjs'

const index = JSON.parse(readFileSync(new URL('index.json', assetRoot), 'utf8'))
const sources = readSources()
const builtins = builtinLibrary()
const read = entry => readFileSync(new URL(entry.file, assetRoot), 'utf8')

describe('builtin funscript assets: 24 converted, the rest generated', () => {
  for (const [i, entry] of index.presets.entries()) {
    if (entry.generated) continue
    it(`${entry.name}: real import, source trajectory, rounding, holds and two-cycle seam`, () => {
      const result = verifyPreset(entry, read(entry), sources.catalog.value[entry.sourceKey], builtins.clips[i])
      expect(result.parserPassed && result.importPassed && result.closed && result.builtinEqual).toBe(true)
    })
  }

  it('preserves all 687 points, metadata, source order and three default pools in full imports', () => {
    const result = verifyAssets()
    expect(result.summary).toMatchObject({ presetCount: 24, pointCount: 687, closedLoops: 24, omittedSegments: 1 })
    expect(result.summary.maxEndpointErrorMs).toBeLessThanOrEqual(0.5 + 1e-9)
  })

  it('reproduces every generated file byte-for-byte without writing', () => {
    // 29 条轨迹加 index.json、README.md。
    expect(runConversion(true)).toBe(index.presets.length + 2)
    expect(index.presets).toHaveLength(29)
    expect(index.presets.filter(p => p.generated).map(p => p.name)).toEqual(['渐快', '渐慢', '间歇', '快去慢回', '慢去快回'])
  })

  it('rounds cumulative time rather than summing rounded segment lengths', () => {
    const script = JSON.parse(read(index.presets[0]))
    expect(script.actions.map(p => p.at)).toEqual([0, 333, 667])
  })

  it('rejects a legal but changed position even when its asset digest is updated', () => {
    const entry = index.presets[0]
    const raw = JSON.parse(read(entry))
    raw.actions[1].pos = 99
    const text = jsonText(raw)
    expect(() => verifyPreset({ ...entry, sha256: sha256(text) }, text, sources.catalog.value[entry.sourceKey], builtins.clips[0])).toThrow('end position')
  })

  it('rejects cumulative time drift even when the changed file parses and its digest matches', () => {
    const entry = index.presets[0]
    const raw = JSON.parse(read(entry))
    raw.actions[2].at = 666
    const text = jsonText(raw)
    expect(() => verifyPreset({ ...entry, sha256: sha256(text) }, text, sources.catalog.value[entry.sourceKey], builtins.clips[0])).toThrow('cumulative rounding')
  })

  it('uses strict real parsing to reject duplicate timestamps', () => {
    const entry = index.presets[0]
    const raw = JSON.parse(read(entry))
    raw.actions[2].at = raw.actions[1].at
    const text = jsonText(raw)
    expect(() => verifyPreset({ ...entry, sha256: sha256(text) }, text, sources.catalog.value[entry.sourceKey], builtins.clips[0])).toThrow('严格递增')
  })

  it('does not discard new zero-duration or discontinuous source segments', () => {
    expect(() => convertPreset('new', { segments: [[0, 0, 0], [0, 10, 100], [10, 0, 100]] })).toThrow()
    expect(() => convertPreset('new', { segments: [[0, 10, 100], [20, 0, 100]] })).toThrow('discontinuous')
    expect(() => convertPreset('new', { segments: [[0, 10, 0], [10, 0, 100]] })).toThrow()
  })

  it('keeps positive-duration holds as separate stationary segments', () => {
    expect(convertPreset('hold-fixture', { segments: [[0, 100, 100.4], [100, 100, 200.4], [100, 0, 100.4]] }).actions)
      .toEqual([{ at: 0, pos: 0 }, { at: 100, pos: 100 }, { at: 301, pos: 100 }, { at: 401, pos: 0 }])
  })
})
