import type { Category, ImportKind, Material } from './types.ts'
import { conditionsOf, hasDynamic, substitute } from './static.ts'
export function classify(material: Omit<Material, 'category' | 'classificationReason' | 'defaultSelected' | 'staticState' | 'staticText' | 'conditions'>,
  kind: ImportKind, character: string): Material {
  const value = substitute(material.originalText, character), dynamic = hasDynamic(value), conditions = conditionsOf(value)
  const field = material.metadata['field'], disabled = material.metadata['disabled'] === true
  let category: Category = 'unknown', reason = '无法从本地规则确定用途'
  if (field === 'author') { category = 'author'; reason = '作者说明字段' }
  else if (field === 'opening') { category = 'opening'; reason = '开场参考字段' }
  else if (field === 'example') { category = 'example'; reason = '示例对话字段' }
  else if (dynamic) { category = /[\u4e00-\u9fffA-Za-z]{3}/.test(value.replace(/<[^>]*>|\{\{[^}]*\}\}/g, '')) ? 'mixed' : 'runtime'; reason = '含已知运行语法，需要人工静态摘录' }
  else if (material.metadata['marker'] === true) { category = 'runtime'; reason = '酒馆运行占位来源文本' }
  else if (field === 'personality' && value.trim() && !/\b(?:system|assistant|user)\s*:|系统|指令|扮演|必须|你应|你要|角色们|多人|其他人物/.test(value)
    && (subjectPersona(value, character) || plainTraits(value))) { category = 'persona'; reason = '干净的标准 personality 字段' }
  else if (character && subjectPersona(value, character)) { category = 'persona'; reason = '正文有主角色主体与身份／外貌／经历／关系／口吻属性证据' }
  else if (/^(?:请|始终|使用|采用|保持|回复|叙述|描写|扮演|你应|你要)|\b(?:write|respond|narrate|always)\b/i.test(value.trim())) { category = 'rule'; reason = '静态语言或扮演要求' }
  else if (field === 'worldbook') { category = 'world'; reason = '世界书正文，主角色属性证据不足，保留供审阅' }
  if (material.metadata['unknown'] === true) { category = 'unknown'; reason = '未知扩展原样可读，需人工判断' }
  const conditional = conditions.length > 0 || /@@if|\bif\s*\(/i.test(value)
  return { ...material, category, classificationReason: reason, staticText: value, conditions,
    staticState: dynamic || material.metadata['marker'] === true ? 'needs-excerpt' : 'ready',
    defaultSelected: kind === 'role' && category === 'persona' && !disabled && !dynamic && !conditional && material.metadata['unarranged'] !== true }
}
function subjectPersona(value: string, character: string): boolean {
  const lines = value.split(/[\n。.!！?？；;，,]+/).map(l => l.trim()).filter(Boolean)
  if (!lines.length || /系统|指令|扮演|必须|你应|你要|NPC|其他人物|多人物|多人|\b(?:system|assistant)\b/i.test(value)) return false
  // 每句都须以同一个主角色起头且具有人物属性证据；宁可漏预选，不凭标题或蓝灯推断。
  return lines.every(line => line.startsWith(character) && !/^(?:和|与|及|、|\s+and\s)|(?:和|与|及|\band\b).{1,20}(?:是|性格|\bis\b)/i.test(line.slice(character.length))
    && /(?:是|身高|岁|头发|眼睛|性格|喜欢|讨厌|曾经|出生|说话|口吻|家人|朋友|姐姐|妹妹|父亲|母亲|职业|经历|外貌|\bis\b|\bhas\b|\blikes\b)/i.test(line.slice(character.length)))
}
function plainTraits(value: string): boolean {
  const traits = new Set(['温柔', '耐心', '安静', '内向', '外向', '开朗', '害羞', '谨慎', '冷静', '热情', '善良', '勇敢', '聪明', '细心', '活泼', '严肃', '固执', '幽默', '坦率', '敏感', '自信', '独立', 'friendly', 'shy', 'kind', 'quiet', 'patient', 'gentle', 'calm', 'brave'])
  const tokens = value.trim().toLowerCase().split(/[、，,；;。.!\n／/]+/).map(t => t.trim()).filter(Boolean)
  return tokens.length > 0 && tokens.every(t => traits.has(t))
}
