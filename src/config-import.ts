/** 配置包校验、预览和追加导入。只写本插件的预设与新角色，所有校验在写盘前完成。 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QqbotData } from './content.ts'
import { CONFIG_MAX_BYTES, type ConfigEntry, type ConfigOptions, type ConfigPreview, type ConfigResult } from './config-types.ts'
import { validatePreset, type JailbreakPreset, type PresetDraft } from './presets.ts'
import { parseRole, renderRole, validateRoleDraft, type RoleDraft } from './roles.ts'
import { isRecord, writeJson, writeText } from './storage.ts'

interface PackageRole extends RoleDraft { readonly preset?: string }
interface ConfigPackage { readonly presets: readonly PresetDraft[]; readonly roles: readonly PackageRole[] }
interface Plan { readonly preview: ConfigPreview; readonly presets: readonly PresetDraft[]; readonly roles: readonly PackageRole[] }

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${label}含有不支持的字段，请使用 QQ Bot 配置包格式`)
}

function parsePackage(value: unknown): ConfigPackage {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > CONFIG_MAX_BYTES) throw new TypeError('配置文件不能超过 2 MB')
  if (!isRecord(value) || value['format'] !== 'dsh-qqbot-config' || value['version'] !== 1) {
    throw new TypeError('不是支持的 QQ Bot 配置包，请使用格式为 dsh-qqbot-config、版本为 1 的 JSON 文件')
  }
  keys(value, ['format', 'version', 'presets', 'roles'], '配置包')
  const items = (key: string): unknown[] => {
    const list = value[key] ?? []
    if (!Array.isArray(list) || list.length > 100) throw new TypeError('每个配置包最多包含 100 个角色和 100 份预设')
    return list
  }
  const presets = items('presets').map(item => {
    if (!isRecord(item)) throw new TypeError('预设格式无效')
    keys(item, ['name', 'head', 'mid', 'tail'], '预设')
    const draft = validatePreset({ ...item, mid: item['mid'] ?? '', tail: item['tail'] ?? '' }, true)
    if (/[\u0000-\u001f\u007f]/.test(draft.name)) throw new TypeError('预设名称不能包含换行或控制字符')
    return draft
  })
  const roles = items('roles').map(item => {
    if (!isRecord(item)) throw new TypeError('角色格式无效')
    keys(item, ['name', 'description', 'persona', 'preset', 'memeFrequency', 'memeTags', 'memePrompt',
      'proactivity', 'proactivityTexts', 'motionActions', 'motionRanges'], '角色')
    const role = validateRoleDraft({ ...item, description: item['description'] ?? '',
      persona: typeof item['persona'] === 'string' ? item['persona'].replace(/\r\n/g, '\n') : item['persona'] })
    if (/[\u0000-\u001f\u007f]/.test(role.name)) throw new TypeError('角色名称不能包含控制字符')
    const preset = item['preset']
    if (preset !== undefined && (typeof preset !== 'string' || preset.trim() === '')) throw new TypeError('角色的破限预设必须填写名称')
    return { ...role, ...preset === undefined ? {} : { preset: (preset as string).trim() } }
  })
  for (const [label, list] of [['预设', presets], ['角色', roles]] as const) {
    if (new Set(list.map(item => item.name)).size !== list.length) throw new TypeError(`配置包里有重名${label}，请先修改名称`)
  }
  if (presets.length + roles.length === 0) throw new TypeError('配置包里没有可导入的角色或预设')
  return { presets, roles }
}

function optionsOf(value: unknown): ConfigOptions {
  if (!isRecord(value) || typeof value['presets'] !== 'boolean' || typeof value['roles'] !== 'boolean'
    || !['skip', 'copy'].includes(String(value['conflict']))) throw new TypeError('请选择要导入的内容和重名处理方式')
  return value as unknown as ConfigOptions
}

function copyName(name: string, names: Set<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '（导入）' : `（导入 ${n}）`
    const candidate = name.slice(0, 64 - suffix.length).trimEnd() + suffix
    if (!names.has(candidate)) return candidate
  }
}

function planImport(data: QqbotData, value: unknown, rawOptions: unknown): Plan {
  const config = parsePackage(value)
  const options = optionsOf(rawOptions)
  data.roles.reload()
  const entries: ConfigEntry[] = []
  const presetNames = new Set(data.presets.list().map(p => p.name))
  const roleNames = new Set(data.roles.list().map(r => r.name))
  const mapping = new Map<string, string>()
  const presets: PresetDraft[] = []
  const roles: PackageRole[] = []
  for (const preset of options.presets ? config.presets : []) {
    const skip = presetNames.has(preset.name) && options.conflict === 'skip'
    const target = presetNames.has(preset.name) && !skip ? copyName(preset.name, presetNames) : preset.name
    entries.push({ kind: 'preset', name: preset.name, target, status: skip ? 'skip' : 'add' })
    presetNames.add(target)
    mapping.set(preset.name, target)
    if (!skip) presets.push({ ...preset, name: target })
  }
  for (const role of options.roles ? config.roles : []) {
    const skip = roleNames.has(role.name) && options.conflict === 'skip'
    const target = roleNames.has(role.name) && !skip ? copyName(role.name, roleNames) : role.name
    entries.push({ kind: 'role', name: role.name, target, status: skip ? 'skip' : 'add' })
    roleNames.add(target)
    if (skip) continue
    const preset = role.preset === undefined ? undefined : mapping.get(role.preset) ?? role.preset
    if (preset !== undefined && !presetNames.has(preset)) throw new TypeError(`角色“${role.name}”需要预设“${role.preset}”，请同时导入这份预设`)
    roles.push({ ...role, name: target, ...preset === undefined ? {} : { preset } })
  }
  // 同一预览对应同一资料库和选项。其他窗口修改后要求重新预览，避免导入与预览不一致。
  const revision = createHash('sha256').update(JSON.stringify({ config, options, entries,
    presets: data.presets.list(), roles: data.roles.list().map(role => ({ ...role, preset: data.presets.roleChoice(role.id) })),
    defaultPreset: data.presets.defaultId,
  })).digest('hex')
  return { preview: { entries, revision }, presets, roles }
}

export function previewConfiguration(data: QqbotData, value: unknown, options: unknown): ConfigPreview {
  return planImport(data, value, options).preview
}

export function importConfiguration(data: QqbotData, value: unknown, options: unknown, revision: unknown): ConfigResult {
  const plan = planImport(data, value, options)
  if (revision !== plan.preview.revision) throw new Error('资料库或导入选项已变化，请重新预览后导入')
  const result = { presets: plan.presets.length, roles: plan.roles.length, skipped: plan.preview.entries.filter(e => e.status === 'skip').length }
  if (result.presets + result.roles === 0) return result
  const presetIds = new Set(data.presets.list().map(p => p.id))
  const newId = (prefix: string, taken: Set<string>, available: (id: string) => boolean = () => true): string => {
    for (;;) {
      const id = `${prefix}-${randomBytes(4).toString('hex')}`
      if (!taken.has(id) && available(id)) { taken.add(id); return id }
    }
  }
  const presets: JailbreakPreset[] = plan.presets.map(p => ({ ...p, id: newId('p', presetIds) }))
  const presetByName = new Map([...data.presets.list(), ...presets].map(p => [p.name, p.id]))
  const roleIds = new Set(data.roles.list().map(r => r.id))
  const roles = plan.roles.map(role => {
    const id = newId('r', roleIds, id => !existsSync(join(data.roles.dir, id)) && !existsSync(join(data.roles.dir, `${id}.md`)))
    const text = renderRole({ ...role, id }, undefined)
    // 和实际文件解析器往返，拒绝不能完整保留的内容。
    const parsed = parseRole(text, id)
    if (parsed?.name !== role.name || parsed.persona !== role.persona) throw new TypeError(`角色“${role.name}”的内容无法完整保存`)
    return { ...role, id, text }
  })
  const assignments = Object.fromEntries(roles.map(role => [role.id, role.preset === undefined ? data.presets.defaultId : presetByName.get(role.preset)!]))
  const dir = dirname(data.roles.dir)
  const backup = join(dir, 'import-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  mkdirSync(backup, { recursive: true })
  const presetFile = join(dir, 'presets.json')
  // 保留原文件的字节，首次导入时用清单记下原文件不存在；备份失败则不写任何配置。
  const original = existsSync(presetFile) ? readFileSync(presetFile) : undefined
  if (original !== undefined) {
    writeFileSync(join(backup, 'presets.json'), original)
  }
  writeJson(join(backup, 'manifest.json'), { version: 1, presetsExisted: original !== undefined, addedRoles: roles.map(r => r.id), addedPresets: presets.map(p => p.id) })
  const created: string[] = []
  try {
    mkdirSync(data.roles.dir, { recursive: true })
    for (const role of roles) {
      const folder = join(data.roles.dir, role.id)
      mkdirSync(folder) // 不接管已有目录。
      created.push(folder)
      writeText(join(folder, 'ROLE.md'), role.text)
    }
    // 最后一步原子写入。失败时存储内存仍保持旧状态，下面撤销本次新建的角色文件。
    data.presets.appendImported(presets, assignments)
  } catch (error) {
    const failures: unknown[] = []
    for (const folder of created.reverse()) {
      try { const file = join(folder, 'ROLE.md'); if (existsSync(file)) unlinkSync(file); rmdirSync(folder) } catch (failure) { failures.push(failure) }
    }
    data.roles.reload()
    if (failures.length) throw new Error('导入未完成，部分新增角色未能撤销；请检查配置导入备份', { cause: error })
    throw error
  }
  data.roles.reload()
  return result
}
