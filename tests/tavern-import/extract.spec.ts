import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extract } from '../../src/tavern-import/extract.ts'
import { validateAvatar } from '../../src/tavern-import/png.ts'
import { adoptStatic, defaultSelections, hasDynamic, selectedExcerpts, validateBody } from '../../src/tavern-import/static.ts'
import { LIMITS } from '../../src/tavern-import/types.ts'
import { base64, json } from '../../src/tavern-import/util.ts'
import { cardChunk, chunk, input, png, pngInput, source, v1, v2, v3 } from './fixtures.ts'
describe('JSON adapters and original sources', () => {
  it.each([v1, v2, v3])('extracts supported card version %# without mutating source', value => {
    const req = input(value), original = JSON.stringify(req), out = extract(req)
    expect(out.sources[0]!.originalJson).toEqual(value); expect(out.materials.some(m => m.originalText === v1.description)).toBe(true)
    expect(JSON.stringify(req)).toBe(original); expect(out.sources[0]!.originalBase64).toBe(req.sources[0]!.originalBase64)
    expect(extract(req).materials.map(m => m.id)).toEqual(out.materials.map(m => m.id))
  })
  it('accepts BOM and known minor versions; diagnoses missing optional fields', () => {
    const req = input({ spec: 'chara_card_v2', spec_version: '2.1', data: { name: 'A', description: '' } })
    req.sources[0]!.originalBase64 = Buffer.from('\uFEFF' + Buffer.from(req.sources[0]!.originalBase64, 'base64').toString()).toString('base64')
    expect(extract(req).diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['optional-missing', 'version-compatible']))
  })
  it.each([{ name: 'arbitrary' }, { spec: 'chara_card_v4', data: v1 }, { ...v2, spec_version: '3.0' }, { ...v2, data: { ...v1, description: {} } }, { ...v2, data: { ...v1, alternate_greetings: [4] } }])('rejects unsupported/typed card %#', value => { expect(() => extract(input(value))).toThrow() })
  it('keeps V3 extra text and metadata plus unknown extensions intact without fetching assets', () => {
    const value = { ...v3, data: { ...v3.data, source: ['https://invalid.test'], assets: [{ uri: 'file:///private.png' }], creator_notes_multilingual: { zh: '说明' }, extensions: { custom: { nested: '人设' }, depth_prompt: { prompt: '使用简短对白。', depth: 4 } } } }
    const out = extract(input(value))
    expect(out.materials.map(m => m.originalText)).toEqual(expect.arrayContaining(['说明', '岚', '大家好。', '使用简短对白。']))
    expect(out.materials.find(m => m.metadata['unknown'])!.defaultSelected).toBe(false)
    expect(out.sources[0]!.originalJson).toEqual(value)
  })
  it('enforces depth, strict UTF8/base64, source count and sizes without truncating', () => {
    expect(() => json('['.repeat(66) + '0' + ']'.repeat(66))).toThrow('64')
    for (const s of ['abc', 'ab==', '%%%%', 'YQ==\n']) expect(() => base64(s)).toThrow()
    const req = input(); req.sources[0]!.originalBase64 = Buffer.from([0xff]).toString('base64'); expect(() => extract(req)).toThrow('UTF-8')
    expect(() => extract({ kind: 'role', sources: Array(9).fill(source(v1)) })).toThrow('1–8')
    expect(() => base64('A'.repeat(Math.ceil(LIMITS.file / 3) * 4 + 4))).toThrow('上限')
    expect(() => extract({ kind: 'role', sources: Array(3).fill(source({ name: 'A', description: 'a'.repeat(9 * 1024 ** 2) })) })).toThrow('24 MiB')
  })
})
describe('PNG metadata', () => {
  it.each(['tEXt', 'zTXt', 'iTXt'])('reads %s metadata and case-compatible keys', type => { expect(extract(pngInput(png([cardChunk('ChArA', v2, type)]))).sources[0]!.format).toBe('character-v2') })
  it('prefers valid ccv3, deduplicates identical copies, and falls back from invalid V3', () => {
    expect(extract(pngInput(png([cardChunk('chara', v2), cardChunk('ccv3', v3), cardChunk('ccv3', v3)]))).sources[0]!.format).toBe('character-v3')
    const fallback = extract(pngInput(png([cardChunk('ccv3', { bad: true }), cardChunk('chara', v2)])))
    expect(fallback.sources[0]!.format).toBe('character-v2'); expect(fallback.diagnostics[0]!.message).toContain('ccv3')
  })
  it('rejects different valid duplicates instead of choosing the last', () => { expect(() => extract(pngInput(png([cardChunk('chara', v1), cardChunk('chara', { ...v1, name: 'other' })])))).toThrow('多份') })
  it('rejects CRC, chunk length, missing IEND and missing card data', () => {
    const bytes = png([cardChunk('chara', v2)]), crc = Buffer.from(bytes), length = Buffer.from(bytes)
    crc[30] = crc[30]! ^ 1; length.writeUInt32BE(0xffffffff, 33)
    for (const b of [crc, length, bytes.subarray(0, bytes.length - 12), png()]) expect(() => extract(pngInput(b))).toThrow()
  })
  it.each([Buffer.from('%%%'), Buffer.from(Buffer.from([0xff]).toString('base64'))])('rejects invalid metadata base64 or UTF8 %#', value => { expect(() => extract(pngInput(png([chunk('tEXt', Buffer.concat([Buffer.from('chara\0'), value]))])))).toThrow() })
  it('limits cumulative decompressed metadata even for non-card chunks', () => {
    const compressed = deflateSync(Buffer.alloc(LIMITS.pngText + 1, 65))
    expect(() => extract(pngInput(png([chunk('zTXt', Buffer.concat([Buffer.from('comment\0\0'), compressed])), cardChunk('chara', v1)])))).toThrow('上限')
  })
  it('rejects excessive chunks and invalid IHDR parameters', () => {
    expect(() => extract(pngInput(png(Array.from({ length: LIMITS.chunks }, () => chunk('tEXt', Buffer.from('note\0'))))))).toThrow('10000')
    const bytes = png([cardChunk('chara', v1)]), header = Buffer.from(bytes.subarray(16, 29)); header[8] = 7
    const changed = Buffer.concat([bytes.subarray(0, 8), chunk('IHDR', header), bytes.subarray(33)])
    expect(() => extract(pngInput(changed))).toThrow('IHDR')
  })
  it('validates cropped avatar pixels; rejects a signature-only or metadata-bearing picture', () => {
    expect(validateAvatar(png().toString('base64'))).toEqual(png())
    for (const bytes of [png([cardChunk('chara', v2)]), png([], Buffer.from([9, 0, 0, 0, 0])), png([], Buffer.from([0, 1]))]) expect(() => validateAvatar(bytes.toString('base64'))).toThrow()
  })
})
describe('worldbooks have equal body visibility', () => {
  it('preselects explicit main persona only in embedded book, leaves rules, disabled, conditions and mixed text visible', () => {
    const entries = [
      { uid: 1, comment: '无关标题', content: '小岚是图书管理员。', constant: false, key: ['书'], probability: 1 },
      { uid: 1, name: '人设', content: '使用简短对白。', constant: true },
      { content: '小岚喜欢读书。', enabled: true, disable: true },
      { content: '当好感≥80 时，小岚更主动。' },
      { content: '小岚是管理员。\n{{setvar::x::1}}' },
      { content: '小岚是管理员。小明是老师。' },
    ]
    const out = extract(input({ ...v2, data: { name: '小岚', description: '', character_book: { entries } } }))
    const book = out.materials.filter(m => m.metadata['field'] === 'worldbook')
    expect(book.map(m => m.defaultSelected)).toEqual([true, false, false, false, false, false])
    expect(book.map(m => m.originalText)).toEqual(entries.map(e => e.content)); expect(book[0]!.metadata['probability']).toBe(1)
    expect(out.diagnostics.some(d => d.code === 'enabled-conflict')).toBe(true)
  })
  it.each([{ entries: [{ content: '世界事实' }] }, { entries: { abc: { uid: 4, content: '世界事实' } } }, { spec: 'lorebook_v3', data: { entries: [{ content: '世界事实' }] } }])('accepts standalone book %#', value => {
    const out = extract(input(value)); expect(out.materials[0]!.originalText).toBe('世界事实'); expect(out.materials[0]!.defaultSelected).toBe(false)
  })
  it('keeps duplicate book uids separate; external reference can link a supplemental source without merging names', () => {
    const req = input({ ...v2, data: { ...v1, extensions: { world: '同名书' } } }), first = extract(req)
    const diagnostic = first.diagnostics.find(d => d.code === 'missing-source')!
    req.sources.push({ ...source({ entries: [{ uid: 1, content: '文本' }] }), supplements: `${diagnostic.sourceId}:${diagnostic.message}` }, source({ entries: { a: { uid: 1, content: '文本' } } }))
    const out = extract(req), texts = out.materials.filter(m => m.originalText === '文本')
    expect(texts).toHaveLength(2); expect(texts[0]!.id).not.toBe(texts[1]!.id)
  })
  it('refuses excessive entries rather than retaining first N', () => { expect(() => extract(input({ entries: Array.from({ length: LIMITS.materials + 1 }, () => ({ content: '' })) }))).toThrow('10000') })
})
const preset = { name: '聊天', prompts: [
  { identifier: 'a', name: '规则', content: '使用简短对白。', enabled: false }, { identifier: 'b', content: '待审阅' },
  { identifier: 'chatHistory', marker: true }, { identifier: 'worldInfoBefore', marker: true, content: '不是实际世界书' },
], prompt_order: [{ character_id: 1, order: [{ identifier: 'b', enabled: true }] }, { character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'missing', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }] }], assistant_prefill: '预填充', character_book: { entries: [{ content: '采用第一人称。' }] } }
describe('preset adapters', () => {
  it('uses 100001 order while preserving unarranged, marker content and worldbook; preselects nothing', () => {
    const out = extract(input(preset, 'preset'))
    expect(out.groups[0]!.selected).toBe(1)
    expect(out.materials[0]!.metadata).toMatchObject({ enabled: false, effectiveEnabled: true })
    expect(out.materials.find(m => m.originalText === '待审阅')!.metadata['unarranged']).toBe(true)
    expect(out.materials.find(m => m.originalText === '不是实际世界书')!.staticState).toBe('needs-excerpt')
    expect(out.materials.every(m => !m.defaultSelected)).toBe(true)
    expect(out.diagnostics.some(d => d.code === 'missing-prompt')).toBe(true)
  })
  it('switches order groups deterministically; unique/first group and missing order fall back correctly', () => {
    const req = input(preset, 'preset'), id = extract(req).sources[0]!.sourceId
    expect(extract({ ...req, groups: { [id]: 0 } }).materials[0]!.originalText).toBe('待审阅')
    expect(extract(input({ ...preset, prompt_order: [preset.prompt_order[0]] }, 'preset')).groups[0]!.selected).toBe(0)
    expect(extract(input({ ...preset, prompt_order: preset.prompt_order.map(g => ({ ...g, character_id: 2 })) }, 'preset')).groups[0]!.selected).toBe(0)
    expect(extract(input({ prompts: preset.prompts }, 'preset')).materials[0]!.metadata['effectiveEnabled']).toBe(false)
    expect(() => extract({ ...req, groups: { [id]: 99 } })).toThrow('不存在')
  })
  it('reads sharing wrapper data only, leaves connection/tools/prefill as source metadata', () => {
    const value = { format: 'dsh-preset-enhance', version: 1, metadata: { name: '分享' }, preset: { format: 'sillytavern', data: preset }, tools: [{ secret: 'not executed' }] }
    const out = extract(input(value, 'preset')); expect(out.name).toBe('分享'); expect(out.sources[0]!.originalJson).toEqual(value)
    expect(() => extract(input({ ...value, version: 2 }))).toThrow('包装版本')
  })
  it.each([{ prompts: [{ identifier: 'a' }, { identifier: 'a' }] }, { ...preset, prompt_order: [{ order: [{ identifier: 'a', enabled: true }, { identifier: 'a', enabled: false }] }] }])('rejects ambiguous identifiers %#', value => { expect(() => extract(input(value))).toThrow('重复') })
  it('shows legacy text as unknown with diagnosis and never recursively mines arbitrary strings', () => {
    const out = extract(input({ main_prompt: '旧提示', arbitrary: { text: '不提取' } }, 'preset'))
    expect(out.materials).toHaveLength(1); expect(out.materials[0]!.category).toBe('unknown'); expect(out.diagnostics[0]!.code).toBe('format-degraded')
  })
})
describe('static selection', () => {
  it.each(['小岚温柔，小明勇敢', '小岚和小明是老师。', '小岚是老师和小明是医生。'])('does not preselect multiple people in personality: %s', personality => {
    const out = extract(input({ ...v1, description: '', personality })); expect(out.materials.find(m => m.pointer === '/personality')!.defaultSelected).toBe(false)
  })
  it('substitutes only safe names while keeping originals, including literal replacement metacharacters', () => {
    const out = extract(input({ name: '$&岚', personality: '{{char}} likes tea', description: '<char>和<user>。' }))
    expect(out.materials[0]!.staticText).toBe('$&岚和对方（聊天用户）。'); expect(out.materials[0]!.originalText).toContain('<char>')
  })
  it.each(['{{getvar::x}}', '{{original}}', '{{random::a::b}}', '{{unknown}}', '<% x %>', '<script>x()</script>', '<UpdateVariable>_.set("x",1)</UpdateVariable>', '_.assign("x",1)', 'if (好感>=80) 主动', '@@activate_only_after 5', '```js\nx()\n```'])('requires reviewed static excerpt for %s', content => {
    const out = extract(input({ entries: [{ content }] })), selections = defaultSelections(out)
    selections[0]!.selected = true; selections[0]!.category = 'persona'
    expect(() => adoptStatic(out, selections)).toThrow()
    selections[0]!.excerpt = '小岚更主动。'; selections[0]!.reviewed = true; selections[0]!.conditions = ['好感至少80时']
    expect(adoptStatic(out, selections)).toContain('好感至少80时')
  })
  it('preserves two stages independently and requires the bound original conditions', () => {
    const out = extract(input({ entries: [{ content: '当好感≥80 时，小岚更主动。' }, { content: '陌生阶段，小岚说话谨慎。' }] })), selections = defaultSelections(out)
    for (const s of selections) { s.selected = true; s.reviewed = true }
    const body = adoptStatic(out, selections); expect(body).toContain('好感≥80'); expect(body).toContain('陌生阶段')
    selections[0]!.conditions = []; expect(() => adoptStatic(out, selections)).toThrow('条件')
  })
  it('rejects zero choice, stale/duplicate references, unreviewed edits and dynamic final text', () => {
    const out = extract(input(v2, 'preset')), selections = defaultSelections(out)
    expect(() => adoptStatic(out, selections)).toThrow('至少')
    selections[0]!.selected = true; selections[0]!.excerpt = '编辑'; expect(() => selectedExcerpts(out, selections)).toThrow('审阅')
    expect(() => selectedExcerpts(out, [...selections, selections[0]!])).toThrow('重复')
    expect(() => selectedExcerpts(out, [{ ...selections[0]!, materialId: 'stale' }])).toThrow('引用')
    expect(() => validateBody('{{setvar::x::1}}', 'role')).toThrow(); expect(() => validateBody('x'.repeat(20_001), 'preset')).toThrow('20000')
    expect(hasDynamic('<personality>安静</personality>')).toBe(false)
  })
  it('labels examples and greetings as references instead of persona history', () => {
    const out = extract(input(v2, 'preset')), selections = defaultSelections(out)
    for (const s of selections) if (['example', 'opening'].includes(s.category)) s.selected = true
    expect(adoptStatic(out, selections)).toContain('口吻参考'); expect(adoptStatic(out, selections)).toContain('开场参考')
  })
})
