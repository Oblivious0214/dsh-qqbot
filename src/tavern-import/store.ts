/** 原子预设提交 + 可恢复多文件事务。只新增；恢复绝不全量还原旧 presets。 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { JailbreakStore, validatePreset, type JailbreakPreset } from '../presets.ts'
import { RoleLibrary, parseRole, renderRole, validateRoleDraft } from '../roles.ts'
import { isRecord, writeJson } from '../storage.ts'
import { extract } from './extract.ts'
import { validateAvatar } from './png.ts'
import { selectedExcerpts, validateBody } from './static.ts'
import { LIMITS, type Extraction, type ImportPayload, type Preview, type SavedImport } from './types.ts'
import { canonical, fail, hash, ImportError, json, jsonBytes } from './util.ts'
export interface ImportData { roles: RoleLibrary; presets: JailbreakStore }
interface PresetState { version: 2; current: string; presets: readonly JailbreakPreset[] }
interface PlannedFile { path: string; sha256: string }
interface Manifest {
  format: 'qqbot-tavern-transaction'; version: 1; stage: 'prepared' | 'complete' | 'rolled-back'; tokenHash: string; payloadHash: string
  oldPresetHash: string | null; newPresetHash: string; presetsExisted: boolean; files: PlannedFile[]; roleId?: string
  presetCommitted?: boolean
  presets: JailbreakPreset[]; assignments?: Record<string, string>; result: SavedImport
}
/** 仅供故障注入；生产调用不需要传。异常模拟崩溃时不运行回滚。 */
export class InterruptedImport extends Error {}
export interface StoreOptions { checkpoint?: (point: string) => void; warn?: (message: string) => void }
export class TavernImportStore {
  private readonly secret = randomBytes(32)
  private readonly root: string
  private readonly backups: string
  private disposed = false
  constructor(private readonly data: ImportData, private readonly options: StoreOptions = {}) {
    this.root = resolve(dirname(data.roles.dir)); this.backups = join(this.root, 'import-backups')
    if (resolve(data.roles.dir) !== join(this.root, 'roles')) throw new Error('角色目录不符合导入存储布局')
  }
  dispose(): void { this.disposed = true }
  /** 清理全部数据／插件停用后旧 token 失效；创建新的 store 代次。 */
  private available(): void { if (this.disposed) fail('stale-preview', '导入已失效，请重新打开') }
  private checkpoint(point: string): void { this.options.checkpoint?.(point) }
  private diskPreset(): Buffer | undefined { const file = this.path('presets.json'); return existsSync(file) ? readFileSync(file) : undefined }
  private state(): PresetState {
    try { return this.data.presets.importBaseline().state }
    catch (error) { return fail('stale-preview', `磁盘预设已变化，请重新预览：${String(error)}`) }
  }

