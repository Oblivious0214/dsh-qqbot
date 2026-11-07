/** 在已有清单上只更新表情条目，保留其他提示词及此前功能的补录。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { memeRule, MEME_FREQUENCIES } from '../src/format.ts'
import { memeGuidePrompt } from '../src/meme-guide.ts'
import { MEME_DESCRIPTION, MEME_PARAMETERS } from '../src/meme-agent.ts'
import { SECTION_ORDER } from '../src/order.ts'
const json = new URL('../docs/prompt-inventory.json', import.meta.url)
const md = new URL('../docs/prompt-inventory.md', import.meta.url)
const data = JSON.parse(readFileSync(json, 'utf8'))
const ids = new Set(['format-meme', 'meme-guide', 'assembled-example', 'meme-scoped-tool'])
const preserved = JSON.stringify(data.entries.filter(e => !ids.has(e.id)))
const entry = id => data.entries.find(e => e.id === id)
const format = entry('format-meme'), oldText = format.text
format.condition = '仅 QQ Bot 的真实会话、存在可用 send_meme 时出现；新宿主按本步 toolSet 判断，rc.5 按本会话 scoped 工具判断。频率 off 仍只在明确请求时使用，但执行范围与其他档一致。'
format.dynamic_parts = '可用图库名称、偏好标签和用户补充要求随角色读取。未选图库时使用文字。PTC 模式在此段附同一工具的准确名称、说明与参数，不带候选或图片内容。'
format.user_editable = 'QQ Bot → 角色 → 表情包：可用图库、偏好标签、表情频率、补充提示词。'
format.text = memeRule('medium'); format.chars = format.text.length
format.variants = MEME_FREQUENCIES.map(key => ({ key, label: `表情频率 ${key}`, text: memeRule(key), chars: memeRule(key).length }))
const example = memeRule('medium', { memePacks: [{ id: 'a', name: '示例图库A' }, { id: 'b', name: '示例图库B' }], memeTags: ['开心', '撒娇'], memePrompt: '（用户填写的表情补充要求）' })
format.variants.push({ key: 'medium+preferences', label: '适中 + 可用图库 + 标签 + 补充要求', text: example, chars: example.length })
const guide = entry('meme-guide'); guide.text = memeGuidePrompt(); guide.chars = guide.text.length
const assembled = entry('assembled-example')
assembled.text = assembled.text.replace(oldText, format.text); assembled.chars = assembled.text.length
assembled.order.parts = assembled.order.parts.map(part => part.startsWith('410 ') ? `410 qqbot:format-meme (${format.chars} 字)` : part)
const tool = { id: 'meme-scoped-tool', name: '角色表情工具与 PTC 声明', kind: 'tool-description',
  order: { value: SECTION_ORDER.FORMAT_MEME, constant: 'SECTION_ORDER.FORMAT_MEME', section_name: 'qqbot:format-meme' },
  source: ['src/meme-agent.ts', 'src/meme-scope.ts', 'src/prompt.ts'],
  condition: '只在 qqbot Agent 注册，且全局 dsh-meme 的 send_meme 仍可用；卸载时撤销遮蔽。Native 使用工具 schema，rc.5 PTC 同时在410段呈现该声明。',
  dynamic_parts: '候选结果按角色选择与全局启用取交集；marker 含图库／图片身份，界面解析后仅显示图片。空范围返回文字说明。',
  user_editable: '角色图库、标签和频率由用户设置；固定工具说明由程序提供。',
  cache_note: '首次替换工具 schema 改变工具前缀；PTC 从410起更新。候选只进入工具结果，不进入稳定system段。',
  text: MEME_DESCRIPTION, chars: MEME_DESCRIPTION.length, parameters: MEME_PARAMETERS,
  variants: [{ key: 'ptc', label: 'PTC声明', text: `tools.send_meme\n${JSON.stringify({ name: 'send_meme', description: MEME_DESCRIPTION, parameters: MEME_PARAMETERS })}` }],
}
data.entries = data.entries.filter(e => e.id !== tool.id); data.entries.push(tool)
assert.equal(JSON.stringify(data.entries.filter(e => !ids.has(e.id))), preserved)
data.meta.plugin_version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
data.meta.meme_scope_supplement = { generated_at: new Date().toISOString(), generator: 'scripts/update-meme-inventory.mjs' }
writeFileSync(json, JSON.stringify(data, null, 2) + '\n')
let text = readFileSync(md, 'utf8').replace(/插件版本 [^，]+，/, `插件版本 ${data.meta.plugin_version}，`)
function render(e, index) {
  const fenced = (value, lang = 'text') => `\n\n\`\`\`${lang}\n${value}\n\`\`\`\n`
  return `## ${index + 1}. ${e.name}（\`${e.id}\`）\n\n- 来源：${e.source.join('，')}\n- 进入条件：${e.condition}\n- 插值：${e.dynamic_parts}\n- 用户可改：${e.user_editable}\n- 缓存：${e.cache_note}\n\n原文（${e.chars}字）：${fenced(e.text)}`
    + (e.variants ?? []).map(v => `\n变体：${v.label}${fenced(v.text)}`).join('')
    + (e.parameters ? `\n参数：${fenced(JSON.stringify(e.parameters, null, 2), 'json')}` : '')
}
for (const [index, e] of data.entries.entries()) {
  if (!ids.has(e.id)) continue
  const re = new RegExp('^## \\d+\\. [^\\n]*`' + e.id + '`[^\\n]*\\n[\\s\\S]*?(?=^## \\d+\\. |$(?![\\s\\S]))', 'm')
  if (re.test(text)) text = text.replace(re, () => render(e, index) + '\n')
  else text += '\n' + render(e, index)
  const table = new RegExp('^\\| \\d+ \\| `' + e.id + '`[^\\n]*$', 'm')
  const line = `| ${index + 1} | \`${e.id}\` | ${e.name} | ${e.kind} | ${e.order?.value ?? ''} | ${e.chars} |`
  if (table.test(text)) text = text.replace(table, line)
  else text = text.replace(/\n\n## 1\./, `\n${line}\n\n## 1.`)
}
writeFileSync(md, text)
console.log(JSON.stringify({ version: data.meta.plugin_version, changed: [...ids], entries: data.entries.length }))
