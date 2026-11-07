import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ActionLibraryStore } from '../../../src/toy/motion-library/store.ts'
import { defaultActionLibrary } from '../../../src/toy/motion-library/builtins.ts'
import { emptyLibrary, parseLibrary, saveClip, updateClip, deserializeLibrary, serializeLibrary } from '../../../src/toy/motion-library/library.ts'
import * as storage from '../../../src/toy/storage.ts'
import { mergeActionLibrary } from '../../../src/toy/client/settings-merge.ts'

afterEach(() => vi.restoreAllMocks())
const script = { points: [{ at: 0, pos: 20 }, { at: 1000, pos: 80 }, { at: 3000, pos: 60 }] }

function oldFixture() {
  const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'library-v1-'))
  const store = ActionLibraryStore.at(dir, () => {})
  const current = store.value
  const imported = saveClip(current.library, '旧非闭合', script, 0, 3000)
  store.save({ ...current, library: imported })
  const file = join(dir, 'motion-library.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.version = raw.library.version = 1
  for (const clip of raw.library.clips) { delete clip.source; delete clip.kind; delete clip.legacyAiRepeat }
  raw.library.clips[0].name = '改名的内置'
  raw.library.clips[0].playback = 'once'
  raw.burstPool = [{ name: '改名的内置', weight: 'high' }]
  raw.aftercarePool = [{ name: '旧非闭合', weight: 'low' }]
  raw.library.mappings = [{ scene: '旧情景', clipId: raw.library.clips.at(-1).id }]
  for (const tier of ['low', 'medium', 'high']) raw.pools[tier] = raw.pools[tier].map((e: { name: string }) => e.name === '稳定节奏' ? { ...e, name: '改名的内置' } : e)
  delete raw.library.clips.at(-1).playback
  const text = JSON.stringify(raw, null, 3) + '\r\n'
  writeFileSync(file, text)
  return { dir, file, raw, text }
}

