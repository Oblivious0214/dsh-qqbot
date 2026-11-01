import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionLibraryStore } from '../../../src/toy/motion-library/store.ts'
import { defaultActionLibrary } from '../../../src/toy/motion-library/builtins.ts'
import { saveClip } from '../../../src/toy/motion-library/library.ts'
import { parseFunscript } from '../../../src/toy/motion-library/script.ts'
import { ToyHost } from '../../../src/toy/index.ts'
import { Maintenance } from '../../../src/maintenance.ts'
import * as storage from '../../../src/toy/storage.ts'
import type { ActionLibrary } from '../../../src/toy/motion-library/config.ts'

afterEach(() => vi.restoreAllMocks())
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
function fixture() {
  const dir = mkdtempSync(join(process.env['DSH_HOME']!, 'funscript-'))
  const warnings: string[] = []
  const warn = (text: string) => warnings.push(text)
  const store = ActionLibraryStore.at(dir, warn)
  return { dir, file: join(dir, 'motion-library.json'), tracks: join(dir, 'motion-scripts'), store, warnings, warn }
}
function withImport(value: ActionLibrary): ActionLibrary {
  const source = parseFunscript('{"version":"1.0","actions":[{"at":1000,"pos":10},{"at":2000,"pos":90},{"at":3000,"pos":90},{"at":4000,"pos":10}]}')
  return { ...value, library: saveClip(value.library, '导入的片段', source, 1500, 3500,
    { description: '截取后保留停留', playback: 'loop' }) }
}