  /** 每一级拒绝联接，所有目标都是内部生成的相对路径。 */
  private path(rel: string): string {
    const target = resolve(this.root, rel)
    if (target !== this.root && !target.startsWith(this.root + sep)) return fail('storage-failed', '导入路径超出数据目录')
    let cursor = this.root
    for (let ancestor = cursor; ; ancestor = dirname(ancestor)) {
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) return fail('storage-failed', '导入数据目录是联接')
      if (dirname(ancestor) === ancestor) break
    }
    for (const part of relative(this.root, target).split(sep).filter(Boolean)) {
      cursor = join(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) return fail('storage-failed', '导入路径包含联接')
    }
    return target
  }
  private revision(): string {
    const files: [string, string][] = []
    const visit = (rel: string): void => {
      const dir = this.path(rel)
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir).sort()) {
        const child = join(rel, name), full = this.path(child), stat = lstatSync(full)
        if (stat.isDirectory()) visit(child)
        else if (stat.isFile()) files.push([child, hash(readFileSync(full))])
        else fail('storage-failed', '资料库路径不是普通文件')
      }
    }
    visit('roles'); visit(join('images', 'avatars'))
    this.data.roles.reload(); const state = this.state()
    return hash(canonical({ state, files, disk: this.diskPreset() === undefined ? null : hash(this.diskPreset()!) }))
  }
  private prepare(payload: ImportPayload): { extraction: Extraction; name: string; body: string; payloadHash: string; avatar?: Buffer; count: number } {
    const extraction = extract(payload), chosen = selectedExcerpts(extraction, payload.selections), body = validateBody(payload.body, payload.kind)
    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 64 || /[\u0000-\u001f\u007f]/.test(payload.name)) return fail('malformed', '名称不能为空，最多 64 个字符，不能含控制字符')
    if (payload.conflict !== undefined && payload.conflict !== 'error' && payload.conflict !== 'copy') return fail('malformed', '重名处理无效')
    let name = payload.name.trim()
    const names = new Set(payload.kind === 'role' ? this.data.roles.list().map(r => r.name) : this.data.presets.list().map(p => p.name))
    if (names.has(name)) {
      let suggestion = ''
      for (let i = 1; ; i++) { const suffix = i === 1 ? '（导入）' : `（导入 ${i}）`; suggestion = name.slice(0, 64 - suffix.length).trimEnd() + suffix; if (!names.has(suggestion)) break }
      if (payload.conflict !== 'copy') throw new ImportError('conflict', '已有同名内容，请修改名称或另存', { suggestedName: suggestion })
      name = suggestion
    }
    const avatar = payload.avatarBase64 === undefined ? undefined : validateAvatar(payload.avatarBase64)
    if (avatar && payload.kind !== 'role') return fail('malformed', '预设不保存头像')
    return { extraction, name, body, payloadHash: hash(canonical(payload)), count: chosen.length, ...avatar ? { avatar } : {} }
  }
  private signature(preview: Omit<Preview, 'commitToken'>, nonce: string): string { return createHmac('sha256', this.secret).update(canonical(preview) + nonce).digest('hex') }
  preview(payload: ImportPayload): Preview {
    this.available(); this.recover(); const libraryRevision = this.revision(), plan = this.prepare(payload), nonce = randomUUID()
    const fields = { name: plan.name, kind: payload.kind, count: plan.count, currentPreset: this.data.presets.currentId, libraryRevision, payloadHash: plan.payloadHash }
    return { ...fields, commitToken: `${nonce}.${this.signature(fields, nonce)}` }
  }
  commit(payload: ImportPayload, preview: Preview): SavedImport {
    this.available()
    if (!isRecord(preview) || typeof preview.commitToken !== 'string' || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(preview.commitToken)) return fail('stale-preview', '预览无效，请重新预览')
    const payloadHash = hash(canonical(payload)), tokenHash = hash(preview.commitToken)
    this.recover()
    const prior = this.transactions().find(({ manifest }) => manifest.tokenHash === tokenHash)
    if (prior) {
      if (prior.manifest.payloadHash !== payloadHash) return fail('conflict', '同一提交凭证不能使用不同内容')
      if (prior.manifest.stage === 'complete') return prior.manifest.result
      return fail('stale-preview', '上次导入已撤销，请重新预览')
    }
    const { commitToken: _, ...fields } = preview, [nonce, signature] = preview.commitToken.split('.')
    const expected = this.signature(fields, nonce!)
    if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return fail('stale-preview', '预览已失效，请重新预览')
    const revision = this.revision(), plan = this.prepare(payload)
    if (payloadHash !== preview.payloadHash || revision !== preview.libraryRevision || plan.name !== preview.name || this.data.presets.currentId !== preview.currentPreset) return fail('stale-preview', '资料或资料库已变化，请重新预览')
    const old = this.diskPreset(), state = this.state(), id = this.newId(payload.kind === 'role' ? 'r' : 'p')
    const archive = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`, relArchive = join('import-backups', archive)
    const folder = this.path(relArchive)
    const result: SavedImport = { kind: payload.kind, id, name: plan.name, archive }
    const presets: JailbreakPreset[] = payload.kind === 'preset' ? [validatePreset({ id, name: plan.name, head: plan.body, mid: '', tail: '' })] : []
    const staged: { path: string; bytes: Buffer }[] = []
    if (payload.kind === 'role') {
      const draft = validateRoleDraft({ id, name: plan.name, description: '', persona: plan.body }), rendered = renderRole({ ...draft, id }, undefined), parsed = parseRole(rendered, id)
      if (parsed?.persona !== draft.persona || parsed.name !== draft.name || parsed.id !== id) return fail('malformed', '角色内容无法完整保存，请修改名称或正文')
      staged.push({ path: join('roles', id, 'ROLE.md'), bytes: Buffer.from(rendered) })
      if (plan.avatar) staged.push({ path: join('images', 'avatars', `${id}.png`), bytes: plan.avatar })
    }
    const next: PresetState = { version: 2, current: state.current, presets: [...state.presets, ...presets] }
    const manifest: Manifest = { format: 'qqbot-tavern-transaction', version: 1, stage: 'prepared', tokenHash, payloadHash,
      oldPresetHash: old === undefined ? null : hash(old), newPresetHash: hash(JSON.stringify(next, undefined, 2) + '\n'), presetsExisted: old !== undefined,
      files: staged.map(f => ({ path: f.path, sha256: hash(f.bytes) })), ...payload.kind === 'role' ? { roleId: id } : {}, presets, result }
    const archiveBytes = [plan.extraction, payload.selections, { version: 1, kind: payload.kind, body: plan.body, metadata: payload.resultMetadata ?? {} }, manifest]
      .reduce((sum, value) => sum + jsonBytes(value, true, LIMITS.archive) + 1, 0)
      + plan.extraction.sources.reduce((sum, s) => sum + Buffer.from(s.originalBase64, 'base64').length, 0)
      + (old?.length ?? 0) + staged.reduce((sum, f) => sum + f.bytes.length, 0)
    if (archiveBytes > LIMITS.archive) return fail('too-large', '导入档案超过 128 MiB，请减少资料或摘录后重试')
    // 先完整归档和 staging，再写 prepared；此前中断只留下不参与恢复的来源目录。
    mkdirSync(this.backups, { recursive: true }); mkdirSync(folder)
    if (old) writeFileSync(join(folder, 'presets.before.json'), old, { flag: 'wx' })
    mkdirSync(join(folder, 'sources')); mkdirSync(join(folder, 'staging'))
    for (const [i, source] of plan.extraction.sources.entries()) writeFileSync(join(folder, 'sources', `${i}.bin`), Buffer.from(source.originalBase64, 'base64'), { flag: 'wx' })
    writeJson(join(folder, 'materials.json'), plan.extraction)
    writeJson(join(folder, 'selection.json'), payload.selections)
    writeJson(join(folder, 'result.json'), { version: 1, kind: payload.kind, body: plan.body, metadata: payload.resultMetadata ?? {} })
    for (const [i, file] of staged.entries()) writeFileSync(join(folder, 'staging', `${i}.bin`), file.bytes, { flag: 'wx' })
    writeJson(join(folder, 'manifest.json'), manifest)
    this.checkpoint('prepared')
    let committed = false
    const commitRevision = this.data.presets.commitRevision
    try {
      if (manifest.roleId) { mkdirSync(this.path('roles'), { recursive: true }); mkdirSync(this.path(join('roles', manifest.roleId))); this.checkpoint('role-directory') }
      for (const [i, file] of staged.entries()) {
        const target = this.path(file.path); mkdirSync(dirname(target), { recursive: true })
        if (existsSync(target)) return fail('conflict', '新增目标路径已被占用')
        renameSync(join(folder, 'staging', `${i}.bin`), target); this.checkpoint(`moved-${i}`)
      }
      this.checkpoint('before-append')
      this.data.presets.appendImported(presets)
      manifest.presetCommitted = true; writeJson(join(folder, 'manifest.json'), manifest)
      committed = true
      this.checkpoint('after-append')
      manifest.stage = 'complete'; writeJson(join(folder, 'manifest.json'), manifest)
    } catch (error) {
      if (error instanceof InterruptedImport) throw error
      // 原子写盘已经成功、内存更新或后续通知抛错时，仍以磁盘提交点为准。
      if (!committed && manifest.newPresetHash !== manifest.oldPresetHash && (this.data.presets.commitRevision !== commitRevision || (this.diskPreset() !== undefined && hash(this.diskPreset()!) === manifest.newPresetHash))) {
        committed = true; this.data.presets.reload()
      }
      if (committed) this.options.warn?.('导入已提交，完成标记待下次恢复')
      else {
        try { this.rollback(manifest); manifest.stage = 'rolled-back'; writeJson(join(folder, 'manifest.json'), manifest) }
        catch (rollbackError) { throw new ImportError('storage-failed', '导入失败且撤销未完成，已保留恢复档案', { error: String(error), rollbackError: String(rollbackError) }) }
        throw new ImportError('storage-failed', '导入未完成，已撤销新增文件', { error: String(error) })
      }
    }
    this.data.roles.reload()
    return result
  }
  private newId(prefix: 'r' | 'p'): string {
    for (;;) {
      const id = `${prefix}-${randomBytes(4).toString('hex')}`
      if (this.data.presets.get(id) || this.data.roles.get(id) || existsSync(this.path(join('roles', id))) || existsSync(this.path(join('roles', `${id}.md`)))) continue
      const avatars = this.path(join('images', 'avatars'))
      if (!existsSync(avatars) || !readdirSync(avatars).some(f => f.toLowerCase().startsWith(id + '.'))) return id
    }
  }
  private transactions(): { folder: string; manifest: Manifest }[] {
    if (!existsSync(this.path('import-backups'))) return []
    const entries: { folder: string; manifest: Manifest }[] = []
    for (const name of readdirSync(this.backups).sort()) {
      const folder = this.path(join('import-backups', name))
      if (!lstatSync(folder).isDirectory()) continue
      const file = this.path(join('import-backups', name, 'manifest.json'))
      if (!existsSync(file)) continue
      let raw: unknown
      try { raw = json(readFileSync(file, 'utf8')) } catch { return fail('storage-failed', '导入恢复清单损坏，请检查来源档案') }
      if (!isRecord(raw) || raw['format'] !== 'qqbot-tavern-transaction') continue // 旧配置导入档案不归本模块管理。
      const m = raw as unknown as Manifest
      const validHash = (h: unknown): boolean => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)
      if (m.version !== 1 || !['prepared', 'complete', 'rolled-back'].includes(m.stage) || !validHash(m.tokenHash) || !validHash(m.payloadHash)
        || !(m.oldPresetHash === null || validHash(m.oldPresetHash)) || !validHash(m.newPresetHash) || !Array.isArray(m.files) || !Array.isArray(m.presets) || (m.assignments !== undefined && !isRecord(m.assignments))
        || !isRecord(m.result) || !/^[rp]-[a-f0-9]{8}$/.test(m.result.id) || m.result.archive !== name || !['role', 'preset'].includes(m.result.kind)
        || (m.roleId !== undefined && (m.roleId !== m.result.id || m.result.kind !== 'role'))
        || m.files.some(f => !isRecord(f) || !validHash(f.sha256) || ![join('roles', m.roleId ?? '', 'ROLE.md'), join('images', 'avatars', `${m.roleId}.png`)].includes(f.path))
        || new Set(m.files.map(f => f.path)).size !== m.files.length) return fail('storage-failed', '导入恢复清单不符合内部路径规则')
      // 计划和身份必须一致，不能借用外部 id／路径判断已提交。
      if (m.result.kind === 'role' ? !m.roleId || m.presets.length !== 0 || (m.assignments !== undefined && (Object.keys(m.assignments).length !== 1 || !Object.hasOwn(m.assignments, m.roleId) || typeof m.assignments[m.roleId] !== 'string'))
        : m.roleId !== undefined || m.files.length !== 0 || m.presets.length !== 1 || m.presets[0]?.id !== m.result.id || (m.assignments !== undefined && Object.keys(m.assignments).length !== 0)) return fail('storage-failed', '导入恢复计划无效')
      entries.push({ folder, manifest: m })
    }
    return entries
  }
  private rollback(m: Manifest): void {
    // 先检查全部所有权，再删除；内容已变时整笔留待人工处理。
    for (const f of m.files) { const target = this.path(f.path); if (existsSync(target) && (!lstatSync(target).isFile() || hash(readFileSync(target)) !== f.sha256)) return fail('storage-failed', '新增文件已被外部修改，保留待恢复') }
    const role = m.roleId ? this.path(join('roles', m.roleId)) : undefined
    if (role && existsSync(role) && readdirSync(role).some(name => name !== 'ROLE.md')) return fail('storage-failed', '新增角色目录有其他文件，保留待恢复')
    for (const f of [...m.files].reverse()) { const target = this.path(f.path); if (existsSync(target)) { this.checkpoint('rollback-file'); unlinkSync(target) } }
    if (role && existsSync(role)) rmdirSync(role)
    this.data.roles.reload()
  }
  recover(): void {
    this.available()
    for (const { folder, manifest: m } of this.transactions()) {
      if (m.stage !== 'prepared') continue
      const bytes = this.diskPreset(), current = bytes === undefined ? null : hash(bytes)
      // A v1 transaction may have been migrated on startup. Its original bytes
      // identify the old commit point; legacy assignments are never restored.
      const originalFile = this.path('presets.json.pre-v2')
      const original = existsSync(originalFile) ? readFileSync(originalFile) : undefined
      const migratedHash = (() => {
        if (!original || !bytes) return undefined
        const old = json(original.toString('utf8')), now = json(bytes.toString('utf8'))
        if (!isRecord(old) || old['version'] !== 1 || !isRecord(now) || now['version'] !== 2) return undefined
        return canonical({ version: 2, current: old['default'], presets: old['presets'] }) === canonical(now) ? hash(original) : undefined
      })()
      let appended = (current === m.newPresetHash && (m.newPresetHash !== m.oldPresetHash || m.presetCommitted === true)) || migratedHash === m.newPresetHash
      if (!appended && bytes && m.presets.length > 0) {
        const state = json(bytes.toString('utf8'))
        if (isRecord(state) && Array.isArray(state['presets'])) {
          appended = m.presets.every(p => (state['presets'] as unknown[]).some(v => canonical(v) === canonical(p)))
        }
      }
      if (appended) { m.stage = 'complete'; writeJson(join(folder, 'manifest.json'), m); this.data.presets.reload(); this.data.roles.reload() }
      else if (current === m.oldPresetHash || migratedHash === m.oldPresetHash) { this.rollback(m); m.stage = 'rolled-back'; writeJson(join(folder, 'manifest.json'), m) }
      else return fail('storage-failed', '导入中断后资料库已被外部修改，保留档案待恢复')
    }
  }
}