describe('canonical v2 and published v1 migration', () => {
  it('requires v2 metadata, rejects unknown versions and roundtrips explicit new once', () => {
    const value = saveClip(emptyLibrary(), '完整片段', script, 0, 3000, { kind: 'segment' })
    expect(value.version).toBe(2)
    expect(value.clips[0]).toMatchObject({ source: 'custom', kind: 'segment', playback: 'once' })
    expect(value.clips[0]).not.toHaveProperty('legacyAiRepeat')
    expect(deserializeLibrary(serializeLibrary(value))).toEqual(value)
    for (const field of ['source', 'kind']) {
      const bad = structuredClone(value) as any
      delete bad.clips[0][field]
      expect(() => parseLibrary(bad)).toThrow()
    }
    expect(() => parseLibrary({ ...value, version: 3 })).toThrow('版本')
    expect(() => parseLibrary({ ...value, clips: [{ ...value.clips[0], legacyAiRepeat: false }] })).toThrow('标记')
    expect(saveClip(emptyLibrary(), '伪循环', script, 0, 3000, { kind: 'loop', playback: 'once' }).clips[0]!.points.at(-1)).toEqual({ at: 7000, pos: 20 })
  })

  it('reads v1 without writing; identifies renamed builtins by id and points; retains original bytes/tracks across commits', () => {
    const f = oldFixture()
    const store = ActionLibraryStore.at(f.dir, () => {})
    const value = store.value
    expect(value.library.version).toBe(2)
    expect(value.library.clips[0]).toMatchObject({ source: 'builtin', kind: 'loop', name: '改名的内置', playback: 'once', legacyAiRepeat: true })
    expect(value.library.clips.at(-1)).toMatchObject({ source: 'custom', kind: 'segment', playback: 'once', legacyAiRepeat: true })
    expect(value.library.clips.find(c => c.name === '渐快')!.loopFromMs).toBeDefined()
    expect(value.pools).toEqual(f.raw.pools)
    expect(value.burstPool).toEqual(f.raw.burstPool)
    expect(value.aftercarePool).toEqual(f.raw.aftercarePool)
    expect(value.library.mappings).toEqual(f.raw.library.mappings)
    expect(readFileSync(f.file, 'utf8')).toBe(f.text)
    expect(readdirSync(f.dir).some(n => n.includes('pre-v2'))).toBe(false)
    const deleted = value.library.clips.at(-1)!
    const next = store.save({ ...value, aftercarePool: value.pools.low, library: { ...value.library, mappings: [], clips: value.library.clips.filter(c => c.id !== deleted.id) } })
    store.save(next)
    store.save(store.value)
    const backup = readdirSync(f.dir).filter(n => n.includes('.pre-v2-'))
    expect(backup).toHaveLength(1)
    expect(readFileSync(join(f.dir, backup[0]!), 'utf8')).toBe(f.text)
    for (const c of f.raw.library.clips) expect(existsSync(join(f.dir, 'motion-scripts', c.file))).toBe(true)
    expect(ActionLibraryStore.at(f.dir, () => {}).value.library.clips.some(c => c.id === deleted.id)).toBe(false)
    expect(JSON.parse(readFileSync(f.file, 'utf8')).version).toBe(2)
  })

  it('does not infer builtin from id or name alone; generic v1 parsing has no asset authority', () => {
    const original = defaultActionLibrary().library
    const v1 = { ...original, version: 1, clips: original.clips.map(c => ({ ...c, playback: 'once', points: c.id === 'motion-1' ? script.points : c.points })) }
    expect(parseLibrary(v1).clips.every(c => c.source === 'custom')).toBe(true)
    const f = oldFixture()
    // Same id with a different complete trajectory is custom.
    f.raw.library.clips[0].file = f.raw.library.clips.at(-1).file
    writeFileSync(f.file, JSON.stringify(f.raw))
    expect(ActionLibraryStore.at(f.dir, () => {}).value.library.clips[0]!.source).toBe('custom')
  })

  it('preserves metadata on rename, clears compatibility only on explicit playback or trajectory edit', () => {
    const v1 = parseLibrary({ format: 'dsh-motion-library-preview', version: 1, clips: [{ id: 'motion-1', name: '旧动作', ...script }], mappings: [] })
    const renamed = updateClip(v1, '旧动作', { name: '新名称' })
    expect(renamed.clips[0]!.legacyAiRepeat).toBe(true)
    expect(updateClip(renamed, '新名称', { playback: 'once' }).clips[0]).not.toHaveProperty('legacyAiRepeat')
    const builtin = defaultActionLibrary().library
    const edited = updateClip(builtin, '渐快', { points: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }] })
    expect(edited.clips.find(c => c.name === '渐快')).toMatchObject({ source: 'custom', kind: 'loop' })
    expect(edited.clips.find(c => c.name === '渐快')).not.toHaveProperty('loopFromMs')
  })

  it('leaves memory and original v1 index intact when backup or index write fails; retry succeeds', () => {
    const f = oldFixture()
    const store = ActionLibraryStore.at(f.dir, () => {})
    const before = store.value
    const write = vi.spyOn(storage, 'writeJson').mockImplementation(() => { throw new Error('disk full') })
    expect(() => store.save(before)).toThrow('disk full')
    expect(store.value).toEqual(before)
    expect(readFileSync(f.file, 'utf8')).toBe(f.text)
    write.mockRestore()
    expect(store.save(before).revision).toBe(before.revision + 1)
    expect(() => store.save(before)).toThrow('其他页面')
  })

  it('restores a v1 backup and preserves its exact bytes before upgrading', () => {
    const f = oldFixture()
    writeFileSync(f.file + '.bak', f.text)
    writeFileSync(f.file, 'invalid')
    const warnings: string[] = []
    const restored = ActionLibraryStore.at(f.dir, text => warnings.push(text))
    expect(restored.value.library.clips[0]!.source).toBe('builtin')
    expect(warnings.join(' ')).toContain('已从上一份备份恢复')
    const backup = readdirSync(f.dir).find(n => n.includes('pre-v2'))!
    expect(readFileSync(join(f.dir, backup), 'utf8')).toBe(f.text)
  })

  it('merges concurrent descriptions and playback changes without dropping v2 or legacy fields', () => {
    const f = oldFixture()
    const base = ActionLibraryStore.at(f.dir, () => {}).value
    const edited = { ...base, library: updateClip(base.library, '改名的内置', { description: '新的描述' }) }
    const latest = { ...base, library: updateClip(base.library, '旧非闭合', { playback: 'once' }) }
    const merged = mergeActionLibrary(base, edited, latest)
    expect(merged.library.clips[0]).toMatchObject({ source: 'builtin', kind: 'loop', legacyAiRepeat: true, description: '新的描述' })
    expect(merged.library.clips.at(-1)).toMatchObject({ source: 'custom', kind: 'segment', playback: 'once' })
    expect(merged.library.clips.at(-1)).not.toHaveProperty('legacyAiRepeat')
    expect(merged.burstPool).toEqual(base.burstPool)
    expect(merged.aftercarePool).toEqual(base.aftercarePool)
  })
})
