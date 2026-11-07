/** 第04步数据层协调；第06步由唯一宿主服务绑定真实核心与维护门禁。 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FileDataTransaction, inside, type TransactionFault } from './data-transactions.ts'
import { digest } from './role-dynamics/history.ts'
import type { RoleDynamicsService, RolePersistencePort } from './role-dynamics/service.ts'
import type { Maintenance } from './maintenance.ts'
import type { PreparedRoleSave, Role, RoleLibrary, RoleTransactions } from './roles.ts'
import { renameWithRetry } from './storage.ts'

export const progressDirectory = (root: string, id: string) => join(root, 'role-dynamics', 'roles', createHash('sha256').update(id).digest('hex'))
export class RoleDataTransactions implements RoleTransactions {
  private readonly root: string
  private active = false
  private unregister: (() => void) | undefined
  constructor(private readonly roles: RoleLibrary, private readonly options: { dynamics?: RoleDynamicsService; maintenance?: Maintenance; prepareHistory?(roleId: string): Promise<void>; invalidated?(): void; fault?: TransactionFault } = {}) {
    this.root = dirname(roles.dir)
    FileDataTransaction.recover(this.root, 'role-transactions')
    roles.useTransactions(this)
    if (options.dynamics && options.maintenance) {
      const service = options.dynamics
      this.unregister = options.maintenance.register({
        cache: () => service.clearCaches(),
        // Lifecycle invalidates awaits immediately; retain the current epoch if a later prepare hook fails.
        prepare: () => { try { service.invalidate(options.maintenance!.view().dataEpoch) } finally { options.invalidated?.() } },
        reload: () => { try { service.invalidate(options.maintenance!.view().dataEpoch) } finally { options.invalidated?.() } },
      })
    }
  }
  dispose() { this.unregister?.(); this.unregister = undefined }
  private async run<T>(id: string, body: (guard: () => void, core?: RolePersistencePort) => Promise<T>): Promise<T> {
    if (this.active) throw new Error('角色资料正在保存，请稍后再试')
    this.roles.assertReady(id)
    this.active = true; this.roles.reserve(id, true)
    const work = async (guard: () => void) => {
      if (this.options.prepareHistory) await this.options.prepareHistory(id)
      guard()
      if (this.options.dynamics) return this.options.dynamics.withRolePersistence(id, core => body(() => { guard(); core.guard() }, core))
      if (existsSync(progressDirectory(this.root, id))) throw new Error('动态进度服务未接入，角色资料保持原样')
      return body(guard)
    }
    try { return this.options.maintenance ? await this.options.maintenance.write(work) : await work(() => {}) }
    finally { this.active = false; this.roles.reserve(id, false); this.roles.reload() }
  }
  save(prepared: PreparedRoleSave): Promise<Role> {
    return this.run(prepared.id, async (guard, core) => {
      const { id, current, draft } = prepared
      if (current?.dynamicsError) throw new Error(current.dynamicsError)
      const changed = draft.dynamics !== undefined && (draft.resetDynamics === true || digest(current?.dynamics ?? null) !== digest(draft.dynamics))
      if (!changed) { guard(); return this.roles.publish(prepared) }
      const next = draft.dynamics ?? undefined
      const progress = progressDirectory(this.root, id)
      await core?.prepare()
      if ((existsSync(prepared.file) ? readFileSync(prepared.file, 'utf8') : undefined) !== prepared.existing) {
        this.roles.gate(id, true)
        throw new Error('角色保存失败，事务需要恢复，等待期间角色文件已变化，当前文件已保留')
      }
      const compatible = core && current?.dynamics && next ? core.plan(next, { ...draft.dynamicsRenames }).compatible : false
      if (core && current?.dynamics && next && !compatible && !draft.resetDynamics) throw new Error('需要重置该角色各会话进度后应用')
      if (!next && existsSync(progress) && !draft.resetDynamics) throw new Error('删除动态设定需要重置该角色各会话进度后应用')
      guard()
      const tx = FileDataTransaction.prepare(this.root, 'role-transactions', [prepared.create ? dirname(prepared.file) : prepared.file, progress], { kind: 'configuration', roleId: id, from: current?.dynamicsRevision, to: digest(next ?? null) }, this.options.fault)
      try {
        tx.expectFile(prepared.file, prepared.text, prepared.create)
        if (core && current?.dynamics) {
          if (draft.resetDynamics) {
            if (next && compatible) core.approve(next, { ...draft.dynamicsRenames })
            await core.reset(next)
          }
          else if (next) core.approve(next, { ...draft.dynamicsRenames })
          else core.invalidate()
        }
        guard()
        // Null discards the active journal, with its exact original kept in this transaction.
        if (!next && existsSync(progress)) {
          const archived = inside(this.root, join(tx.dir, 'removed-progress'))
          renameWithRetry(progress, archived)
        }
        const saved = this.roles.publish(prepared)
        // pendingConfigRevision must be cleared against the newly published authority.
        if (core && next && current?.dynamics && draft.resetDynamics) core.approve(next)
        tx.changed(); guard(); tx.commit(); return saved
      } catch (error) {
        if (!tx.committed) {
          try { guard(); tx.rollback(); this.roles.reload(); core?.invalidate() }
          catch (recovery) { this.roles.gate(id, true); throw new Error('角色保存失败，事务需要恢复，资料门禁保持关闭', { cause: new AggregateError([error, recovery]) }) }
        }
        throw error
      }
    })
  }
  remove(id: string, extras: readonly string[]): Promise<string> {
    return this.run(id, async (guard, core) => {
      const file = this.roles.fileFor(id)
      if (!file) throw new Error('角色已不存在')
      const source = basename(file) === 'ROLE.md' && dirname(dirname(file)) === this.roles.dir ? dirname(file) : file
      const progress = progressDirectory(this.root, id)
      await core?.prepare()
      const paths = [source, ...extras].filter(path => existsSync(inside(this.root, path)))
      const tx = FileDataTransaction.prepare(this.root, 'role-transactions', [...paths, progress], { kind: 'remove', roleId: id, sources: paths }, this.options.fault)
      const trash = join(this.root, 'roles-trash', tx.manifest.stamp)
      try {
        guard(); core?.detach(tx.manifest.stamp)
        mkdirSync(trash, { recursive: true })
        for (let index = 0; index < paths.length; index++) renameWithRetry(paths[index]!, join(trash, `${index}-${basename(paths[index]!)}`))
        tx.changed(); guard(); tx.commit(); return tx.manifest.stamp
      } catch (error) {
        if (!tx.committed) {
          try {
            guard()
            // Restore through the core first to release its detach gate, then exact backups.
            const coreTrash = join(this.root, 'role-dynamics', 'trash', `${digest(id)}-${tx.manifest.stamp}`)
            if (core && existsSync(coreTrash)) core.restore(tx.manifest.stamp)
            else core?.release()
            tx.rollback(); core?.invalidate()
          } catch (recovery) { this.roles.gate(id, true); throw new Error('角色回收失败，事务需要恢复', { cause: new AggregateError([error, recovery]) }) }
        }
        throw error
      }
    })
  }
  async restore(stamp: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(stamp)) throw new Error('回收标识无效')
    const directory = inside(this.root, join(this.root, 'role-transactions', stamp))
    const removal = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { state: string; metadata: { kind: string; roleId: string; sources: string[] } }
    if (removal.state !== 'committed' || removal.metadata.kind !== 'remove') throw new Error('没有已完成的角色回收记录')
    const { roleId, sources } = removal.metadata
    return this.run(roleId, async (guard, core) => {
      const progress = progressDirectory(this.root, roleId)
      if (this.roles.get(roleId) || sources.some(path => existsSync(inside(this.root, path))) || existsSync(progress)) throw new Error('角色位置已有资料，不能覆盖恢复')
      const trash = inside(this.root, join(this.root, 'roles-trash', stamp))
      const coreTrash = inside(this.root, join(this.root, 'role-dynamics', 'trash', `${digest(roleId)}-${stamp}`))
      const paths = [...sources, progress, trash, coreTrash]
      const tx = FileDataTransaction.prepare(this.root, 'role-transactions', paths, { kind: 'restore', roleId, stamp }, this.options.fault)
      try {
        guard()
        if (existsSync(coreTrash)) { if (!core) throw new Error('动态进度服务未接入'); core.restore(stamp) }
        for (let index = 0; index < sources.length; index++) {
          const target = inside(this.root, sources[index]!)
          mkdirSync(dirname(target), { recursive: true }); renameWithRetry(join(trash, `${index}-${basename(target)}`), target)
        }
        tx.changed(); guard(); tx.commit(); core?.release()
      } catch (error) {
        if (tx.committed) core?.release()
        if (!tx.committed) {
          try { guard(); tx.rollback(); core?.detach(stamp) }
          catch (recovery) { this.roles.gate(roleId, true); throw new Error('角色恢复失败，事务需要恢复', { cause: new AggregateError([error, recovery]) }) }
        }
        throw error
      }
    })
  }
}
