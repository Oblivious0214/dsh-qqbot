/** 仅在没有角色库、预设或会话资料时初始化内置配置；删除过的角色不补回。 */
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { SessionBindings } from './bindings.ts'
import { DEFAULT_ROLE_NAME, DEFAULT_ROLE_PERSONA } from './default-content.ts'
import { JailbreakStore } from './presets.ts'
import { RoleLibrary } from './roles.ts'
import type { Warn } from './storage.ts'

export function initializeDefaultConfiguration(dir: string, warn: Warn): boolean {
  // 空角色目录也视为用户已有资料；损坏文件的备份不能被当成首次使用。
  if (existsSync(dir) && readdirSync(dir).some(name =>
    /^(roles|roles-trash)$/.test(name) || /^(presets|sessions)\.json(?:\.|$)/.test(name))) return false

  mkdirSync(dir, { recursive: true })
  const staging = mkdtempSync(join(dir, '.initial-defaults-'))
  const files: string[] = []
  const folders: string[] = []
  try {
    const roles = new RoleLibrary(join(staging, 'roles'), warn)
    const role = roles.save({ name: DEFAULT_ROLE_NAME, description: '', persona: DEFAULT_ROLE_PERSONA }, true)
    const presets = JailbreakStore.at(staging, warn)
    presets.setCurrent(presets.currentId)
    SessionBindings.at(staging, warn).setDefaultRole(role.id)
    mkdirSync(join(staging, 'images', 'avatars'), { recursive: true })
    const avatar = join('images', 'avatars', `${role.id}.png`)
    copyFileSync(new URL('../assets/default-avatar.png', import.meta.url), join(staging, avatar))

    // 独占创建目标；并发出现的用户文件也不能被覆盖。失败只撤销本次成功创建的条目。
    for (const folder of [join(dir, 'roles'), join(dir, 'roles', role.id), join(dir, 'images'), join(dir, 'images', 'avatars')]) {
      // 图片目录可能已由独立的界面设置创建；只复用这些目录。
      if (folder.startsWith(join(dir, 'images')) && existsSync(folder)) continue
      mkdirSync(folder)
      folders.push(folder)
    }
    for (const relative of [join('roles', role.id, 'ROLE.md'), 'presets.json', 'sessions.json', avatar]) {
      const target = join(dir, relative)
      copyFileSync(join(staging, relative), target, constants.COPYFILE_EXCL)
      files.push(target)
    }
    return true
  } catch (error) {
    for (const file of files.reverse()) {
      try { unlinkSync(file) } catch (failure) { warn(`qqbot: 初始化撤销失败 ${file}：${String(failure)}`) }
    }
    for (const folder of folders.reverse()) {
      try { rmdirSync(folder) } catch (failure) { warn(`qqbot: 初始化撤销失败 ${folder}：${String(failure)}`) }
    }
    throw error
  } finally {
    if (dirname(resolve(staging)) !== resolve(dir) || !basename(staging).startsWith('.initial-defaults-')) {
      throw new Error('内置配置临时目录超出范围')
    }
    rmSync(staging, { recursive: true, force: true })
  }
}
