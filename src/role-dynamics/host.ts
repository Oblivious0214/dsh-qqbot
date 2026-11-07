/** Trusted host boundary: one core, file store and data coordinator. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { QqbotData } from '../content.ts'
import type { Maintenance } from '../maintenance.ts'
import { RoleDataTransactions } from '../role-transactions.ts'
import { FileDataTransaction } from '../data-transactions.ts'
import { digest, type HistoryEvent } from './history.ts'
import { HostHistoryView, type HistoryHost, type HostSession } from './host-history.ts'
import { DynamicsSelections } from './selection.ts'
import { RoleDynamicsService, type Operation, type Snapshot, type SourceHandle, type Target } from './service.ts'
import { FileJournalStore } from './store.ts'
import { diagnose } from './projection.ts'
import type { DynamicsPublic, DynamicsSource, PublicOperation, StateView } from './api-types.ts'
import { renderModelProjection } from './model.ts'

export class DynamicsHost {
  readonly history: HostHistoryView
  readonly core: RoleDynamicsService
  readonly store: FileJournalStore
  readonly transactions: RoleDataTransactions
  private owner: SourceHandle
  private readonly selections: DynamicsSelections
  private readonly adapters = new Set<() => void>()
  private readonly sources = new Set<{ identity: string; name: string; handle: SourceHandle; revoke(): void; active: boolean }>()
  private readonly pluginSources = new WeakMap<object, DynamicsSource>()
  private readonly cleanups: (() => void)[] = []
  private disposed = false
  private generation = 0
  constructor(private readonly ctx: Context, root: string, readonly data: QqbotData, readonly maintenance: Maintenance) {
    this.history = new HostHistoryView(() => {
      const sessionQuery = ctx.get('sessionQuery' as never), sessions = ctx.get('sessions')
      if (!sessionQuery || !sessions) throw new Error('动态设定需要宿主会话历史服务')
      return { sessionQuery, sessions } as unknown as HistoryHost
    })
    this.store = new FileJournalStore(join(root, 'role-dynamics'))
    this.selections = new DynamicsSelections(join(root, 'role-dynamics', 'selections.json'))
    this.core = new RoleDynamicsService({ store: this.store, history: this.history,
      config: id => data.roles.configuration(id), isSelected: target => data.roleIdFor({ id: target.sessionId }) === target.roleId,
      epoch: maintenance.view().dataEpoch })
    this.owner = this.core.createOwnerSource()
    this.transactions = new RoleDataTransactions(data.roles, { dynamics: this.core, maintenance,
      prepareHistory: id => this.prepareRole(id), invalidated: () => this.renew() })
    this.cleanups.push(ctx.on('session/event', (session, event) => {
      this.history.observe(session as HostSession, event as unknown as HistoryEvent)
      if (!this.maintenance.active && this.selections.has(session.id)) this.sealSelection(session.id)
    }))
    this.cleanups.push(data.bindings.interceptChoices((id, role, publish) => {
      const before = data.roleIdFor({ id })
      const configured = (role !== null && data.roles.configuration(role) !== undefined)
        || (before !== undefined && data.roles.configuration(before) !== undefined)
      if (!configured && !this.selections.has(id)) { publish(); return }
      maintenance.assertAvailable()
      const cut = this.history.capture(id)
      const files = [join(root, 'role-dynamics', 'selections.json'), data.bindings.filePath].filter((file): file is string => file !== undefined)
      const tx = FileDataTransaction.prepare(root, 'selection-transactions', files, { sessionId: id })
      try {
        this.selections.record(cut, role, true); publish(); tx.commit()
      } catch (error) {
        if (!tx.committed) { tx.rollback(); data.bindings.reload() }
        throw error
      }
      if (before !== undefined && before !== role) this.core.invalidateTarget(before, id)
    }))
  }
  private assertGeneration(generation: number) {
    if (this.disposed || generation !== this.generation) throw new Error('动态设定操作已失效')
    this.maintenance.assertAvailable()
  }
  private renew(): void {
    this.generation++
    for (const reset of this.adapters) reset()
    this.owner = this.core.createOwnerSource()
    for (const record of this.sources) {
      if (!record.active) continue
      const next = this.core.registerSource(record.identity, record.name)
      record.handle = next.handle; record.revoke = next.dispose
    }
  }
  onInvalidate(reset: () => void): () => void { this.adapters.add(reset); return () => { this.adapters.delete(reset) } }
  private async prepareRole(id: string): Promise<void> {
    const journal = this.store.load(id) as { progress?: { sessionId: string }[] } | undefined
    for (const sessionId of new Set(journal?.progress?.map(progress => progress.sessionId))) await this.history.prepare(sessionId)
  }
  async prepareSession(id: string, targetRole = this.data.roleIdFor({ id }), selectionOnly = false): Promise<void> {
    const generation = this.generation
    const journal = targetRole === undefined ? undefined : this.store.load(targetRole) as { progress?: { sessionId: string }[] } | undefined
    const visit = async (sessionId: string, seen = new Set<string>()): Promise<void> => {
      if (seen.has(sessionId)) throw new Error('动态历史血缘循环')
      await this.history.prepare(sessionId); this.assertGeneration(generation)
      const cut = this.history.capture(sessionId)
      const needsParent = !this.selections.has(sessionId) || (!selectionOnly && targetRole !== undefined && !journal?.progress?.some(progress => progress.sessionId === sessionId))
      if (needsParent && cut.header.isSeeded && cut.header.parentSession) await visit(cut.header.parentSession, new Set([...seen, sessionId]))
    }
    await visit(id)
  }
  async attach(id: string): Promise<void> {
    const current = this.data.roleIdFor({ id })
    const config = current === undefined ? undefined : this.data.roles.configuration(current)
    const header = (this.ctx.get('sessions') as unknown as HistoryHost['sessions'] | undefined)?.get(id)?.header
    if (!config && !this.selections.has(id)
      && (!header?.isSeeded || !header.parentSession || !this.selections.has(header.parentSession))) return
    await this.maintenance.write(async guard => {
      await this.prepareSession(id, undefined, true); guard()
      const restore = (sessionId: string, seen = new Set<string>()): string | null | undefined => {
        if (seen.has(sessionId)) throw new Error('角色选择血缘循环')
        const cut = this.history.capture(sessionId)
        if (this.selections.has(sessionId)) return this.selections.current(cut)
        if (!cut.header.isSeeded || !cut.header.parentSession) return undefined
        restore(cut.header.parentSession, new Set([...seen, sessionId]))
        return this.selections.inherit(cut, this.history.capture(cut.header.parentSession))
      }
      const role = restore(id)
      if (role !== undefined && this.data.bindings.get(id) !== role) this.data.bindings.set(id, role)
      this.data.settle({ id })
      const selected = this.data.roleIdFor({ id })
      if (selected !== undefined && this.data.roles.configuration(selected) !== undefined && !this.selections.has(id)) {
        this.selections.record(this.history.capture(id), selected, true)
      }
      if (this.history.capture(id).header.isSeeded) {
        for (const roleId of this.selections.roles(this.history.capture(id))) {
          if (this.data.roles.configuration(roleId) === undefined) continue
          await this.prepareSession(id, roleId); guard()
          await this.core.readSnapshot({ sessionId: id, roleId }); guard()
        }
      }
      guard()
    })
  }
  needsSelection(id: string, nextRole?: string): boolean {
    const previous = this.data.roleIdFor({ id })
    return this.selections.has(id) || (previous !== undefined && this.data.roles.configuration(previous) !== undefined)
      || (nextRole !== undefined && this.data.roles.configuration(nextRole) !== undefined)
  }
  async prepareSelection(id: string, nextRole?: string): Promise<void> {
    if (!this.needsSelection(id, nextRole)) return
    await this.maintenance.write(async guard => {
      await this.prepareSession(id); guard()
      const roleId = this.data.roleIdFor({ id })
      if (roleId !== undefined && this.data.roles.configuration(roleId) !== undefined) await this.core.readSnapshot({ sessionId: id, roleId })
      guard()
    })
  }
  sealSelection(id: string): void { this.selections.seal(this.history.capture(id)) }
  recordSelection(id: string, start: number): void {
    const cut = this.history.capture(id), role = this.data.roleIdFor({ id }) ?? null
    this.selections.record({ ...cut, seq: start + 1, events: cut.events.slice(0, start + 1) }, role, true)
  }
  async state(id: string, expectedRole?: string, preview = false): Promise<StateView | undefined> {
    return this.maintenance.write(async guard => {
      const role = this.data.roleFor({ id })
      if (expectedRole !== undefined && role?.id !== expectedRole) throw new Error('角色已切换，请重新选择对话')
      if (!role) return undefined
      const config = this.data.roles.configuration(role.id)
      if (!config || (!preview && !config.enabled)) return undefined
      await this.prepareSession(id); guard()
      const target = { sessionId: id, roleId: role.id }
      const snapshot = await (preview ? this.core.inspectSnapshot(target) : this.core.readSnapshot(target)); guard()
      if (this.data.roleIdFor({ id }) !== role.id) throw new Error('角色已切换，请重新打开状态')
      return snapshot ? { roleId: role.id, name: role.name, config, snapshot, diagnosis: diagnose(config, snapshot.values) } : undefined
    })
  }
  async ownerCommit(id: string, roleId: string, operation: PublicOperation) {
    return this.maintenance.write(async guard => {
      const generation = this.generation, owner = this.owner
      await this.prepareSession(id); guard(); this.assertGeneration(generation)
      if (this.data.roleIdFor({ id }) !== roleId || !this.data.roles.configuration(roleId)?.enabled) throw new Error('角色已切换或动态设定已停用')
      const result = await this.core.commit({ sessionId: id, roleId }, { ...operation, source: owner }); guard()
      return result
    })
  }
  async preview(id: string): Promise<string> {
    const roleId = this.data.roleIdFor({ id })
    if (!roleId || !this.data.roles.configuration(roleId)?.enabled) return ''
    return this.maintenance.write(async guard => {
      await this.prepareSession(id); guard()
      const projection = await this.core.projectModel({ sessionId: id, roleId }); guard()
      return projection ? renderModelProjection(projection) : ''
    })
  }
  forPlugin(identity: string | undefined, caller: Context): DynamicsPublic {
    if (!identity) throw new Error('动态设定来源需要插件身份')
    const registerSource = (name: string) => {
      const source = this.registerSource(identity, name, caller); this.pluginSources.set(caller.fiber, source); return source
    }
    const source = () => this.pluginSources.get(caller.fiber) ?? registerSource(identity)
    return { registerSource,
      readSnapshot: target => source().readSnapshot(target), commit: (target, operation) => source().commit(target, operation),
      projectModel: target => source().projectModel(target), subscribe: (target, listener) => source().subscribe(target, listener),
    }
  }
  private registerSource(identity: string, name: string, caller: Context): DynamicsSource {
    this.assertGeneration(this.generation)
    const registered = this.core.registerSource(identity, name)
    const record = { identity, name, handle: registered.handle, revoke: registered.dispose, active: true }
    this.sources.add(record)
    const subscriptions = new Set<() => void>()
    const check = () => { if (!record.active || this.disposed) throw new Error('动态设定来源已撤销') }
    const run = <T>(target: Target, body: (source: SourceHandle) => Promise<T>): Promise<T> => this.maintenance.write(async guard => {
      check(); const handle = record.handle, generation = this.generation
      await this.prepareSession(target.sessionId, target.roleId); guard(); check(); this.assertGeneration(generation)
      const result = await body(handle); guard(); check(); return result
    })
    const dispose = () => {
      if (!record.active) return
      record.active = false; record.revoke(); this.sources.delete(record)
      for (const cancel of subscriptions) cancel()
      subscriptions.clear()
    }
    caller.effect(() => dispose, 'qqbot: dynamics source')
    return {
      readSnapshot: target => run(target, () => this.core.readSnapshot(target)),
      projectModel: target => run(target, () => this.core.projectModel(target)),
      commit: (target, operation) => run(target, source => this.core.commit(target, { ...operation, source })),
      readExtension: target => run(target, source => this.core.readExtension(source, target)),
      commitExtension: (target, config, operation) => run(target, source => this.core.commitExtension(source, target, config, operation)),
      subscribe: (target, listener) => {
        check(); const cancel = this.core.subscribe(target, listener); subscriptions.add(cancel)
        return () => { cancel(); subscriptions.delete(cancel) }
      }, dispose,
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.generation++
    for (const reset of this.adapters) reset()
    this.adapters.clear()
    for (const source of this.sources) source.revoke()
    this.sources.clear()
    for (const cleanup of this.cleanups.reverse()) cleanup()
    this.transactions.dispose()
    try { this.core.dispose() } finally { this.history.dispose() }
  }
}
/** Must run before constructing the bindings store. */
export function recoverDynamicsSelections(root: string): void { FileDataTransaction.recover(root, 'selection-transactions') }
export function candidateOperation(snapshot: Snapshot, source: SourceHandle, start: number, call: number, changes: Operation['changes']): Operation {
  return { operationId: digest([snapshot.generation, start, call]), baseRevision: snapshot.revision,
    configRevision: snapshot.configRevision, progressId: snapshot.progressId, generation: snapshot.generation,
    dataEpoch: snapshot.dataEpoch, source, changes }
}