describe('funscript files and separate library metadata', () => {
  it('loads all builtins from assets and returns independent snapshots', () => {
    const value = defaultActionLibrary()
    expect(value.library.clips).toHaveLength(29)
    // 24 条转换轨迹 687 点，加生成的渐快 13、渐慢 13、间歇 4、快去慢回 3、慢去快回 3。
    expect(value.library.clips.reduce((sum, clip) => sum + clip.points.length, 0)).toBe(723)
    expect(value.library.clips.filter(c => c.loopFromMs !== undefined).map(c => c.name)).toEqual(['渐快', '渐慢'])
    ;(value.library.clips as unknown[]).pop()
    expect(defaultActionLibrary().library.clips).toHaveLength(29)
  })

  it('persists imported slice as funscript, with metadata and pools only in the index', () => {
    const f = fixture()
    const saved = f.store.save(withImport(f.store.value))
    const index = json(f.file)
    expect(index.format).toBe('dsh-motion-library-files')
    expect(index.library.clips).toHaveLength(30)
    for (const clip of index.library.clips) {
      expect(clip).not.toHaveProperty('points')
      expect(clip).not.toHaveProperty('actions')
      const track = json(join(f.tracks, clip.file))
      expect(Object.keys(track).sort()).toEqual(['actions', 'version'])
      expect(parseFunscript(JSON.stringify(track)).points).toEqual(saved.library.clips.find(c => c.id === clip.id)!.points)
    }
    expect(saved.library.clips.at(-1)!.points).toEqual([{ at: 0, pos: 50 }, { at: 500, pos: 90 }, { at: 1500, pos: 90 }, { at: 2000, pos: 50 }])
    expect(ActionLibraryStore.at(f.dir, f.warn).value).toEqual(saved)
    expect(f.warnings).toEqual([])
  })

  it('renames metadata without changing the track file, bytes or mtime', () => {
    const f = fixture()
    const saved = f.store.save(withImport(f.store.value))
    const original = json(f.file).library.clips.at(-1)
    const path = join(f.tracks, original.file), before = readFileSync(path), mtime = statSync(path).mtimeMs
    f.store.save({ ...saved, library: { ...saved.library, clips: saved.library.clips.map(c => c.id === original.id ? { ...c, name: '新名称', description: '新描述', playback: 'once' } : c) } })
    expect(json(f.file).library.clips.at(-1)).toMatchObject({ file: original.file, name: '新名称', playback: 'once' })
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mtimeMs).toBe(mtime)
  })

  it('retains deleted tracks for the previous backup, then collects them when no snapshot refers to them', () => {
    const f = fixture()
    const saved = f.store.save(withImport(f.store.value))
    const path = join(f.tracks, json(f.file).library.clips.at(-1).file)
    const next = f.store.save({ ...saved, library: { ...saved.library, clips: saved.library.clips.slice(0, -1) } })
    expect(existsSync(path)).toBe(true)
    expect(json(`${f.file}.bak`).library.clips).toHaveLength(30)
    f.store.save(next)
    expect(existsSync(path)).toBe(false)
    expect(ActionLibraryStore.at(f.dir, f.warn).value.library.clips).toHaveLength(29)
  })

  it('treats an index without the storage format as unreadable and keeps the file', () => {
    const f = fixture()
    const text = JSON.stringify({ ...withImport(defaultActionLibrary()), revision: 7 })
    writeFileSync(f.file, text)
    const store = ActionLibraryStore.at(f.dir, f.warn)
    expect(f.warnings.join(' ')).toContain('动作库存储版本无效')
    expect(store.value).toEqual(defaultActionLibrary())
    expect(readFileSync(f.file, 'utf8')).toBe(text)
    expect(() => store.save(store.value)).toThrow('动作库及备份无法读取')
  })

  it.each(['invalid-json', 'missing-index', 'missing-track', 'changed-track'])('recovers previous index and its tracks after %s', damage => {
    const f = fixture()
    const before = f.store.save(f.store.value)
    f.store.save(withImport(before))
    const path = join(f.tracks, json(f.file).library.clips.at(-1).file)
    if (damage === 'invalid-json') writeFileSync(f.file, '{')
    if (damage === 'missing-index') unlinkSync(f.file)
    if (damage === 'missing-track') unlinkSync(path)
    if (damage === 'changed-track') writeFileSync(path, '{"version":"1.0","actions":[{"at":0,"pos":0},{"at":100,"pos":0}]}')
    expect(ActionLibraryStore.at(f.dir, f.warn).value).toEqual(before)
    expect(f.warnings.join(' ')).toContain('已从上一份备份恢复')
    if (damage !== 'missing-index') expect(readdirSync(f.dir).some(name => name.includes('.corrupt-'))).toBe(true)
    expect(ActionLibraryStore.at(f.dir, f.warn).value).toEqual(before)
  })

  it('preserves an unreadable library and refuses overwriting it with defaults when no backup works', () => {
    const f = fixture()
    writeFileSync(f.file, '{ broken')
    const broken = ActionLibraryStore.at(f.dir, f.warn)
    expect(() => broken.save(broken.value)).toThrow('原文件已保留')
    expect(readFileSync(f.file, 'utf8')).toBe('{ broken')
  })

  it.each(['traversal', 'embedded-points'])('rejects %s in stored metadata', damage => {
    const f = fixture()
    f.store.save(f.store.value)
    const index = json(f.file)
    if (damage === 'traversal') index.library.clips[0].file = '../outside.funscript'
    else index.library.clips[0].points = [{ at: 0, pos: 0 }, { at: 1, pos: 1 }]
    writeFileSync(f.file, JSON.stringify(index))
    const broken = ActionLibraryStore.at(f.dir, f.warn)
    expect(() => broken.save(broken.value)).toThrow('原文件已保留')
    expect(f.warnings.join(' ')).toContain(damage === 'traversal' ? '轨迹文件引用无效' : '不能内嵌轨迹')
  })

  it('rejects stale revisions and a second store overwriting changes made after it loaded', () => {
    const f = fixture()
    const stale = f.store.value
    const second = ActionLibraryStore.at(f.dir, f.warn)
    f.store.save(stale)
    expect(() => f.store.save(stale)).toThrow('其他页面')
    expect(() => second.save(second.value)).toThrow('其他页面')
  })

  it.each(['track', 'backup', 'index'])('leaves the committed library usable after a %s write fails', phase => {
    const f = fixture()
    const before = f.store.save(f.store.value)
    const indexBefore = readFileSync(f.file, 'utf8')
    const original = storage.writeJson
    vi.spyOn(storage, 'writeJson').mockImplementation((path, value) => {
      if ((phase === 'track' && path.endsWith('.funscript')) || (phase === 'backup' && path === `${f.file}.bak`) || (phase === 'index' && path === f.file)) throw new Error('模拟写入失败')
      original(path, value)
    })
    expect(() => f.store.save(withImport(before))).toThrow('模拟写入失败')
    expect(f.store.value).toEqual(before)
    expect(readFileSync(f.file, 'utf8')).toBe(indexBefore)
    vi.restoreAllMocks()
    expect(ActionLibraryStore.at(f.dir, f.warn).value).toEqual(before)
    expect(f.store.save(withImport(before)).library.clips).toHaveLength(30)
  })

  it('full data cleanup removes user files and backups, restores builtins and rejects the old revision', async () => {
    const home = mkdtempSync(join(process.env['DSH_HOME']!, 'cleanup-funscript-'))
    const dir = join(home, 'toy-buttplug')
    const host = new ToyHost(dir, () => {})
    host.apply({ action: 'library.save', library: withImport(host.actionLibrary.value) })
    const stale = host.actionLibrary.value
    const path = join(dir, 'motion-scripts', json(join(dir, 'motion-library.json')).library.clips.at(-1).file)
    const maintenance = new Maintenance(home, () => {})
    maintenance.register({ reload: () => host.reset() })
    await maintenance.clear('all')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(dir, 'motion-library.json.bak'))).toBe(false)
    expect(host.actionLibrary.value.library.clips).toHaveLength(29)
    expect(() => host.apply({ action: 'library.save', library: stale })).toThrow('其他页面')
    expect(ActionLibraryStore.at(dir, () => {}).value).toEqual(host.actionLibrary.value)
  })
})
