import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { canonical, digest } from './history.ts'
import { fail } from './types.ts'

/** Synchronous final commit is intentional: maintenance cannot interleave with rename. */
export interface JournalStore {
  load(roleId: string): unknown | undefined
  save(roleId: string, journal: unknown, guard: () => void): void
  detach(roleId: string, stamp: string, guard: () => void): void
  restore(roleId: string, stamp: string, guard: () => void): void
}
export type StoreStage = 'temporary' | 'rename' | 'directory-sync'
export class FileJournalStore implements JournalStore {
  private readonly root: string
  constructor(root: string, private readonly fault: (stage: StoreStage) => void = () => {}) { this.root = resolve(root) }
  private check(path: string) {
    let current = resolve(path)
    while (current !== parse(current).root) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('$.storage', '拒绝联接或符号链接', 'storage')
      current = dirname(current)
    }
  }
  private directory(roleId: string) { return join(this.root, 'roles', createHash('sha256').update(roleId).digest('hex')) }
  private file(roleId: string) { return join(this.directory(roleId), 'journal.json') }
  load(roleId: string): unknown | undefined {
    const file = this.file(roleId); this.check(file)
    if (!existsSync(file)) return undefined
    try {
      const envelope = JSON.parse(readFileSync(file, 'utf8')) as { version: number; checksum: string; journal: unknown }
      if (envelope.version !== 1 || envelope.checksum !== digest(envelope.journal)) throw new Error('checksum')
      return envelope.journal
    } catch { return fail('$.storage', '进度日志损坏，原件已保留', 'corrupt') }
  }
  save(roleId: string, journal: unknown, guard: () => void): void {
    const file = this.file(roleId); this.check(file); guard()
    mkdirSync(dirname(file), { recursive: true })
    const temporary = join(dirname(file), `${randomUUID()}.tmp`)
    try {
      this.fault('temporary'); guard()
      const fd = openSync(temporary, 'wx')
      try { writeFileSync(fd, canonical({ version: 1, checksum: digest(journal), journal }), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
      this.fault('rename'); guard(); this.check(file)
      renameSync(temporary, file)
      // A post-rename failure is an uncertain acknowledgement, never an excuse to roll back.
      this.fault('directory-sync')
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
  detach(roleId: string, stamp: string, guard: () => void): void {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(stamp)) fail('$.stamp', '非法回收标识')
    const from = this.directory(roleId); const to = join(this.root, 'trash', `${digest(roleId)}-${stamp}`)
    this.check(from); this.check(to); guard()
    if (!existsSync(from)) return
    if (existsSync(to)) fail('$.storage', '回收目标已存在')
    mkdirSync(dirname(to), { recursive: true }); renameSync(from, to)
  }
  restore(roleId: string, stamp: string, guard: () => void): void {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(stamp)) fail('$.stamp', '非法回收标识')
    const to = this.directory(roleId); const from = join(this.root, 'trash', `${digest(roleId)}-${stamp}`)
    this.check(from); this.check(to); guard()
    if (existsSync(to)) fail('$.storage', '已有角色进度，不可覆盖')
    mkdirSync(dirname(to), { recursive: true }); renameSync(from, to)
  }
}
