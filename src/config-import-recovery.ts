/** 角色库加载前恢复配置导入；只读取末步原子预设提交和新增角色清单。 */
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { digest } from './role-dynamics/history.ts'
import { inside } from './data-transactions.ts'
import { writeJson } from './storage.ts'
export interface ImportManifest {
  version: 2; state: 'prepared' | 'committed' | 'rolled-back'; presetsExisted: boolean
  commitReceipt?: boolean
  before: unknown; after: unknown
  addedRoles: string[]; roleFiles: { id: string; path: string; textDigest: string; configRevision: string }[]; addedPresets: string[]
}
export function presetStateMatches(root: string, expected: unknown): boolean {
  const file = join(root, 'presets.json')
  if (!existsSync(file)) return false
  return digest(JSON.parse(readFileSync(file, 'utf8'))) === digest(expected)
}
/** Immediate failure and startup recovery use the same whole-unit ownership check. */
export function reconcileConfigurationImport(rolesDir: string, manifest: ImportManifest, file: string): boolean {
  const root = dirname(rolesDir)
  const sameState = digest(manifest.before) === digest(manifest.after)
  // Creating the initially absent file proves the atomic append even when no presets were added.
  const committed = presetStateMatches(root, manifest.after) && (!manifest.presetsExisted || !sameState || manifest.commitReceipt === true)
  const before = manifest.presetsExisted ? presetStateMatches(root, manifest.before) : !existsSync(join(root, 'presets.json'))
  if (!committed && !before) throw new Error('配置导入中断且预设已变化，请检查备份后恢复')
  // Check the entire unit before deleting any newly created directory or confirming after.
  for (const role of manifest.roleFiles) {
    if (!/^r-[0-9a-f]{8}$/.test(role.id) || role.path !== relative(root, join(rolesDir, role.id))) throw new Error('配置导入角色路径无效')
    const folder = inside(root, join(root, role.path)); const roleFile = inside(root, join(folder, 'ROLE.md'))
    if (committed && !existsSync(roleFile)) throw new Error('配置导入提交单元缺少角色文件')
    if (existsSync(folder)) {
      if (readdirSync(folder).some(name => name !== 'ROLE.md') || (existsSync(roleFile) && digest(readFileSync(roleFile, 'utf8')) !== role.textDigest)) throw new Error('配置导入新增目录已变化，原件保留待恢复')
    }
  }
  if (!committed) for (const role of manifest.roleFiles) {
    const folder = inside(root, join(root, role.path)); const roleFile = join(folder, 'ROLE.md')
    if (existsSync(roleFile)) unlinkSync(roleFile)
    if (existsSync(folder)) rmdirSync(folder)
  }
  manifest.state = committed ? 'committed' : 'rolled-back'; writeJson(file, manifest)
  return committed
}
/** 首次库读取／预览时恢复中断导入，不触及既有角色、绑定、默认、记忆。 */
export function recoverConfigurationFiles(rolesDir: string): boolean {
  let changed = false
  const root = dirname(rolesDir); const directory = inside(root, join(root, 'import-backups'))
  if (!existsSync(directory)) return false
  for (const entry of readdirSync(directory)) {
    const file = inside(root, join(directory, entry, 'manifest.json'))
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as ImportManifest | { version: 1 }
    if (manifest.version === 1) continue // historical completed backups predate recovery manifests
    if (manifest.version !== 2 || !['prepared', 'committed', 'rolled-back'].includes(manifest.state) || !Array.isArray(manifest.addedRoles) || !Array.isArray(manifest.roleFiles)) throw new Error('配置导入恢复清单损坏，原件已保留')
    if (manifest.state !== 'prepared') continue
    reconcileConfigurationImport(rolesDir, manifest, file)
    changed = true
  }
  return changed
}
