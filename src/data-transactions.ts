/** 本插件多文件数据事务：原件备份先完成，manifest 最后提交；启动时撤销未提交单元。 */
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeJson } from './storage.ts'

interface SavedPath { path: string; existed: boolean; checksum?: string; expected?: string }
interface Manifest { version: 1; stamp: string; state: 'prepared' | 'committed' | 'rolled-back'; paths: SavedPath[]; metadata: unknown }
export type TransactionFault = (stage: 'prepared' | 'changed' | 'commit' | 'committed' | 'rollback') => void
export function inside(root: string, path: string): string {
  const absolute = resolve(path); const rel = relative(resolve(root), absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('事务路径超出本插件数据范围')
  for (let current = absolute; current !== resolve(root); current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('事务拒绝联接或符号链接')
  }
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('事务数据根目录是联接')
  return absolute
}
function checksum(path: string): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('事务备份拒绝符号链接')
  const hash = createHash('sha256')
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) hash.update(JSON.stringify([name, checksum(join(path, name))]))
  } else hash.update(readFileSync(path))
  return hash.digest('hex')
}
export class FileDataTransaction {
  readonly dir: string
  private constructor(private readonly root: string, domain: string, readonly manifest: Manifest, private readonly fault: TransactionFault) {
    this.dir = inside(root, join(root, domain, manifest.stamp))
  }
  static prepare(root: string, domain: string, paths: readonly string[], metadata: unknown, fault: TransactionFault = () => {}): FileDataTransaction {
    FileDataTransaction.recover(root, domain)
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    const entries = [...new Set(paths.map(path => relative(root, inside(root, path))))]
    if (entries.some(path => path === domain || path.startsWith(`${domain}${sep}`))) throw new Error('事务不能覆盖自己的备份目录')
    // Overlapping snapshots make restoration order ambiguous.
    if (entries.some(a => entries.some(b => a !== b && b.startsWith(`${a}${sep}`)))) throw new Error('事务路径重叠')
    const tx = new FileDataTransaction(root, domain, { version: 1, stamp, state: 'prepared', paths: [], metadata }, fault)
    mkdirSync(tx.dir, { recursive: true })
    entries.forEach((path, index) => {
      const from = inside(root, join(root, path)); const existed = existsSync(from)
      if (existed) {
        const sum = checksum(from)
        cpSync(from, join(tx.dir, `original-${index}`), { recursive: true, errorOnExist: true, force: false })
        if (sum !== checksum(join(tx.dir, `original-${index}`))) throw new Error('事务备份核对失败')
        tx.manifest.paths.push({ path, existed, checksum: sum })
      } else tx.manifest.paths.push({ path, existed })
    })
    tx.persist()
    try { fault('prepared') } catch (error) { tx.manifest.state = 'rolled-back'; tx.persist(); throw error }
    return tx
  }
  private persist() { writeJson(join(this.dir, 'manifest.json'), this.manifest) }
  /** ROLE.md 的唯一预期新字节，防止失败恢复覆盖等待期间的外部手写修改。 */
  expectFile(path: string, text: string, newDirectory = false) {
    const relativePath = relative(this.root, inside(this.root, newDirectory ? dirname(path) : path))
    const entry = this.manifest.paths.find(item => item.path === relativePath)
    if (!entry) throw new Error('事务文件未登记')
    const sum = createHash('sha256').update(text).digest('hex')
    entry.expected = newDirectory ? createHash('sha256').update(JSON.stringify(['ROLE.md', sum])).digest('hex') : sum
    this.persist()
  }
  changed() { this.fault('changed') }
  commit() { this.fault('commit'); this.manifest.state = 'committed'; this.persist(); this.fault('committed') }
  get committed() {
    return JSON.parse(readFileSync(join(this.dir, 'manifest.json'), 'utf8')).state === 'committed'
  }
  rollback() {
    if (this.committed) throw new Error('已提交事务不能自动撤销')
    this.fault('rollback')
    // Validate every backup before touching any original.
    this.manifest.paths.forEach((entry, index) => {
      inside(this.root, join(this.root, entry.path))
      if (entry.existed && checksum(join(this.dir, `original-${index}`)) !== entry.checksum) throw new Error('事务备份损坏，原件保留待恢复')
      const current = join(this.root, entry.path)
      if (entry.expected && existsSync(current)) {
        const sum = checksum(current)
        if (sum !== entry.checksum && sum !== entry.expected) throw new Error('角色文件在事务期间被外部修改，当前文件和备份均保留')
      }
    })
    this.manifest.paths.forEach((entry, index) => {
      const path = inside(this.root, join(this.root, entry.path))
      rmSync(path, { recursive: true, force: true })
      if (entry.existed) { mkdirSync(dirname(path), { recursive: true }); cpSync(join(this.dir, `original-${index}`), path, { recursive: true }) }
    })
    this.manifest.state = 'rolled-back'; this.persist()
  }
  static recover(root: string, domain: string): void {
    const directory = inside(root, join(root, domain))
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory)) {
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(name)) throw new Error('事务清单目录无效')
      const file = inside(root, join(directory, name, 'manifest.json'))
      // Incomplete backup preparation has not touched originals.
      if (!existsSync(file)) continue
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Manifest
      if (raw.version !== 1 || raw.stamp !== name || !['prepared', 'committed', 'rolled-back'].includes(raw.state) || !Array.isArray(raw.paths)) throw new Error('事务清单损坏，原件已保留')
      for (const entry of raw.paths) {
        if (typeof entry.path !== 'string' || isAbsolute(entry.path) || typeof entry.existed !== 'boolean') throw new Error('事务路径清单损坏')
        if (relative(root, inside(root, join(root, entry.path))) !== entry.path || entry.path === domain || entry.path.startsWith(`${domain}${sep}`)) throw new Error('事务路径清单损坏')
      }
      if (raw.state === 'prepared') new FileDataTransaction(root, domain, raw, () => {}).rollback()
    }
  }
}
