/** 离线验证；读取真实解析器/保存接口，不导入控制器或设备连接。 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseFunscript } from '../src/toy/motion-library/script.ts'
import { emptyLibrary, saveClip } from '../src/toy/motion-library/library.ts'
import { builtinLibrary, defaultPresetPools } from '../src/toy/motion-library/builtins.ts'
import { parseActionLibrary } from '../src/toy/motion-library/config.ts'
import { assetRoot, defaultPool, readSources, workspaceRoot, sha256, jsonText } from './convert-motion-presets.mjs'
import { DESCRIPTIONS, GENERATED, RENAMES } from './motion-preset-defs.mjs'

/** 与转换器独立核算每个源段的终点、时差、停留和接缝。 */
export function verifyPreset(entry, text, source, builtin) {
  const raw = JSON.parse(text)
  assert.deepEqual(Object.keys(raw).sort(), ['actions', 'version'])
  assert.equal(raw.version, '1.0')
  for (const action of raw.actions) assert.deepEqual(Object.keys(action).sort(), ['at', 'pos'])
  const script = parseFunscript(text)
  const { points } = script
  assert.equal(points[0].at, 0)
  assert.equal(points[0].pos, source.segments[0][0])
  assert.equal(entry.name, RENAMES[entry.sourceKey] ?? source.name)
  assert.equal(entry.sha256, sha256(text), `${entry.name}: asset digest differs`)
  let time = 0, pointIndex = 0
  const segments = [], omitted = []
  for (const [sourceIndex, [from, to, durationMs]] of source.segments.entries()) {
    assert.equal(points[pointIndex].pos, from, `${entry.name}/${sourceIndex}: start position`)
    assert.ok(Number.isFinite(durationMs) && durationMs >= 0)
    if (durationMs === 0) {
      assert.equal(entry.sourceKey, 'zipper')
      assert.equal(sourceIndex, source.segments.length - 1)
      assert.deepEqual([from, to, durationMs], [50, 50, 0])
      omitted.push({ sourceSegment: sourceIndex + 1, segment: [from, to, durationMs], reason: 'zero-duration stationary tail' })
      continue
    }
    time += durationMs
    const left = points[pointIndex], right = points[++pointIndex]
    assert.ok(right, `${entry.name}: missing point`)
    assert.equal(right.pos, to, `${entry.name}/${sourceIndex}: end position`)
    assert.equal(right.at, Math.floor(time + 0.5), `${entry.name}/${sourceIndex}: cumulative rounding`)
    const timeError = right.at - time
    const segmentError = right.at - left.at - durationMs
    assert.ok(Math.abs(timeError) <= 0.5 + 1e-9)
    assert.ok(Math.abs(segmentError) <= 1 + 1e-9)
    // 每段四分位点的插值位置一致，端点时轴量化误差线性内插仍 <= 0.5ms。
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      assert.equal(left.pos + (right.pos - left.pos) * fraction, from + (to - from) * fraction)
      const mappedTime = left.at + (right.at - left.at) * fraction
      assert.ok(Math.abs(mappedTime - (time - durationMs + durationMs * fraction)) <= 0.5 + 1e-9)
    }
    segments.push({
      sourceSegment: sourceIndex + 1, from, to, hold: from === to,
      sourceDurationMs: durationMs, durationMs: right.at - left.at,
      durationErrorMs: segmentError, sourceEndMs: time, at: right.at, endpointErrorMs: timeError,
    })
  }
  assert.equal(points.length, pointIndex + 1, 'extra points')
  assert.equal(points.at(-1).pos, points[0].pos, 'loop seam position differs')
  // 两周期共用接缝点：下一周期首段未丢失，也没有增加停留或零时长动作。
  const duration = points.at(-1).at
  const doubled = [...points, ...points.slice(1).map(p => ({ at: p.at + duration, pos: p.pos }))]
  assert.deepEqual(parseFunscript(jsonText({ version: '1.0', actions: doubled })).points, doubled)
  assert.equal(doubled.at(-1).at, 2 * duration)
  assert.deepEqual(points, builtin.points, `${entry.name}: differs from current builtin trajectory`)
  for (const field of ['id', 'name', 'description', 'playback', 'loopFromMs']) assert.deepEqual(entry[field], builtin[field], `${entry.name}: ${field}`)
  // 每个文件按实际用户导入路径全段截取、保存；metadata 不塞进轨迹。
  const imported = saveClip(emptyLibrary(), entry.name, script, 0, duration, entry).clips[0]
  for (const field of ['name', 'description', 'playback', 'points']) {
    assert.deepEqual(imported[field], builtin[field], `${entry.name}: import ${field}`)
  }
  return {
    id: entry.id, name: entry.name, sourceKey: entry.sourceKey, file: entry.file,
    pointCount: points.length, sourceSegmentCount: source.segments.length,
    sourceDurationMs: time, durationMs: duration, durationErrorMs: duration - time,
    maxEndpointErrorMs: Math.max(...segments.map(s => Math.abs(s.endpointErrorMs))),
    maxSegmentErrorMs: Math.max(...segments.map(s => Math.abs(s.durationErrorMs))),
    holdCount: segments.filter(s => s.hold).length,
    sourceHoldMs: segments.filter(s => s.hold).reduce((sum, s) => sum + s.sourceDurationMs, 0),
    holdMs: segments.filter(s => s.hold).reduce((sum, s) => sum + s.durationMs, 0),
    closed: true, parserPassed: true, importPassed: true, builtinEqual: true, omitted, segments,
  }
}

