// 补录已批准的动态状态呈现；保留基础清单每个既有条目及其原文。
// 基础生成器 → 本脚本。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { UPDATE_TOOL, UPDATE_DESCRIPTION, UPDATE_PARAMETERS, STATE_GUIDANCE } from '../src/role-dynamics/model.ts'
import { SECTION_ORDER, SECTION_NAME, CONTEXT_ORDER, CONTEXT_NAME } from '../src/order.ts'

const json = new URL('../docs/prompt-inventory.json', import.meta.url)
const md = new URL('../docs/prompt-inventory.md', import.meta.url)
const data = JSON.parse(readFileSync(json, 'utf8'))
const ids = ['dynamics-update-tool', 'dynamics-ptc-declaration', 'runtime-role-dynamics']
const preserved = data.entries.filter(entry => !ids.includes(entry.id))
const originalEntries = JSON.stringify(preserved)
const declaration = `tools.${UPDATE_TOOL}\n${JSON.stringify({ name: UPDATE_TOOL, description: UPDATE_DESCRIPTION, parameters: UPDATE_PARAMETERS })}`
const entries = [
  {
    id: ids[0], name: '动态状态更新工具说明', kind: 'tool-description',
    source: ['src/role-dynamics/model.ts:5', 'src/role-dynamics/agent.ts'],
    condition: '仅真实qqbot Agent、启用动态定义且本轮含可见AI可写字段时登记scoped工具；无Agent诊断、静态、disabled及只读轮无更新能力。',
    dynamic_parts: '说明与JSON Schema固定，参数只有changes目标值；可写字段、值与规则来自本轮冻结context。成功只返回accepted:true。',
    user_editable: '作者编辑动态字段及更新规则；本工具说明使用已批准原文。',
    cache_note: 'Native工具description随工具声明进入请求；首次启停改变工具及后续前缀。同一启用状态下日常数值不改变声明。',
    text: UPDATE_DESCRIPTION, chars: UPDATE_DESCRIPTION.length,
    parameters: UPDATE_PARAMETERS,
  },
  {
    id: ids[1], name: 'PTC动态工具声明（complete内）', kind: 'system-section',
    order: { value: SECTION_ORDER.DYNAMICS_TOOL, constant: 'SECTION_ORDER.DYNAMICS_TOOL', section_name: SECTION_NAME.DYNAMICS_TOOL },
    source: ['src/role-dynamics/agent.ts:19', 'src/prompt.ts', 'src/order.ts'],
    condition: '仅真实qqbot Agent处于PTC且该Agent实际登记qqbot_update_state时，作为唯一qqbot:prompt内的430片段。Native、静态、disabled、只读和诊断不呈现。',
    dynamic_parts: '工具准确名称、已批准description和完整固定JSON Schema；没有动态值。rc.5 wire工具仍只有run_code，complete移除的tools:sdk不作为发现依据。',
    user_editable: '程序呈现已登记工具声明，不增加指令编辑入口。',
    cache_note: '首次加入430片段或工具启停从此处改变稳定前缀；同一启用状态下日常数值、阶段和owner编辑只更新冻结context，跨轮及refresh保持sections字节。',
    text: declaration, chars: declaration.length,
  },
  {
    id: ids[2], name: '运行时·动态状态与生效正文', kind: 'runtime-context',
    order: { value: CONTEXT_ORDER.ROLE_DYNAMICS, constant: 'CONTEXT_ORDER.ROLE_DYNAMICS', context_name: CONTEXT_NAME.ROLE_DYNAMICS },
    source: ['src/role-dynamics/model.ts:4', 'src/role-dynamics/model.ts:6', 'src/role-dynamics/agent.ts', 'src/order.ts'],
    condition: '启用动态角色存在可见字段或命中正文时使用required:true、interpolate:false的1010 context；静态、disabled、空投影及无Agent诊断为空。',
    dynamic_parts: '唯一projectModel投影按顺序给可见字段和值、可写规则／范围／选项及命中正文；隐藏定义、未命中条目、诊断、版本身份时间不进入。轮初冻结，多step／retry／refresh沿用，候选提交后下轮生效。',
    user_editable: '角色动态定义控制字段、规则、条件和正文；owner状态入口修改当前值并核对CAS。',
    cache_note: '可写轮不重复工具说明；没有更新工具时顶部只使用STATE_GUIDANCE首句。日常值和阶段在末尾context变化，稳定section不改；in-history可能追加context，实际供应商缓存率未测。',
    text: STATE_GUIDANCE, chars: STATE_GUIDANCE.length,
    rendering: "[无工具时首句, fields非空时'当前状态：\\n'+JSON.stringify(projection.fields), ...projection.texts].filter(Boolean).join('\\n\\n')",
  },
]
data.entries = [...preserved, ...entries]
assert.equal(JSON.stringify(data.entries.slice(0, preserved.length)), originalEntries)
data.meta.plugin_version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
data.meta.section_order = SECTION_ORDER
data.meta.context_order = CONTEXT_ORDER
data.meta.dynamics_supplement = {
  generated_at: new Date().toISOString(), generator: 'scripts/update-dynamics-inventory.mjs',
  note: '保留其余既有条目完整对象及原文；基础生成器之后补录已授权动态说明和实际呈现。',
}
writeFileSync(json, JSON.stringify(data, null, 2) + '\n')
let text = readFileSync(md, 'utf8').replace(/插件版本 [^，]+，/, `插件版本 ${data.meta.plugin_version}，`)
const marker = '<!-- role-dynamics-supplement -->'
if (text.includes(marker)) text = text.slice(0, text.indexOf(marker)).trimEnd() + '\n'
for (const id of ids) text = text.replace(new RegExp('^\\| \\d+ \\| `' + id + '`[^\\n]*\\n', 'gm'), '')
const rows = entries.map((entry, index) => `| ${preserved.length + index + 1} | \`${entry.id}\` | ${entry.name} | ${entry.kind} | ${entry.order?.value ?? '工具'} | ${entry.chars} |`).join('\n')
text = text.replace(/(\| \d+ \| `assembled-example`[^\n]*\n)/, `$1${rows}\n`)
text += `\n${marker}\n本节为0.40.0当前动态实现的补录；其余既有条目完整保留。补录时间：${data.meta.dynamics_supplement.generated_at}。基础清单生成后运行 \`scripts/update-dynamics-inventory.mjs\`。只更新清单，不修改任何内置指令。\n`
for (const [index, entry] of entries.entries()) {
  text += `\n## ${preserved.length + index + 1}. ${entry.name}（\`${entry.id}\`）\n\n- 来源：${entry.source.map(source => `\`${source}\``).join('，')}\n- 进入条件：${entry.condition}\n- 插值：${entry.dynamic_parts}\n- 用户可改：${entry.user_editable}\n- 缓存：${entry.cache_note}\n\n原文（${entry.chars} 字）：\n\n\`\`\`text\n${entry.text}\n\`\`\`\n`
  if (entry.parameters) text += `\n固定参数：\n\n\`\`\`json\n${JSON.stringify(entry.parameters, null, 2)}\n\`\`\`\n`
  if (entry.rendering) text += `\n呈现：\`${entry.rendering}\`\n`
}
writeFileSync(md, text)
console.log(JSON.stringify({ version: data.meta.plugin_version, preserved: preserved.length, added: entries.map(entry => entry.id), entries: data.entries.length }))
