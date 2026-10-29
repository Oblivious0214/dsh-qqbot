/**
 * dsh-qqbot 的数据目录和 JSON 读写。数据放在 `<DSH_HOME>/qqbot/`，不和旧插件共用文件。
 * 用同步 I/O：文件都很小，读只在启动和用户命令时发生；提示词组装是同步的，不能等异步加载。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** DSH 的数据根目录。空的 DSH_HOME 视为未设置，否则路径会相对于进程工作目录。 */
export function dshHome(): string {
  const configured = process.env['DSH_HOME']?.trim() ?? ''
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/** 本插件的数据目录：`<DSH_HOME>/qqbot`。 */
export function dataDir(home = dshHome()): string {
  return join(home, 'qqbot')
}

export type Warn = (message: string) => void

/**
 * 读一个 JSON 文件。不存在时返回 undefined；读不了或格式错时警告，
 * 坏文件改名为 `.corrupt` 留给用户检查，下次写入从空状态开始。
 */
export function readJson(file: string, warn: Warn): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`qqbot: 读不了 ${file}：${String(error)}`)
    return undefined
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    warn(`qqbot: ${file} 不是有效的 JSON，已改名为 ${file}.corrupt`)
    try { renameSync(file, `${file}.corrupt`) } catch { /* 改名失败时下次写入会覆盖它 */ }
    return undefined
  }
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** 写到同目录的临时文件再改名，读者不会看到写了一半的文件。 */
export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameWithRetry(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Windows 上目标文件被杀毒或编辑器短暂占用时 rename 会报 EPERM/EACCES/EBUSY，稍等重试几次。 */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
