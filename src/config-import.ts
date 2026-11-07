/** 配置包校验、预览和追加导入。只写本插件的预设与新角色，所有校验在写盘前完成。 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { QqbotData } from './content.ts'
import { type ConfigEntry, type ConfigOptions, type ConfigPreview, type ConfigResult } from './config-types.ts'
import { type JailbreakPreset, type PresetDraft } from './presets.ts'
import { parseRole, renderRole } from './roles.ts'
import { isRecord, writeJson, writeText } from './storage.ts'

import { digest } from './role-dynamics/history.ts'
import { reconcileConfigurationImport, recoverConfigurationFiles, type ImportManifest } from './config-import-recovery.ts'
import { parseConfigurationPackage, serializeRoleConfiguration, type PackageRole } from './config-package.ts'
interface Plan { readonly preview: ConfigPreview; readonly presets: readonly PresetDraft[]; readonly roles: readonly PackageRole[] }

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
  recoverConfigurationImports(data)
  const config = parseConfigurationPackage(value)
  const options = optionsOf(rawOptions)
  data.roles.reload()
  const baseline = data.presets.importBaseline()
  const entries: ConfigEntry[] = []
  const presetNames = new Set(data.presets.list().map(p => p.name))
  const roleNames = new Set(data.roles.list().map(r => r.name))
  const presets: PresetDraft[] = []
  const roles: PackageRole[] = []
  for (const preset of options.presets ? config.presets : []) {
    const skip = presetNames.has(preset.name) && options.conflict === 'skip'
    const target = presetNames.has(preset.name) && !skip ? copyName(preset.name, presetNames) : preset.name
    entries.push({ kind: 'preset', name: preset.name, target, status: skip ? 'skip' : 'add' })
    presetNames.add(target)
    if (!skip) presets.push({ ...preset, name: target })
  }
  for (const role of options.roles ? config.roles : []) {
    const skip = roleNames.has(role.name) && options.conflict === 'skip'
    const target = roleNames.has(role.name) && !skip ? copyName(role.name, roleNames) : role.name
    entries.push({ kind: 'role', name: role.name, target, status: skip ? 'skip' : 'add' })
    roleNames.add(target)
    if (skip) continue
    roles.push({ ...role, name: target })
  }
  // 同一预览对应同一资料库和选项。其他窗口修改后要求重新预览，避免导入与预览不一致。
  const revision = createHash('sha256').update(JSON.stringify({ config, options, entries,
    files: data.roles.contents(), presetState: baseline.state, presetDisk: baseline.disk, presets: data.presets.list(), roles: data.roles.list(),
    currentPreset: data.presets.currentId,
  })).digest('hex')
  return { preview: { entries, revision }, presets, roles }
}

export function previewConfiguration(data: QqbotData, value: unknown, options: unknown): ConfigPreview {
  return planImport(data, value, options).preview
}

export function importConfiguration(data: QqbotData, value: unknown, options: unknown, revision: unknown, fault: (stage: 'roles' | 'presets' | 'committed') => void = () => {}): ConfigResult {
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
  const roleIds = new Set(data.roles.list().map(r => r.id))
  const roles = plan.roles.map(role => {
    const id = newId('r', roleIds, id => !existsSync(join(data.roles.dir, id)) && !existsSync(join(data.roles.dir, `${id}.md`)))
    const text = renderRole({ ...role, id }, undefined)
    // 和实际文件解析器往返，拒绝不能完整保留的内容。
    const parsed = parseRole(text, id)
    if (!parsed || digest(serializeRoleConfiguration(parsed)) !== digest(serializeRoleConfiguration(role))) throw new TypeError(`角色“${role.name}”的内容无法完整保存`)
    return { ...role, id, text }
  })
  const dir = dirname(data.roles.dir)
  const backup = join(dir, 'import-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  mkdirSync(backup, { recursive: true })
  const presetFile = join(dir, 'presets.json')
  // 保留原文件的字节，首次导入时用清单记下原文件不存在；备份失败则不写任何配置。
  const original = existsSync(presetFile) ? readFileSync(presetFile) : undefined
  if (original !== undefined) {
    writeFileSync(join(backup, 'presets.json'), original)
  }
  const before = data.presets.importBaseline().state
  const after = { ...before, presets: [...before.presets, ...presets] }
  const manifest: ImportManifest = { version: 2, state: 'prepared', presetsExisted: original !== undefined,
    before, after, addedRoles: roles.map(role => role.id), roleFiles: roles.map(role => ({ id: role.id, path: relative(dir, join(data.roles.dir, role.id)), textDigest: digest(role.text), configRevision: digest(role.dynamics ?? null) })), addedPresets: presets.map(p => p.id) }
  writeJson(join(backup, 'manifest.json'), manifest)
  const commitRevision = data.presets.commitRevision
  try {
    mkdirSync(data.roles.dir, { recursive: true })
    for (const role of roles) {
      const folder = join(data.roles.dir, role.id)
      mkdirSync(folder) // 不接管已有目录。
      writeText(join(folder, 'ROLE.md'), role.text)
    }
    // 最后一步原子写入。失败时存储内存仍保持旧状态，下面撤销本次新建的角色文件。
    fault('roles')
    data.presets.importBaseline()
    data.presets.appendImported(presets)
    manifest.commitReceipt = true; writeJson(join(backup, 'manifest.json'), manifest)
    fault('presets')
    if (!reconcileConfigurationImport(data.roles.dir, manifest, join(backup, 'manifest.json'))) throw new Error('配置导入未提交')
    fault('committed')
  } catch (error) {
    try {
      // Preserve prepared on any third state, including a changed/missing member of after.
      if (data.presets.commitRevision !== commitRevision) manifest.commitReceipt = true
      manifest.state = 'prepared'; writeJson(join(backup, 'manifest.json'), manifest)
      if (reconcileConfigurationImport(data.roles.dir, manifest, join(backup, 'manifest.json'))) {
        data.presets.reload(); data.roles.reload(); return result
      }
      data.roles.reload()
    } catch (recovery) {
      throw new Error('导入未完成，资料已变化，原件和恢复清单已保留；请检查配置导入备份', { cause: new AggregateError([error, recovery]) })
    }
    throw error
  }
  data.roles.reload()
  return result
}

/** 数据对象已构造时同时刷新内存；构造前的角色库使用同一恢复函数。 */
export function recoverConfigurationImports(data: QqbotData): void {
  if (recoverConfigurationFiles(data.roles.dir)) { data.presets.reload(); data.roles.reload() }
}