export function verifyAssets() {
  const sources = readSources()
  const index = JSON.parse(readFileSync(new URL('index.json', assetRoot), 'utf8'))
  assert.equal(index.format, 'dsh-motion-preset-assets')
  assert.equal(index.version, 1)
  for (const key of ['catalog', 'pools']) {
    assert.deepEqual(index.sources[key], { path: sources[key].path, sha256: sources[key].sha256 })
  }
  const total = 24 + GENERATED.length
  assert.equal(index.presets.length, total)
  assert.equal(new Set(index.presets.map(p => p.file)).size, total)
  assert.equal(new Set(index.presets.map(p => p.name)).size, total)
  assert.deepEqual(readdirSync(assetRoot).sort(), ['index.json', 'README.md', ...index.presets.map(p => p.file)].sort())
  const builtins = builtinLibrary()
  const sourceKeys = Object.keys(sources.catalog.value)
  let imported = emptyLibrary()
  const presets = index.presets.map((entry, i) => {
    assert.equal(entry.id, `motion-${i + 1}`)
    assert.equal(entry.file, `motion-${i + 1}.funscript`)
    assert.equal(entry.sourceOrdinal, i + 1)
    assert.equal(entry.sourceKey, i < 24 ? sourceKeys[i] : GENERATED[i - 24].key)
    assert.equal('points' in entry || 'actions' in entry, false)
    assert.equal(entry.description, DESCRIPTIONS[entry.sourceKey])
    const text = readFileSync(new URL(entry.file, assetRoot), 'utf8')
    const script = parseFunscript(text)
    imported = saveClip(imported, entry.name, script, 0, script.points.at(-1).at, entry)
    if (i >= 24) {
      // 生成轨迹：与定义逐点一致、首尾闭合、与内置库一致。
      const def = GENERATED[i - 24]
      assert.equal(entry.generated, true)
      assert.equal(entry.name, def.name)
      assert.equal(entry.loopFromMs, def.loop === 'last' ? def.actions.at(-3).at : undefined)
      assert.equal(entry.sha256, sha256(text))
      assert.deepEqual(JSON.parse(text), { version: '1.0', actions: def.actions })
      assert.equal(script.points[0].pos, script.points.at(-1).pos)
      assert.deepEqual(script.points, builtins.clips[i].points)
      return undefined
    }
    return verifyPreset(entry, text, sources.catalog.value[entry.sourceKey], builtins.clips[i])
  }).filter(Boolean)
  assert.deepEqual(imported, { ...builtins, clips: builtins.clips.map(c => ({ ...c, source: 'custom' })) }, 'sequential full imports differ')
  assert.deepEqual(index.pools, defaultPresetPools())
  for (const [tier, old] of Object.entries(sources.pools.value)) {
    assert.deepEqual(index.pools[tier], defaultPool(tier, old, sources.catalog.value))
  }
  assert.deepEqual(parseActionLibrary({ revision: 0, library: imported, pools: index.pools }).library, { ...builtins, clips: builtins.clips.map(c => ({ ...c, source: 'custom' })) })
  const summary = {
    presetCount: presets.length, pointCount: presets.reduce((n, p) => n + p.pointCount, 0),
    closedLoops: presets.filter(p => p.closed).length,
    holds: presets.reduce((n, p) => n + p.holdCount, 0),
    omittedSegments: presets.reduce((n, p) => n + p.omitted.length, 0),
    maxEndpointErrorMs: Math.max(...presets.map(p => p.maxEndpointErrorMs)),
    maxSegmentErrorMs: Math.max(...presets.map(p => p.maxSegmentErrorMs)),
    maxDurationErrorMs: Math.max(...presets.map(p => Math.abs(p.durationErrorMs))),
    currentBuiltinAndPoolEquality: true, sequentialImportsPassed: true,
  }
  assert.equal(summary.pointCount, 687)
  assert.equal(summary.omittedSegments, 1)
  return { format: 'dsh-funscript-conversion-verification', version: 1, sources: index.sources, summary, presets }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv.slice(2).every(arg => arg === '--report'), 'Usage: node verify-motion-presets.mjs [--report]')
  const result = verifyAssets()
  if (process.argv.includes('--report')) writeFileSync(new URL('work/funscript-presets-20261031/verification.json', workspaceRoot), jsonText(result))
  console.log(JSON.stringify(result.summary, null, 2))
}
