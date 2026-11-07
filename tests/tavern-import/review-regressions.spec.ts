import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoleLibrary } from '../../src/roles.ts'
import { JailbreakStore } from '../../src/presets.ts'
import { extract } from '../../src/tavern-import/extract.ts'
import { adoptStatic, defaultSelections } from '../../src/tavern-import/static.ts'
import { TavernImportStore } from '../../src/tavern-import/store.ts'
import { LIMITS } from '../../src/tavern-import/types.ts'
import { jsonBytes } from '../../src/tavern-import/util.ts'
import { input, source, v1, v2, v3, payload, png, pngInput, cardChunk } from './fixtures.ts'
const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-tavern-fix-')); roots.push(root)
  const data = { roles: new RoleLibrary(join(root, 'roles'), () => {}), presets: JailbreakStore.at(root, () => {}) }
  return { root, data, store: new TavernImportStore(data) }
}
afterEach(() => { for (const root of roots.splice(0)) {
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(basename(root).startsWith('qqbot-tavern-fix-')).toBe(true)
  rmSync(root, { recursive: true, force: true })
} })
describe('review regressions', () => {
  it('measures escaped UTF-8, omitted values, arrays and indentation before serialization', () => {
    const value = { '中文\n': ['a\"\\', undefined, { value: '测试', omitted: undefined }], empty: {}, list: [] }
    for (const pretty of [false, true]) expect(jsonBytes(value, pretty)).toBe(Buffer.byteLength(JSON.stringify(value, undefined, pretty ? 2 : undefined)))
    expect(jsonBytes(value, true, 10)).toBeGreaterThan(10)
  })
  it('keeps book configuration once with stable references and complete unknown values', () => {
    const notes = 'a'.repeat(128 * 1024), req = input({ entries: Array.from({ length: 128 }, (_, uid) => ({ uid, content: '小岚是老师。', custom: { uid } })), extensions: { notes } })
    const out = extract(req)
    expect(out.books).toHaveLength(1); expect(out.books[0]!.configuration).toEqual({ extensions: { notes } })
    expect(out.materials.every(m => m.metadata['bookId'] === out.books[0]!.id && !Object.hasOwn(m.metadata, 'book'))).toBe(true)
    expect(out.materials[127]!.metadata['custom']).toEqual({ uid: 127 })
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(Buffer.from(req.sources[0]!.originalBase64, 'base64').length * 6)
    expect(extract(req).books[0]!.id).toBe(out.books[0]!.id)
  })
  it('rejects normalized and archive overflow without truncation or creating an archive', () => {
    const mutable = LIMITS as { normalized: number; archive: number }, previous = { normalized: LIMITS.normalized, archive: LIMITS.archive }
    const { store, root } = setup(), p = payload(), preview = store.preview(p)
    try {
      mutable.normalized = 100
      expect(() => extract(input())).toThrow('归一资料超过')
      mutable.normalized = previous.normalized; mutable.archive = 100
      expect(() => store.commit(p, preview)).toThrow('导入档案超过')
      expect(existsSync(join(root, 'import-backups'))).toBe(false)
    } finally { Object.assign(mutable, previous) }
  })
  it.each(['current', 'body', 'delete-file'] as const)('detects complete preset changes: %s', change => {
    const { data, store, root } = setup(), file = join(root, 'presets.json'), p = payload('preset')
    const alternate = data.presets.save({ name: '另一个', head: 'H', mid: '', tail: '' }, true)
    const preview = store.preview(p), disk = JSON.parse(readFileSync(file, 'utf8'))
    if (change === 'current') disk.current = alternate.id
    else disk.presets[0].head = '外部修改'
    if (change === 'delete-file') {
      rmSync(file)
      expect(() => store.commit(p, preview)).toThrow('磁盘预设')
      expect(existsSync(file)).toBe(false)
      // Restore explicitly before retry; missing prior data never becomes defaults.
      writeFileSync(file, JSON.stringify(disk)); data.presets.reload()
    } else {
      writeFileSync(file, JSON.stringify(disk)); const before = readFileSync(file, 'utf8')
      expect(() => store.commit(p, preview)).toThrow('磁盘预设'); expect(readFileSync(file, 'utf8')).toBe(before)
    }
    const next = store.commit(p, store.preview(p))
    const manifest = JSON.parse(readFileSync(join(root, 'import-backups', next.archive, 'manifest.json'), 'utf8'))
    expect(manifest.stage).toBe('complete'); expect(manifest).not.toHaveProperty('assignments')
    expect(data.presets.snapshot()).not.toHaveProperty('roles')
    const snapshot = data.presets.snapshot(); (snapshot.presets[0] as { head: string }).head = 'mutated'
    expect(data.presets.list()[0]!.head).not.toBe('mutated')
  })
  it.each(['小岚在好感达到80后喜欢主动聊天。', '小岚在亲密度超过50之后喜欢聊天。', '小岚在好感低于20之前说话谨慎。', '小岚好感足够高时才会主动。', '小岚在熟悉之后喜欢聊天。', '小岚 is friendly when trust reaches 80.', '小岚 likes chatting only once affection exceeds 80.'])('binds explicit conditions even after manual reclassification: %s', description => {
    const out = extract(input({ name: '小岚', description })), m = out.materials[0]!, selections = defaultSelections(out), s = selections[0]!
    expect(m.defaultSelected).toBe(false); expect(m.conditions).toEqual([description])
    s.selected = true; s.category = 'persona'; expect(() => adoptStatic(out, selections)).toThrow('审阅')
    s.reviewed = true; s.excerpt = '小岚喜欢聊天。'; s.conditions = []
    expect(() => adoptStatic(out, selections)).toThrow('条件')
    s.conditions = [...m.conditions]; expect(adoptStatic(out, selections)).toContain(description)
  })
  it.each(['小岚是20岁的老师。', '小岚出生于2000年。', '小岚喜欢晚上8点读书。', '小岚是有才华的老师。'])('preserves ordinary static facts: %s', description => {
    const m = extract(input({ name: '小岚', description })).materials[0]!
    expect(m.conditions).toEqual([]); expect(m.defaultSelected).toBe(true)
  })
  it.each([undefined, '岚'] as const)('inherits explicit unique role context including nickname: %s', nickname => {
    const req = input({ ...v2, data: { ...v1, nickname, extensions: { world: '人物书' } } }), initial = extract(req), d = initial.diagnostics.find(d => d.code === 'missing-source')!
    const content = `${nickname ?? '小岚'}是图书管理员。`
    req.sources.push({ ...source({ entries: [{ content }] }), supplements: `${d.sourceId}:${d.message}` })
    const m = extract(req).materials.find(m => m.metadata['field'] === 'worldbook')!
    expect(m.category).toBe('persona'); expect(m.defaultSelected).toBe(true)
    req.sources.push(source({ name: '小明', description: '小明是老师。' }))
    expect(extract(req).materials.find(m => m.metadata['field'] === 'worldbook')!.defaultSelected).toBe(false)
    req.sources.pop(); delete req.sources[1]!.supplements
    expect(extract(req).materials.find(m => m.metadata['field'] === 'worldbook')!.defaultSelected).toBe(false)
    req.sources[1]!.supplements = 'stale-reference'; expect(() => extract(req)).toThrow('关联已变化')
  })
  it.each(['tEXt', 'zTXt', 'iTXt'])('fully validates candidates before PNG priority: %s', type => {
    for (const invalid of [{ character_book: 'invalid' }, { character_book: { entries: [{ content: 1 }] } }, { extensions: 'invalid' }, { creator_notes_multilingual: { zh: 1 } }]) {
      const out = extract(pngInput(png([cardChunk('chara', v2, type), cardChunk('ccv3', { ...v3, data: { ...v3.data, ...invalid } }, type)])))
      expect(out.sources[0]!.format).toBe('character-v2'); expect(out.diagnostics.some(d => d.code === 'png-card-invalid')).toBe(true)
    }
    const out = extract(pngInput(png([cardChunk('chara', v2, type), cardChunk('ccv3', { ...v3, data: { ...v3.data, extensions: { unknown: { full: '保留' } } } }, type)])))
    expect(out.sources[0]!.format).toBe('character-v3'); expect(out.materials.some(m => m.originalText.includes('保留'))).toBe(true)
  })
  it('does not swallow candidate capacity failures while falling back', () => {
    const req = pngInput(png([cardChunk('chara', v2), cardChunk('ccv3', { ...v3, data: { ...v3.data, character_book: { entries: Array.from({ length: LIMITS.materials + 1 }, () => ({ content: '' })) } } })]))
    expect(() => extract(req)).toThrow('10000')
  })
})
