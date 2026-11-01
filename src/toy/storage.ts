/**
 * 数据目录和 JSON 读写。数据放在 `<DSH_HOME>/toy-buttplug/`。
 * 写法和 dsh-qqbot 的 storage.ts 相同：同步 I/O，先写临时文件再改名。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** DSH 的数据根目录。空的 DSH_HOME 视为未设置。 */
export function dshHome(): string {
  const configured = process.env['DSH_HOME']?.trim() ?? ''
  return configured === '' ? join(homedir(), '.dsh') : configured
}

export function dataDir(home = dshHome()): string {
  return join(home, 'toy-buttplug')
}

export type Warn = (message: string) => void

/** 读 JSON。不存在时返回 undefined；坏文件改名为 `.corrupt` 留给用户检查。 */
export function readJson(file: string, warn: Warn): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`toy-buttplug: 读不了 ${file}：${String(error)}`)
    return undefined
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    warn(`toy-buttplug: ${file} 不是有效的 JSON，已改名为 ${file}.corrupt`)
    try { renameSync(file, `${file}.corrupt`) } catch { /* 下次写入会覆盖它 */ }
    return undefined
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
    renameWithRetry(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Windows 上目标文件被短暂占用时 rename 会报 EPERM/EACCES/EBUSY，稍等重试。 */
function renameWithRetry(from: string, to: string): void {
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
