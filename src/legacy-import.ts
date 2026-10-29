/**
 * 首次启动时导入旧插件的用户数据，只复制，不删除也不修改旧文件（架构文档第 9 节）。
 *
 * - 角色库：`<DSH_HOME>/roles/`（dsh-persona-switcher 的默认位置）→ `<数据目录>/roles/`。整个条目复制，
 *   角色目录里的图片等文件一起带过来；目标已有同名条目时跳过。
 * - 不导入 `persona-switcher/sessions.json`：那里记录的是标准预设会话，会话开始后不能换预设
 *   （agent-preset-registry/src/index.ts:369），这些绑定在 qqbot 会话里用不上。
 *
 * 导入后写 `imported.json`，之后不再导入，用户在 qqbot 里删掉的角色不会被旧数据带回来。
 * 没有可导入的内容时不写任何文件。
 */

import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRole, roleEntries } from './roles.ts'
import { writeJson, type Warn } from './storage.ts'

export const IMPORT_MARKER = 'imported.json'

export interface ImportResult {
  readonly imported: readonly string[]
  readonly skipped: readonly string[]
}

/** 导入旧角色库；已经导入过时返回 undefined。 */
export function importLegacy(home: string, dir: string, warn: Warn): ImportResult | undefined {
  const marker = join(dir, IMPORT_MARKER)
  if (existsSync(marker)) return undefined
  const source = join(home, 'roles')
  const target = join(dir, 'roles')
  const imported: string[] = []
  const skipped: string[] = []
  for (const [entry, file, fallbackId] of roleEntries(source)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (parseRole(text, fallbackId) === undefined) continue
    if (existsSync(join(target, entry))) {
      skipped.push(entry)
      continue
    }
    try {
      cpSync(join(source, entry), join(target, entry), { recursive: true, force: false, errorOnExist: false })
      imported.push(entry)
    } catch (error) {
      warn(`qqbot: 导入旧角色 ${entry} 失败：${String(error)}`)
    }
  }
  if (imported.length === 0 && skipped.length === 0) return { imported, skipped }
  writeJson(marker, { version: 1, at: new Date().toISOString(), roles: { from: source, imported, skipped } })
  return { imported, skipped }
}
