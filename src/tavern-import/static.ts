import type { Extraction, Material, Selection } from './types.ts'
import { CATEGORIES } from './types.ts'
import { fail, record, text } from './errors.ts'
/** 已知运行机制检查，不是自然语言语义证明；普通 XML 人设标签可保留。 */
export function hasDynamic(value: string): boolean {
  return /\{\{|<%|%>|<\/?(?:script|style|iframe|html|body|updatevariable|mvu|statusbar|statdata|statusplaceholder|status_current_variables)\b|```|\b(?:getvar|setvar|insertvar|updatevar|JSON\.parse|document\.|window\.|eval\s*\(|function\s*\(|if\s*\(|for\s*\(|const\s+\w+\s*=)|_\.(?:set|add|assign|remove|insert)\s*\(|@@[a-zA-Z_]|\$\{/i.test(value)
}
export function substitute(value: string, name: string): string {
  return value.replace(/\{\{char\}\}|<char>|<bot>/gi, () => name || '当前角色')
    .replace(/\{\{user\}\}|<user>/gi, () => '对方（聊天用户）').replace(/\r\n/g, '\n')
}
export function conditionsOf(value: string): string[] {
  // 保留整句，避免从表达式里猜出脱离条件的事实。
  return value.split(/[\r\n]+/).map(s => s.trim()).filter(s => s && !hasDynamic(s)
    && /(?:如果|只有|当.{1,100}时|.{1,40}(?:阶段|时期)|(?:好感(?:度)?|亲密度|信任度)\s*(?:[≥≤><=]|达到|超过|低于|高于|不足|至少|至多)|(?:好感|亲密度|信任度).{0,40}(?:时|后|前|才)|(?:达到|超过|低于|高于).{0,30}(?:后|前|才)|之后|之前|以后|以前|后才|才(?:会|能|更|愿|开始|喜欢|主动|变|可)|\b(?:affection|intimacy|trust)\s*(?:[≥≤><=]|reaches?|exceeds?|above|below)|\b(?:when|unless|if|after|before|only\s+once)\b)/i.test(s))
}
export function defaultSelections(extraction: Extraction): Selection[] {
  return extraction.materials.map(m => ({ materialId: m.id, selected: m.defaultSelected, category: m.category,
    excerpt: m.staticText, conditions: [...m.conditions], reviewed: false }))
}
export interface Adopted { materialId: string; sourceId: string; title: string; category: Selection['category']; excerpt: string; conditions: string[] }
export function selectedExcerpts(extraction: Extraction, selections: Selection[]): Adopted[] {
  if (!Array.isArray(selections)) return fail('malformed', '请选择资料')
  const byId = new Map<string, Selection>()
  for (const input of selections) {
    const s = record(input, '选择项')
    if (typeof s['materialId'] !== 'string' || byId.has(s['materialId']) || !extraction.materials.some(m => m.id === s['materialId'])) return fail('malformed', '资料选择引用无效或重复')
    if (typeof s['selected'] !== 'boolean' || typeof s['reviewed'] !== 'boolean' || !CATEGORIES.includes(s['category'] as Selection['category'])
      || typeof s['excerpt'] !== 'string' || !Array.isArray(s['conditions']) || s['conditions'].some(c => typeof c !== 'string')) return fail('malformed', '资料摘录格式无效')
    byId.set(s['materialId'], input)
  }
  const result: Adopted[] = []
  for (const m of extraction.materials) {
    const s = byId.get(m.id)
    if (!s?.selected) continue
    const excerpt = s.excerpt.trim()
    if (!excerpt || hasDynamic(excerpt) || s.conditions.some(hasDynamic)) return fail('needs-excerpt', `“${m.title}”需要非空静态摘录`)
    if ((m.staticState === 'needs-excerpt' || excerpt !== m.staticText.trim() || m.conditions.length > 0) && !s.reviewed) return fail('needs-excerpt', `请审阅“${m.title}”的静态摘录与条件`)
    if (m.conditions.some(c => !s.conditions.includes(c)) || (requiresCondition(m) && !s.conditions.some(c => c.trim()))) return fail('needs-excerpt', `请保留“${m.title}”的条件或阶段`)
    result.push({ materialId: m.id, sourceId: m.sourceId, title: m.title, category: s.category, excerpt, conditions: s.conditions.map(c => c.trim()).filter(Boolean) })
  }
  if (!result.length) return fail('needs-excerpt', '至少选择一项有效的静态资料')
  return result
}
function requiresCondition(m: Material): boolean { return m.staticState === 'needs-excerpt' && /\bif\b|@@if|好感|阶段|亲密度|\bwhen\b/i.test(m.originalText) }
export function adoptStatic(extraction: Extraction, selections: Selection[]): string {
  return selectedExcerpts(extraction, selections).map(s => {
    const source = extraction.sources.find(f => f.sourceId === s.sourceId)!
    const reference = s.category === 'example' ? '口吻参考：' : s.category === 'opening' ? '开场参考：' : ''
    return `【${source.name} · ${reference}${s.title}】\n${s.conditions.length ? s.conditions.map(c => `条件／阶段：${c}`).join('\n') + '\n' : ''}${s.excerpt}`
  }).join('\n\n')
}
export function validateBody(value: unknown, kind: Extraction['kind']): string {
  const body = text(value, '正文').trim(), limit = kind === 'role' ? 50_000 : 20_000
  if (!body) return fail('invalid-output', '正文不能为空')
  if (body.length > limit) return fail('too-large', `正文最多 ${limit} 个字符，请编辑后保存`)
  if (hasDynamic(body)) return fail('needs-excerpt', '正文仍有运行语法，请编辑为静态文本')
  return body
}
