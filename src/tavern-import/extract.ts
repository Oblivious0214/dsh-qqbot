import { isRecord } from '../storage.ts'
import { classify } from './classify.ts'
import { isPng, readCardPng } from './png.ts'
import { LIMITS, type ExtractInput, type Extraction, type Material, type SourceFile } from './types.ts'
import { base64, canonical, fail, hash, json, jsonBytes, pointer, record, text, utf8 } from './util.ts'
const ROLE_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes', 'nickname']
const ARRAY_FIELDS = ['alternate_greetings', 'group_only_greetings']
export function cardData(value: unknown): { data: Record<string, unknown>; prefix: string; format: string } {
  const root = record(value, '角色卡')
  let data = root, prefix = '', format = 'character-v1'
  if (root['spec'] !== undefined) {
    if (root['spec'] !== 'chara_card_v2' && root['spec'] !== 'chara_card_v3') return fail('unsupported', '不支持的角色版本')
    const major = root['spec'] === 'chara_card_v2' ? '2' : '3'
    if (typeof root['spec_version'] !== 'string' || root['spec_version'].split('.')[0] !== major) return fail('unsupported', '不支持的角色版本')
    data = record(root['data'], '/data'); prefix = '/data'; format = `character-v${major}`
  }
  text(data['name'], prefix + '/name')
  if (!ROLE_FIELDS.slice(0, 5).some(k => Object.hasOwn(data, k)) && data['character_book'] === undefined) return fail('unsupported', '不是支持的角色卡结构')
  for (const field of ROLE_FIELDS) if (data[field] !== undefined) text(data[field], prefix + '/' + field)
  for (const field of ARRAY_FIELDS) if (data[field] !== undefined && (!Array.isArray(data[field]) || (data[field] as unknown[]).some(v => typeof v !== 'string'))) return fail('malformed', `${prefix}/${field} 必须是文本数组`)
  return { data, prefix, format }
}
export function extract(input: ExtractInput): Extraction {
  const request = record(input, '提取请求')
  if (request['kind'] !== 'role' && request['kind'] !== 'preset') return fail('malformed', '请选择角色或预设入口')
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > LIMITS.files) return fail('too-large', '每次选择 1–8 个源文件')
  if (input.groups !== undefined && (!isRecord(input.groups) || Object.values(input.groups).some(v => !Number.isInteger(v) || v < 0))) return fail('malformed', '顺序组选择无效')
  const result: Extraction = { kind: input.kind, name: '', sources: [], materials: [], diagnostics: [], groups: [], books: [] }
  let total = 0
  for (const [index, raw] of input.sources.entries()) {
    const item = record(raw, '源文件'), name = text(item['name'], '文件名')
    if (!name || name.length > 1024) return fail('malformed', '文件名无效')
    if (item['supplements'] !== undefined) text(item['supplements'], '补充来源')
    const bytes = base64(item['originalBase64']); total += bytes.length
    if (total > LIMITS.total) return fail('too-large', '原文件合计超过 24 MiB')
    if (bytes.subarray(0, 2).toString() === 'PK' || bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return fail('unsupported', '第一版支持 JSON 和 PNG 资料；暂不支持 CHARX／ZIP 或 WEBP 卡片')
    const sha256 = hash(bytes), sourceId = `s-${index}-${sha256.slice(0, 20)}`
    let value: unknown
    if (isPng(bytes)) {
      const png = readCardPng(bytes, sourceId, v => {
        cardData(v)
        const probe: Extraction = { kind: input.kind, name: '', sources: [], materials: [], diagnostics: [], groups: [], books: [] }
        parseSource(record(v, '角色卡'), { name, sourceId, sha256, originalBase64: '', originalJson: v, format: '' }, probe, undefined)
      }); value = png.value; result.diagnostics.push(...png.diagnostics)
    } else value = json(utf8(bytes))
    const source: SourceFile = { name, originalBase64: item['originalBase64'] as string, sha256, sourceId, originalJson: value, format: '',
      ...item['supplements'] === undefined ? {} : { supplements: item['supplements'] as string } }
    result.sources.push(source)
    parseSource(record(value, '资料'), source, result, input.groups?.[sourceId])
  }
  if (input.groups && Object.keys(input.groups).some(id => !result.groups.some(g => g.sourceId === id))) return fail('malformed', '顺序组引用了无效来源')
  const missing = result.diagnostics.filter(d => d.code === 'missing-source').map(d => `${d.sourceId}:${d.message}`)
  for (const s of result.sources) if (s.supplements && !missing.includes(s.supplements)) return fail('malformed', '补充来源关联已变化，请作为独立来源添加或重新关联')
  // 只有显式关联且全次输入只有一个主角色时才继承语境，不按书名猜测。
  const characters = result.sources.filter(s => /^character-v/.test(s.format))
  if (characters.length === 1) {
    const main = characters[0]!, { data } = cardData(main.originalJson)
    const character = (data['nickname'] as string | undefined)?.trim() || data['name'] as string
    const links = new Set(result.diagnostics.filter(d => d.code === 'missing-source' && d.sourceId === main.sourceId).map(d => `${d.sourceId}:${d.message}`))
    for (const supplemental of result.sources.filter(s => s.supplements && links.has(s.supplements) && ['worldbook', 'lorebook-v3'].includes(s.format))) {
      result.materials = result.materials.map(m => m.sourceId === supplemental.sourceId ? classify(m, result.kind, character) : m)
    }
  }
  if (jsonBytes(result, false, LIMITS.normalized) > LIMITS.normalized) return fail('too-large', '归一资料超过 64 MiB，请减少源文件或条目后重试')
  return result
}
function add(out: Extraction, source: SourceFile, path: string, title: string, content: unknown, metadata: Record<string, unknown>, character = ''): void {
  if (out.materials.length >= LIMITS.materials) return fail('too-large', '资料条目超过 10000 项')
  const originalText = text(content, path), id = 'm-' + hash(`${source.sourceId}\0${path}\0${out.materials.length}`).slice(0, 32)
  const material: Omit<Material, 'category' | 'classificationReason' | 'defaultSelected' | 'staticState' | 'staticText' | 'conditions'> = {
    id, sourceId: source.sourceId, pointer: path, title, originalText, metadata, diagnostics: [] }
  out.materials.push(classify(material, out.kind, character))
}
function diagnostic(out: Extraction, source: SourceFile, code: string, message: string): void { out.diagnostics.push({ sourceId: source.sourceId, code, message }) }
function unknown(out: Extraction, source: SourceFile, path: string, value: unknown): void {
  add(out, source, path, '扩展资料 ' + path, JSON.stringify(value, null, 2), { unknown: true, value })
}
function parseSource(root: Record<string, unknown>, s: SourceFile, out: Extraction, group: number | undefined): void {
  if (root['format'] === 'dsh-preset-enhance') {
    if (root['version'] !== 1) return fail('unsupported', '不支持的分享预设包装版本')
    const preset = record(root['preset'], '/preset')
    if (preset['format'] !== 'sillytavern') return fail('unsupported', '分享包不是酒馆预设')
    s.format = 'dsh-preset-enhance-v1'
    const metadata = isRecord(root['metadata']) ? root['metadata'] : {}
    if (!out.name && typeof metadata['name'] === 'string') out.name = metadata['name']
    parsePreset(record(preset['data'], '/preset/data'), '/preset/data', s, out, group)
  } else if (root['spec'] === 'lorebook_v3') {
    const data = record(root['data'], '/data'); s.format = 'lorebook-v3'; book(data, '/data', s, out, '')
  } else if (Array.isArray(root['prompts'])) { s.format = 'sillytavern-preset'; parsePreset(root, '', s, out, group) }
  else if (root['spec'] !== undefined || typeof root['name'] === 'string' && (ROLE_FIELDS.slice(0, 5).some(k => k in root) || 'character_book' in root)) {
    const { data, prefix, format } = cardData(root); s.format = format
    const name = (data['nickname'] as string | undefined)?.trim() || (data['name'] as string)
    if (!out.name) out.name = data['name'] as string
    const version = root['spec_version']
    if (version !== undefined && version !== (format === 'character-v2' ? '2.0' : '3.0')) diagnostic(out, s, 'version-compatible', `按已知字段提取角色版本 ${String(version)}`)
    for (const field of ROLE_FIELDS) {
      if (data[field] === undefined) { if (field !== 'nickname') diagnostic(out, s, 'optional-missing', `${prefix}/${field} 缺省，按空项处理`); continue }
      const type = field === 'first_mes' ? 'opening' : field === 'mes_example' ? 'example' : field === 'creator_notes' ? 'author' : field
      if (field !== 'nickname') add(out, s, `${prefix}/${field}`, field, data[field], { field: type, version }, name)
    }
    for (const field of ARRAY_FIELDS) for (const [i, content] of ((data[field] ?? []) as string[]).entries()) add(out, s, `${prefix}/${field}/${i}`, `${field} ${i + 1}`, content, { field: 'opening' }, name)
    if (data['nickname'] !== undefined) add(out, s, `${prefix}/nickname`, '昵称', data['nickname'], { field: 'author' }, name)
    if (data['creator_notes_multilingual'] !== undefined) {
      const notes = record(data['creator_notes_multilingual'], prefix + '/creator_notes_multilingual')
      for (const [lang, value] of Object.entries(notes)) add(out, s, `${prefix}/creator_notes_multilingual/${pointer(lang)}`, `作者说明 ${lang}`, value, { field: 'author' }, name)
    }
    if (data['character_book'] !== undefined) book(record(data['character_book'], prefix + '/character_book'), prefix + '/character_book', s, out, name)
    extensions(data['extensions'], prefix + '/extensions', s, out, name)
    const known = new Set(['name', ...ROLE_FIELDS, ...ARRAY_FIELDS, 'character_book', 'extensions', 'creator_notes_multilingual', 'source', 'assets', 'creation_date', 'modification_date', 'tags', 'creator', 'character_version'])
    for (const [key, value] of Object.entries(data)) if (!known.has(key)) unknown(out, s, prefix + '/' + pointer(key), value)
  } else if (root['entries'] !== undefined) { s.format = 'worldbook'; book(root, '', s, out, '') }
  else if (['main_prompt', 'nsfw_prompt', 'jailbreak_prompt'].some(k => k in root)) {
    s.format = 'legacy-text-preset'; diagnostic(out, s, 'format-degraded', '旧文本预设仅提取待分类文本，不还原聊天编排')
    for (const key of ['main_prompt', 'nsfw_prompt', 'jailbreak_prompt']) if (root[key] !== undefined) add(out, s, '/' + key, key, root[key], { unknown: true })
  } else return fail('unsupported', '不是支持的角色卡、世界书或酒馆预设')
}
function extensions(value: unknown, path: string, s: SourceFile, out: Extraction, name: string): void {
  if (value === undefined) return
  for (const [key, item] of Object.entries(record(value, path))) {
    if (key === 'world' && typeof item === 'string' && item.trim()) diagnostic(out, s, 'missing-source', item)
    else if (key === 'depth_prompt' && isRecord(item) && item['prompt'] !== undefined) add(out, s, path + '/depth_prompt/prompt', '深度提示文本', item['prompt'], { field: 'rule', configuration: item }, name)
    else unknown(out, s, path + '/' + pointer(key), item)
  }
}
function book(root: Record<string, unknown>, prefix: string, s: SourceFile, out: Extraction, name: string): void {
  if (!out.name && typeof root['name'] === 'string') out.name = root['name']
  const entries = root['entries']
  if (!Array.isArray(entries) && !isRecord(entries)) return fail('malformed', `${prefix}/entries 必须是数组或对象`)
  const { entries: _entries, ...configuration } = root
  const bookId = 'b-' + hash(`${s.sourceId}\0${prefix}`).slice(0, 32)
  out.books.push({ id: bookId, sourceId: s.sourceId, pointer: prefix, configuration })
  for (const [index, [key, item]] of Object.entries(entries).entries()) {
    const entry = record(item, `${prefix}/entries/${pointer(key)}`)
    for (const flag of ['enabled', 'disable']) if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') return fail('malformed', `${prefix}/entries/${key}/${flag} 必须是布尔值`)
    const disabled = entry['enabled'] === false || entry['disable'] === true
    if (entry['enabled'] !== undefined && entry['disable'] !== undefined && entry['enabled'] === entry['disable']) diagnostic(out, s, 'enabled-conflict', `条目 ${index + 1} 的启用状态矛盾，按禁用保留`)
    const title = [entry['name'], entry['comment']].find(v => typeof v === 'string' && v.trim()) as string | undefined
    add(out, s, `${prefix}/entries/${pointer(key)}/content`, title ?? `条目 ${index + 1}`, entry['content'],
      { ...entry, field: 'worldbook', disabled, ordinal: index, bookId }, name)
  }
}
function parsePreset(root: Record<string, unknown>, prefix: string, s: SourceFile, out: Extraction, requested: number | undefined): void {
  if (!Array.isArray(root['prompts'])) return fail('malformed', `${prefix}/prompts 必须是数组`)
  if (!out.name && typeof root['name'] === 'string') out.name = root['name']
  const prompts = root['prompts'].map((item, i) => record(item, `${prefix}/prompts/${i}`)), ids = new Set<string>()
  for (const p of prompts) {
    const id = text(p['identifier'], 'prompt identifier')
    if (!id || ids.has(id)) return fail('conflict', '预设有重复或空 identifier')
    ids.add(id)
    if (p['enabled'] !== undefined && typeof p['enabled'] !== 'boolean') return fail('malformed', 'prompt enabled 必须是布尔值')
    if (p['content'] !== undefined) text(p['content'], `prompt ${id}/content`)
  }
  let ordered: { id: string; enabled: boolean; order: number }[] = []
  if (root['prompt_order'] !== undefined) {
    if (!Array.isArray(root['prompt_order']) || !root['prompt_order'].length) return fail('malformed', 'prompt_order 必须是非空数组')
    const groups = root['prompt_order'].map((v, i) => record(v, `prompt_order/${i}`))
    // 所有组都检查结构歧义，其他组正文不重复展开。
    for (const g of groups) {
      if (!Array.isArray(g['order'])) return fail('malformed', '顺序组缺少 order 数组')
      const seen = new Set<string>()
      for (const value of g['order']) { const row = record(value, '顺序项'), id = text(row['identifier'], '顺序项 identifier')
        if (seen.has(id)) return fail('conflict', '顺序组有重复 identifier')
        seen.add(id)
        if (typeof row['enabled'] !== 'boolean') return fail('malformed', '顺序项 enabled 必须是布尔值')
      }
    }
    const preferred = groups.findIndex(g => String(g['character_id']) === '100001'), selected = requested ?? (preferred >= 0 ? preferred : 0)
    if (!groups[selected]) return fail('malformed', '所选顺序组不存在')
    out.groups.push({ sourceId: s.sourceId, selected, choices: groups.map((g, index) => ({ index, characterId: g['character_id'] ?? null })) })
    if (groups.length > 1) diagnostic(out, s, 'order-group', `采用顺序组 ${selected + 1}`)
    ordered = (groups[selected]!['order'] as Record<string, unknown>[]).map((row, order) => ({ id: row['identifier'] as string, enabled: row['enabled'] as boolean, order }))
    for (const row of ordered) if (!ids.has(row.id)) diagnostic(out, s, 'missing-prompt', `顺序项 ${row.id} 没有对应正文`)
  } else { if (requested !== undefined) return fail('malformed', '预设没有可选顺序组'); ordered = prompts.map((p, order) => ({ id: p['identifier'] as string, enabled: p['enabled'] !== false, order })) }
  const sequence = [...ordered.filter(r => ids.has(r.id)).map(r => prompts.findIndex(p => p['identifier'] === r.id)), ...prompts.map((_, i) => i).filter(i => !ordered.some(r => r.id === prompts[i]!['identifier']))]
  for (const i of sequence) {
    const p = prompts[i]!, row = ordered.find(r => r.id === p['identifier']), marker = p['marker'] === true
    if (marker && (p['content'] === undefined || p['content'] === '')) continue
    add(out, s, `${prefix}/prompts/${i}/content`, typeof p['name'] === 'string' && p['name'].trim() ? p['name'] : p['identifier'] as string, p['content'] ?? '',
      { ...p, field: 'prompt', disabled: !row?.enabled, unarranged: !row, effectiveEnabled: row?.enabled ?? false, order: row?.order ?? null, marker })
  }
  if (root['assistant_prefill'] !== undefined) add(out, s, prefix + '/assistant_prefill', '助手预填充来源', root['assistant_prefill'], { field: 'prefill' })
  if (root['character_book'] !== undefined) book(record(root['character_book'], prefix + '/character_book'), prefix + '/character_book', s, out, '')
  if (root['entries'] !== undefined) book(root, prefix, s, out, '')
  extensions(root['extensions'], prefix + '/extensions', s, out, '')
}
/** 输入快照指纹包含组选择、源原件与所有编辑。 */
export const extractionFingerprint = (input: unknown): string => hash(canonical(input))
