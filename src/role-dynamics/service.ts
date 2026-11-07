import { randomUUID } from 'node:crypto'
import { planEvolution } from './evolution.ts'
import { anchor, completed, digest, matches, prefixes, successfulCall, turnEnd, validStateCall, type Anchor, type HistoryCut, type HistoryView } from './history.ts'
import { projectModel } from './projection.ts'
import type { JournalStore } from './store.ts'
import { DynamicsError, fail, type ModelProjection, type RoleDynamicsConfig, type Values } from './types.ts'
import { initialValues, jsonData, normalizeName, object, validateConfig, validateValue, validateValues } from './validate.ts'

import type { Target, Snapshot, SourceHandle, Operation, CommitStatus, CommitResult, TurnHandle } from './contracts.ts'
export type { Target, Snapshot, SourceHandle, Operation, CommitStatus, CommitResult, TurnHandle } from './contracts.ts'
interface Source { identity: string; kind: 'owner' | 'plugin' | 'ai'; active: boolean }
interface Receipt { key: string; payload: string; result: CommitResult }
interface RecordState {
  order: number; anchor: Anchor; snapshot: Snapshot; baseRevision: number
  source: string; operationId: string; payloadDigest: string; status: CommitStatus; time: number; turnId?: string
  isolatedByReset?: boolean
}
interface Candidate { operationId: string; payload: string; changes: Operation['changes']; callSeq: number; callId: string; callPrefix: string; sourceIdentity: string }
interface Turn {
  id: string; start: Anchor; snapshot: Snapshot; config: RoleDynamicsConfig; projection: ModelProjection
  candidates: Candidate[]; result?: CommitResult
  revoked?: boolean
  isolatedByReset?: boolean
}
interface Extension { config: RoleDynamicsConfig; revision: number; values: Values; receipts: Receipt[] }
interface Progress {
  sessionId: string; id: string; generation: string; observed: string[]; records: RecordState[]; turns: Turn[]
  receipts: Receipt[]; extensions: Record<string, Extension>
}
interface Evolution { from: string; to: string; renames: Record<string, string> }
interface Journal { version: 1; roleId: string; configs: Record<string, RoleDynamicsConfig>; evolutions: Evolution[]; progress: Progress[]; nextOrder: number; pendingConfigRevision?: string }
export interface DynamicsOptions {
  store: JournalStore; history: HistoryView; config(roleId: string): unknown | undefined
  isSelected(target: Target): boolean; epoch: string; clock?: () => number; id?: () => string
}
export interface RolePersistencePort {
  guard(): void
  prepare(): Promise<void>
  plan(next: RoleDynamicsConfig, renames?: Record<string, string>): ReturnType<RoleDynamicsService['planConfiguration']>
  approve(next: RoleDynamicsConfig, renames?: Record<string, string>): void
  reset(next?: RoleDynamicsConfig): Promise<void>
  invalidate(): void
  detach(stamp: string): void
  restore(stamp: string): void
  release(): void
}
const clone = <T>(value: T): T => structuredClone(value)
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const targetKey = (target: Target) => digest([target.sessionId, target.roleId])

/** No host imports. All mutations reload the authoritative journal inside the queue. */
export class RoleDynamicsService {
  private epoch: string
  private disposed = false
  private lifecycle = 0
  private queue: Promise<unknown> = Promise.resolve()
  private active: { epoch: string; lifecycle: number } | undefined
  private readonly blockedRoles = new Set<string>()
  private readonly knownRoles = new Set<string>()
  private readonly sources = new Map<string, Source>()
  private readonly handles = new Map<string, { target: Target; turnId: string; generation: string; lifecycle: number }>()
  // Retain a failed stop write in memory; every recovery/fork load reapplies it
  // until a later successful journal write persists the revocation.
  private readonly stoppedTurns = new Set<string>()
  private readonly listeners = new Map<string, Set<(snapshot: Snapshot) => void>>()
  private ai: SourceHandle
  constructor(private readonly options: DynamicsOptions) {
    this.epoch = options.epoch; this.ai = this.source('ai', 'AI', 'ai')
  }
  private id() { return (this.options.id ?? randomUUID)() }
  private now() { return (this.options.clock ?? Date.now)() }
  private guard(epoch = this.active?.epoch ?? this.epoch, lifecycle = this.active?.lifecycle ?? this.lifecycle) {
    if (this.disposed || epoch !== this.epoch || lifecycle !== this.lifecycle) fail('$.lifecycle', '操作已失效', 'stale')
  }
  private run<T>(body: () => T | Promise<T>): Promise<T> {
    const epoch = this.epoch; const lifecycle = this.lifecycle
    const next = this.queue.then(async () => {
      this.guard(epoch, lifecycle); this.active = { epoch, lifecycle }
      try { const result = await body(); this.guard(epoch, lifecycle); return result } finally { this.active = undefined }
    })
    this.queue = next.catch(() => {})
    return next
  }
  private source(identity: string, name: string, kind: Source['kind']): SourceHandle {
    const handle = freeze({ token: this.id(), name })
    this.sources.set(handle.token, { identity, kind, active: true }); return handle
  }
  /** Called by trusted owner/host adapters; never expose source registration over model/HTTP JSON. */
  createOwnerSource(): SourceHandle { this.guard(this.epoch, this.lifecycle); return this.source('owner', '用户', 'owner') }
  registerSource(pluginIdentity: string, displayName: string): { handle: SourceHandle; dispose: () => void } {
    this.guard(this.epoch, this.lifecycle)
    const identity = normalizeName(pluginIdentity); const name = normalizeName(displayName)
    if ([...this.sources.values()].some(source => source.active && source.identity === `plugin:${identity}`)) fail('$.source', '来源已登记')
    const handle = this.source(`plugin:${identity}`, name, 'plugin')
    return { handle, dispose: () => { const source = this.sources.get(handle.token); if (source) source.active = false } }
  }
  private authorize(handle: SourceHandle): Source {
    const source = this.sources.get(handle?.token)
    if (!source?.active) return fail('$.source', '来源已失效', 'source')
    return source
  }
  private config(roleId: string): RoleDynamicsConfig | undefined {
    const input = this.options.config(roleId)
    return input === undefined ? undefined : validateConfig(input)
  }
  private load(roleId: string): Journal {
    this.knownRoles.add(roleId)
    const raw = this.options.store.load(roleId)
    if (raw === undefined) return { version: 1, roleId, configs: {}, evolutions: [], progress: [], nextOrder: 0 }
    try {
      jsonData(raw)
      const journal = raw as Journal
      if (journal.version !== 1 || journal.roleId !== roleId || !Array.isArray(journal.progress) || !Array.isArray(journal.evolutions)
        || !Number.isSafeInteger(journal.nextOrder) || journal.nextOrder < 0) throw new Error('shape')
      for (const [revision, config] of Object.entries(journal.configs)) if (digest(validateConfig(config)) !== revision) throw new Error('config')
      const ids = new Set<string>()
      for (const progress of journal.progress) {
        if (!progress.id || ids.has(progress.id) || !progress.generation || !progress.sessionId || !Array.isArray(progress.observed)
          || !Array.isArray(progress.turns) || !Array.isArray(progress.receipts) || !Array.isArray(progress.records) || !progress.records.length) throw new Error('progress')
        ids.add(progress.id)
        for (const record of progress.records) {
          const snapshot = record.snapshot; const config = journal.configs[snapshot.configRevision]
          if (!config || snapshot.roleId !== roleId || snapshot.sessionId !== progress.sessionId || snapshot.generation !== progress.generation
            || snapshot.progressId !== progress.id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
            || !Number.isSafeInteger(record.order) || !Number.isSafeInteger(record.anchor.seq) || record.anchor.seq < 0
            || !['before', 'after'].includes(record.anchor.phase) || !/^[a-f0-9]{64}$/.test(record.anchor.prefix)) throw new Error('record')
          validateValues(config, snapshot.values)
        }
        for (const turn of progress.turns) {
          if (digest(validateConfig(turn.config)) !== turn.snapshot.configRevision || !Array.isArray(turn.candidates)) throw new Error('turn')
          validateValues(turn.config, turn.snapshot.values)
        }
      }
      const loaded = clone(journal)
      for (const progress of loaded.progress) for (const turn of progress.turns) if (this.stoppedTurns.has(turn.id)) turn.revoked = true
      return loaded
    } catch { return fail('$.journal', '进度日志损坏，原件已保留', 'corrupt') }
  }
  private save(journal: Journal) { this.guard(); this.options.store.save(journal.roleId, journal, () => this.guard()) }
  private record(journal: Journal, progress: Progress, snapshot: Snapshot, position: Anchor, source: string, operationId: string, payload: string, status: CommitStatus, baseRevision: number, turnId?: string): RecordState {
    const record: RecordState = { order: journal.nextOrder++, anchor: clone(position), snapshot: clone(snapshot), source, operationId,
      payloadDigest: payload, status, baseRevision, time: this.now(), ...(turnId ? { turnId } : {}) }
    progress.records.push(record); return record
  }
  private newProgress(target: Target, cut: HistoryCut): Progress {
    return { sessionId: target.sessionId, id: this.id(), generation: this.id(), observed: prefixes(cut), records: [], turns: [], receipts: [], extensions: {} }
  }
  private snapshot(target: Target, progress: Progress, config: RoleDynamicsConfig, values = initialValues(config)): Snapshot {
    return { ...target, progressId: progress.id, generation: progress.generation, revision: 0, configRevision: digest(config), dataEpoch: this.epoch, values: clone(values) }
  }
  private migrate(journal: Journal, snapshot: Snapshot, to: string, visited = new Set<string>()): Snapshot {
    if (snapshot.configRevision === to) return clone(snapshot)
    if (visited.has(snapshot.configRevision)) return fail('$.evolution', '配置演进循环', 'history')
    visited.add(snapshot.configRevision)
    const reaches = (from: string, seen = new Set<string>()): boolean => {
      if (from === to) return true
      if (seen.has(from)) return false
      seen.add(from)
      return journal.evolutions.some(edge => edge.from === from && reaches(edge.to, new Set(seen)))
    }
    const edge = [...journal.evolutions].reverse().find(item => item.from === snapshot.configRevision && !visited.has(item.to) && reaches(item.to))
    if (!edge) return fail('$.evolution', '历史配置缺少已批准的迁移', 'incompatible')
    const previous = journal.configs[edge.from]; const next = journal.configs[edge.to]
    if (!previous || !next) return fail('$.evolution', '配置基线缺失', 'history')
    const values = planEvolution(previous, next, [{ progressId: snapshot.progressId, values: snapshot.values }], edge.renames).migrate(snapshot.values)
    return this.migrate(journal, { ...snapshot, values, configRevision: edge.to }, to, visited)
  }
  private validCandidate(cut: HistoryCut, turn: Turn, candidate: Candidate): boolean {
    return prefixes(cut)[candidate.callSeq + 1] === candidate.callPrefix
      && successfulCall(cut, turn.start.seq, candidate.callSeq, candidate.callId)
  }
  /** Replay records and durable candidates against a precise cut without changing the parent. */
  private fold(progress: Progress, cut: HistoryCut, tail: boolean): RecordState[] {
    const records = progress.records.filter(record => matches(record.anchor, cut, tail || record.source === 'initial')).map(clone)
    const virtual: { seq: number; turn: Turn }[] = []
    for (const turn of progress.turns) {
      if (turn.revoked || (turn.result && !['committed', 'no-change'].includes(turn.result.status))) continue
      if (!matches(turn.start, cut, false)) continue
      const end = completed(cut, turn.start.seq)
      if (end && !records.some(record => record.turnId === turn.id)) virtual.push({ seq: end.seq, turn })
    }
    const events = [...records.map(record => ({ seq: record.anchor.seq, phase: record.anchor.phase === 'before' ? 0 : 1, order: record.order, record })),
      ...virtual.map(item => ({ seq: item.seq, phase: 1, order: Number.MAX_SAFE_INTEGER, turn: item.turn }))]
      .sort((a, b) => a.seq - b.seq || a.phase - b.phase || a.order - b.order)
    const output: RecordState[] = []
    for (const item of events) {
      if ('record' in item) { output.push(item.record); continue }
      const turn = item.turn; const head = output.at(-1)?.snapshot
      if (!head || head.generation !== turn.snapshot.generation || head.revision !== turn.snapshot.revision
        || head.configRevision !== turn.snapshot.configRevision || turn.snapshot.dataEpoch !== this.epoch) continue
      const candidates = turn.candidates.filter(candidate => this.validCandidate(cut, turn, candidate))
        .sort((a, b) => a.callSeq - b.callSeq)
      if (!candidates.length) continue
      const values = clone(head.values)
      candidates.forEach(candidate => candidate.changes.forEach(change => { values[change.name] = change.value }))
      const changed = digest(values) !== digest(head.values)
      output.push({ order: Number.MAX_SAFE_INTEGER, anchor: anchor(cut, 'after', item.seq), snapshot: { ...head, values, revision: head.revision + (changed ? 1 : 0) },
        baseRevision: head.revision, source: 'ai', operationId: turn.id, payloadDigest: digest(candidates), status: changed ? 'committed' : 'no-change', time: this.now(), turnId: turn.id })
    }
    return output
  }
  private ensure(journal: Journal, target: Target, cut: HistoryCut, config: RoleDynamicsConfig, visited = new Set<string>()): Progress {
    if (cut.header.id !== target.sessionId) return fail('$.history', '源会话身份不匹配', 'history')
    const chain = prefixes(cut); journal.configs[digest(config)] = config
    let progress = journal.progress.findLast(item => item.sessionId === target.sessionId)
    if (progress) {
      this.sealSession(journal, target.sessionId, chain)
      const common = progress.observed.findIndex((prefix, i) => chain[i] !== prefix)
      if (common !== -1) {
        if (common <= 1 && progress.observed.length > 1) return fail('$.history', '无法验证历史共同前缀', 'history')
        const recovered = this.asOf(journal, target.sessionId, cut)
        if (!recovered.length) return fail('$.history', '历史基线缺失', 'history')
        const replacement = this.newProgress(target, cut)
        replacement.records = recovered.map(record => ({ ...record, order: journal.nextOrder++, snapshot: { ...record.snapshot, progressId: replacement.id, generation: replacement.generation, dataEpoch: this.epoch } }))
        journal.progress.push(replacement); progress = replacement
      }
      this.seal(progress, chain); progress.observed = chain; return progress
    }
    if (visited.has(target.sessionId)) return fail('$.history', '分叉血缘循环', 'history')
    visited.add(target.sessionId)
    progress = this.newProgress(target, cut)
    if (cut.header.isSeeded && cut.inheritedEventCount > 0 && cut.header.parentSession === undefined) return fail('$.history', '继承历史缺少父会话身份', 'history')
    if (cut.header.isSeeded && cut.header.parentSession !== undefined) {
      const parentId = cut.header.parentSession
      if (visited.has(parentId)) return fail('$.history', '分叉血缘循环', 'history')
      const parent = this.options.history.capture(parentId); const parentChain = prefixes(parent)
      const count = cut.inheritedEventCount
      if (count > parent.seq || chain[count] !== parentChain[count]) return fail('$.history', '继承前缀与父会话不一致', 'history')
      const parentProgress = this.ensure(journal, { sessionId: parentId, roleId: target.roleId }, parent, config, visited)
      const inherited = { ...cut, seq: count, events: cut.events.slice(0, count), inheritedEventCount: 0 }
      const records = this.asOf(journal, parentProgress.sessionId, inherited)
      if (!records.length) return fail('$.history', '分叉基线缺失', 'history')
      progress.records = records.map(record => ({ ...record, order: journal.nextOrder++, anchor: { ...record.anchor, sessionId: target.sessionId },
        snapshot: { ...record.snapshot, ...target, progressId: progress!.id, generation: progress!.generation, dataEpoch: this.epoch } }))
    } else {
      const snapshot = this.snapshot(target, progress, config)
      this.record(journal, progress, snapshot, { sessionId: target.sessionId, seq: 0, phase: 'after', prefix: chain[1] ?? chain[0]! }, 'initial', this.id(), '', 'no-change', 0)
      // Empty baseline precedes the first event, including forks with a zero event cut.
      progress.records[0]!.anchor = { sessionId: target.sessionId, seq: 0, phase: 'before', prefix: chain[0]! }
    }
    journal.progress.push(progress); return progress
  }
  private seal(progress: Progress, chain: string[]) {
    for (const record of progress.records) {
      if (record.source === 'initial' || record.anchor.phase !== 'before' || record.anchor.nextPrefix !== undefined) continue
      const next = chain[record.anchor.seq + 1]
      if (next && chain[record.anchor.seq] === record.anchor.prefix) record.anchor.nextPrefix = next
    }
  }
  private sealSession(journal: Journal, sessionId: string, chain: string[]) {
    for (const progress of journal.progress.filter(item => item.sessionId === sessionId)) {
      this.seal(progress, progress.observed)
      this.seal(progress, chain)
    }
  }
  private asOf(journal: Journal, sessionId: string, cut: HistoryCut): RecordState[] {
    return journal.progress.filter(progress => progress.sessionId === sessionId).flatMap(progress => this.fold(progress, cut, false))
      .sort((a, b) => a.anchor.seq - b.anchor.seq || (a.anchor.phase === b.anchor.phase ? a.order - b.order : a.anchor.phase === 'before' ? -1 : 1))
  }
  private current(journal: Journal, progress: Progress, cut: HistoryCut, config: RoleDynamicsConfig): Snapshot {
    const last = this.fold(progress, cut, true).at(-1)?.snapshot
    if (!last) return fail('$.history', '没有可验证的状态快照', 'history')
    return { ...this.migrate(journal, last, digest(config)), dataEpoch: this.epoch }
  }
  private async durable(target: Target, lifecycle: number, epoch: string): Promise<HistoryCut> {
    const cut = await this.options.history.flush(target.sessionId)
    this.guard(epoch, lifecycle); prefixes(cut); return cut
  }
  private settle(journal: Journal, progress: Progress, cut: HistoryCut, config: RoleDynamicsConfig): { changed: boolean; notifications: Snapshot[] } {
    const notifications: Snapshot[] = []; let changed = false
    for (const turn of progress.turns) {
      if (turn.result || !turnEnd(cut, turn.start.seq)) continue
      if (!this.options.isSelected({ sessionId: progress.sessionId, roleId: journal.roleId }) || turn.snapshot.configRevision !== digest(config)
        || turn.snapshot.dataEpoch !== this.epoch) turn.revoked = true
      const snapshot = this.current(journal, progress, cut, config)
      const derived = this.fold(progress, cut, true).find(record => record.turnId === turn.id)
      let status: CommitStatus = 'discarded'
      if (turn.revoked) status = 'conflict'
      else if (derived) status = derived.status
      else if (completed(cut, turn.start.seq) && turn.candidates.some(candidate => this.validCandidate(cut, turn, candidate))
        && snapshot.revision !== turn.snapshot.revision) status = 'conflict'
      if (derived && (status === 'committed' || status === 'no-change')) {
        if (!progress.records.some(record => record.turnId === turn.id)) {
          progress.records.push({ ...derived, order: journal.nextOrder++ })
          if (status === 'committed') notifications.push(derived.snapshot)
        }
      }
      turn.result = { status, snapshot: this.current(journal, progress, cut, config) }; changed = true
    }
    return { changed, notifications }
  }
  private notify(target: Target, snapshot: Snapshot) {
    for (const listener of this.listeners.get(targetKey(target)) ?? []) { try { listener(freeze(clone(snapshot))) } catch { /* committed transaction survives listener failure */ } }
  }
  private async context(target: Target, persist = true): Promise<{ journal: Journal; progress: Progress; cut: HistoryCut; config: RoleDynamicsConfig } | undefined> {
    if (this.blockedRoles.has(target.roleId)) return fail('$.target', '角色进度已回收', 'stale')
    const config = this.config(target.roleId)
    if (!config) return undefined
    const lifecycle = this.lifecycle; const epoch = this.epoch
    let cut = clone(this.options.history.capture(target.sessionId))
    let journal = this.load(target.roleId)
    const existing = journal.progress.findLast(item => item.sessionId === target.sessionId)
    // All reads/commits join preceding settlement, including cold restart recovery.
    if (existing?.turns.some(turn => !turn.result && turnEnd(cut, turn.start.seq)) || (!existing && cut.header.isSeeded)) cut = await this.durable(target, lifecycle, epoch)
    this.guard(epoch, lifecycle)
    if (this.blockedRoles.has(target.roleId)) return fail('$.target', '角色进度已回收', 'stale')
    if (digest(this.config(target.roleId)) !== digest(config)) return fail('$.configRevision', '配置已变化', 'conflict')
    journal = this.load(target.roleId)
    if (journal.pendingConfigRevision !== undefined) {
      if (journal.pendingConfigRevision !== digest(config)) return fail('$.configRevision', '角色配置与重置事务尚未对齐', 'incompatible')
      delete journal.pendingConfigRevision
    }
    const progress = this.ensure(journal, target, cut, config)
    for (const turn of progress.turns) if (!turn.result && (turn.snapshot.configRevision !== digest(config) || turn.snapshot.dataEpoch !== this.epoch)) turn.revoked = true
    const head = this.fold(progress, cut, true).at(-1)?.snapshot
    if (head && head.configRevision !== digest(config)) {
      const migrated = this.migrate(journal, head, digest(config))
      this.record(journal, progress, migrated, anchor(cut, 'before'), 'evolution', this.id(), digest(config), 'no-change', head.revision)
    }
    const result = this.settle(journal, progress, cut, config)
    if (persist) {
      this.save(journal)
      result.notifications.forEach(snapshot => this.notify(target, snapshot))
    }
    return { journal, progress, cut, config }
  }
  readSnapshot(target: Target): Promise<Snapshot | undefined> {
    return this.run(async () => { const ctx = await this.context(target); return ctx ? freeze(this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)) : undefined })
  }
  /** Owner UI preview: derive the current values without creating or updating a journal. */
  inspectSnapshot(target: Target): Promise<Snapshot | undefined> {
    return this.run(async () => { const ctx = await this.context(target, false); return ctx ? freeze(this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)) : undefined })
  }
  private async stableContext(target: Target) {
    for (;;) {
      const ctx = await this.context(target); this.guard()
      if (this.blockedRoles.has(target.roleId)) return fail('$.target', '角色进度已回收', 'stale')
      if (!ctx) return undefined
      if (digest(this.config(target.roleId)) !== digest(ctx.config)) continue
      const latest = this.options.history.capture(target.sessionId)
      if (latest.seq === ctx.cut.seq && prefixes(latest).at(-1) === prefixes(ctx.cut).at(-1)) return ctx
    }
  }
  projectModel(target: Target): Promise<ModelProjection | undefined> {
    return this.run(async () => { const ctx = await this.context(target); return ctx ? freeze(projectModel(ctx.config, this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config).values)) : undefined })
  }
  beginTurn(target: Target, turnStart: number): Promise<TurnHandle | undefined> {
    return this.run(async () => {
      const ctx = await this.stableContext(target)
      if (!ctx || !ctx.config.enabled) return undefined
      if (!this.options.isSelected(target)) return fail('$.target', '角色选择已变化', 'conflict')
      const event = ctx.cut.events[turnStart]
      if (event?.type !== 'turn/start' || turnEnd(ctx.cut, turnStart) || ctx.cut.events.findLastIndex(event => event.type === 'turn/start') !== turnStart) return fail('$.turnStart', '需要当前开放轮次', 'history')
      let turn = ctx.progress.turns.find(item => item.start.seq === turnStart && matches(item.start, ctx.cut, false))
      if (!turn) {
        const snapshot = this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)
        turn = { id: this.id(), start: anchor(ctx.cut, 'after', turnStart), snapshot, config: clone(ctx.config), projection: projectModel(ctx.config, snapshot.values), candidates: [] }
        ctx.progress.turns.push(turn); this.save(ctx.journal)
      }
      const old = [...this.handles].find(([, entry]) => entry.turnId === turn!.id && entry.generation === ctx.progress.generation && entry.lifecycle === this.lifecycle)
      const token = old?.[0] ?? this.id()
      this.handles.set(token, { target: clone(target), turnId: turn.id, generation: ctx.progress.generation, lifecycle: this.lifecycle })
      return freeze({ token, snapshot: clone(turn.snapshot), projection: clone(turn.projection), source: this.ai })
    })
  }
  private resolve(handle: TurnHandle) {
    const entry = this.handles.get(handle.token)
    if (!entry || entry.lifecycle !== this.lifecycle) return fail('$.turn', '轮次句柄已失效', 'stale')
    const journal = this.load(entry.target.roleId)
    const progress = journal.progress.findLast(item => item.sessionId === entry.target.sessionId)
    const turn = progress?.turns.find(item => item.id === entry.turnId)
    if (!progress || progress.generation !== entry.generation || !turn) return fail('$.turn', '进度代次已变化', 'stale')
    return { ...entry, journal, progress, turn }
  }
  private changes(config: RoleDynamicsConfig, operation: Operation, kind: Source['kind']): Operation['changes'] {
    if (!Array.isArray(operation.changes) || !operation.changes.length || operation.changes.length > 32) return fail('$.changes', '需要 1–32 项更新')
    const names = new Set<string>()
    return operation.changes.map((raw, i) => {
      jsonData(raw); const item = object(raw, `$.changes[${i}]`, ['name', 'value']); let name: string
      try { name = normalizeName(item.name) } catch (error) { if (kind === 'ai') return fail('$.changes', '本轮没有这个可更新字段'); throw error }
      const field = config.fields.find(item => item.name === name)
      if (!field || (kind === 'ai' && (!field.visible || !field.aiWritable))) return fail('$.changes', kind === 'ai' ? '本轮没有这个可更新字段' : '字段不存在或未开放')
      if (kind === 'plugin' && !field.pluginWritable) return fail('$.changes', '字段未开放给插件', 'source')
      if (names.has(name)) return fail('$.changes', '重复字段')
      names.add(name)
      return { name, value: validateValue(field, item.value, kind === 'ai' ? `$.${name}` : `$.changes[${i}].value`) }
    })
  }
  private operation(operation: Operation, snapshot: Snapshot, config: RoleDynamicsConfig, ai = false, permissions?: Source['kind']) {
    if (typeof operation.operationId !== 'string' || !operation.operationId || operation.operationId.length > 256) fail('$.operationId', '操作标识无效')
    if (!Number.isSafeInteger(operation.baseRevision) || operation.baseRevision < 0) fail('$.baseRevision', '状态版本无效')
    if (operation.dataEpoch !== this.epoch || operation.dataEpoch !== snapshot.dataEpoch) fail('$.dataEpoch', '资料代次已变化', 'stale')
    const source = this.authorize(operation.source)
    if ((source.kind === 'ai') !== ai) fail('$.source', '来源类型不符', 'source')
    if (operation.configRevision !== digest(config)) fail('$.configRevision', '配置已变化', 'conflict')
    if (operation.progressId !== snapshot.progressId || operation.generation !== snapshot.generation) fail('$.generation', '进度代次已变化', 'conflict')
    const changes = this.changes(config, operation, permissions ?? source.kind)
    const payload = digest({ changes, baseRevision: operation.baseRevision, configRevision: operation.configRevision, dataEpoch: operation.dataEpoch, generation: operation.generation, progressId: operation.progressId })
    return { source, changes, payload }
  }
  propose(handle: TurnHandle, operation: Operation, call: { seq: number; callId: string }): Promise<{ accepted: true }> {
    return this.run(() => {
      const ctx = this.resolve(handle)
      if (ctx.turn.result || ctx.turn.revoked || !this.options.isSelected(ctx.target) || digest(this.config(ctx.target.roleId)) !== ctx.turn.snapshot.configRevision) return fail('$.turn', '轮次已失效', 'conflict')
      const cut = this.options.history.capture(ctx.target.sessionId)
      const event = cut.events[call.seq]
      if (turnEnd(cut, ctx.turn.start.seq) || !matches(ctx.turn.start, cut, false) || !event || call.seq <= ctx.turn.start.seq
        || cut.events.findLastIndex(event => event.type === 'turn/start') !== ctx.turn.start.seq
        || !validStateCall(cut, ctx.turn.start.seq, event, call.callId)) return fail('$.call', '工具调用证据不匹配', 'history')
      const valid = this.operation(operation, ctx.turn.snapshot, ctx.turn.config, true)
      const callPrefix = prefixes(cut)[call.seq + 1]!
      if (operation.baseRevision !== ctx.turn.snapshot.revision) return fail('$.baseRevision', '候选基线不匹配', 'conflict')
      const previous = ctx.turn.candidates.find(item => item.operationId === operation.operationId || item.callSeq === call.seq)
      if (previous) {
        if (previous.payload !== valid.payload || previous.callSeq !== call.seq || previous.callId !== call.callId || previous.callPrefix !== callPrefix || previous.operationId !== operation.operationId) return fail('$.operationId', '操作标识已用于不同内容', 'conflict')
        return { accepted: true as const }
      }
      const reused = ctx.progress.turns.flatMap(turn => turn.candidates).find(item => item.operationId === operation.operationId)
      if (reused) {
        return fail('$.operationId', '操作标识已用于不同调用', 'conflict')
      }
      ctx.turn.candidates.push({ operationId: operation.operationId, payload: valid.payload, changes: valid.changes, callSeq: call.seq, callId: call.callId, callPrefix, sourceIdentity: 'ai' })
      ctx.progress.observed = prefixes(cut); this.save(ctx.journal); return { accepted: true as const }
    })
  }
  settleTurn(handle: TurnHandle): Promise<CommitResult> {
    return this.run(async () => {
      const entry = this.resolve(handle)
      let ctx: Awaited<ReturnType<RoleDynamicsService['context']>>
      try { ctx = await this.context(entry.target) } catch (error) {
        if (error instanceof DynamicsError && ['stale', 'conflict', 'corrupt', 'history', 'incompatible'].includes(error.code)) throw error
        return freeze({ status: 'pending' as const, snapshot: clone(entry.turn.snapshot), error: error instanceof Error ? error.message : '结算失败' })
      }
      if (!ctx || ctx.progress.generation !== entry.generation) return fail('$.turn', '轮次已失效', 'stale')
      const turn = ctx.progress.turns.find(item => item.id === entry.turnId)!
      return freeze(clone(turn.result ?? { status: 'pending' as const, snapshot: this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config) }))
    })
  }
  commit(target: Target, operation: Operation): Promise<CommitResult> {
    return this.run(async () => {
      const ctx = await this.stableContext(target)
      if (!ctx) return fail('$.target', '角色没有动态配置')
      if (!this.options.isSelected(target)) return fail('$.target', '角色选择已变化', 'conflict')
      const snapshot = this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)
      const valid = this.operation(operation, snapshot, ctx.config)
      const key = digest([ctx.progress.generation, valid.source.identity, operation.operationId])
      const prior = ctx.progress.receipts.find(receipt => receipt.key === key)
      if (prior) {
        if (prior.payload !== valid.payload) return fail('$.operationId', '操作标识已用于不同内容', 'conflict')
        return freeze(clone(prior.result))
      }
      if (operation.baseRevision !== snapshot.revision) return fail('$.baseRevision', '状态已变化', 'conflict')
      const values = clone(snapshot.values); valid.changes.forEach(change => { values[change.name] = change.value })
      const changed = digest(values) !== digest(snapshot.values)
      const next = { ...snapshot, values, revision: snapshot.revision + (changed ? 1 : 0) }
      const result: CommitResult = { status: changed ? 'committed' : 'no-change', snapshot: next }
      // No await between fresh capture and the synchronous atomic store commit.
      const cut = this.options.history.capture(target.sessionId)
      this.record(ctx.journal, ctx.progress, next, anchor(cut, 'before'), valid.source.identity, operation.operationId, valid.payload, result.status, snapshot.revision)
      ctx.progress.observed = prefixes(cut); ctx.progress.receipts.push({ key, payload: valid.payload, result })
      this.save(ctx.journal); if (changed) this.notify(target, next)
      return freeze(clone(result))
    })
  }
  subscribe(target: Target, listener: (snapshot: Snapshot) => void): () => void {
    this.guard(); const key = targetKey(target); const set = this.listeners.get(key) ?? new Set()
    set.add(listener); this.listeners.set(key, set)
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(key) }
  }
  planConfiguration(roleId: string, next: RoleDynamicsConfig, renames: Record<string, string> = {}) {
    this.guard(); const old = this.config(roleId)
    if (!old) return fail('$.config', '旧配置缺失')
    const journal = this.load(roleId)
    if (journal.pendingConfigRevision !== undefined && journal.pendingConfigRevision !== digest(old)) return fail('$.configRevision', '角色配置与重置事务尚未对齐', 'incompatible')
    const snapshots = journal.progress.flatMap(progress => [...progress.records, ...progress.turns]).flatMap(item => {
      try { return [this.migrate(journal, item.snapshot, digest(old))] } catch (error) {
        // Only an explicit reset may isolate an unreachable historical configuration.
        if (item.isolatedByReset && error instanceof DynamicsError && error.code === 'incompatible') return []
        throw error
      }
    })
    return planEvolution(old, next, snapshots.map(snapshot => ({ progressId: snapshot.progressId, values: snapshot.values })), renames)
  }
  /** Persist migration evidence before the outer ROLE.md transaction publishes its new definition. */
  approveEvolution(roleId: string, next: RoleDynamicsConfig, renames: Record<string, string> = {}): Promise<void> {
    return this.run(() => this.approveEvolutionNow(roleId, next, renames))
  }
  private approveEvolutionNow(roleId: string, next: RoleDynamicsConfig, renames: Record<string, string>) {
      const plan = this.planConfiguration(roleId, next, renames)
      if (!plan.compatible) return fail('$.evolution', '需要重置该角色进度后应用', 'incompatible')
      const old = this.config(roleId)!; const journal = this.load(roleId); const from = digest(old); const to = digest(plan.config)
      const alignedReset = journal.pendingConfigRevision !== undefined
      delete journal.pendingConfigRevision
      if (from === to) { if (alignedReset) this.save(journal); return }
      journal.configs[from] = old; journal.configs[to] = plan.config
      if (!journal.evolutions.some(edge => edge.from === from && edge.to === to)) journal.evolutions.push({ from, to, renames: clone(renames) })
      for (const progress of journal.progress) for (const turn of progress.turns) if (!turn.result) turn.revoked = true
      this.save(journal)
  }
  resetRole(roleId: string, next?: RoleDynamicsConfig): Promise<void> {
    return this.run(() => this.resetRoleNow(roleId, next))
  }
  private async resetRoleNow(roleId: string, next?: RoleDynamicsConfig): Promise<void> {
      if (this.blockedRoles.has(roleId)) return fail('$.target', '角色进度已回收', 'stale')
      const definition = clone(this.options.config(roleId))
      const config = next === undefined ? this.config(roleId) : validateConfig(next)
      if (!config) return fail('$.config', '配置缺失')
      const before = this.load(roleId)
      // Capture every reset boundary before awaiting any host flush. A turn that
      // completes during that wait belongs to the invalidated, open-turn side.
      const boundaries = [...new Set(before.progress.map(progress => progress.sessionId))].map(sessionId => {
        const cut = clone(this.options.history.capture(sessionId)); prefixes(cut)
        if (cut.header.id !== sessionId) return fail('$.history', '源会话身份不匹配', 'history')
        const progress = before.progress.findLast(item => item.sessionId === sessionId)!
        return { sessionId, cut, settle: progress.turns.some(turn => !turn.result && !turn.revoked && turnEnd(cut, turn.start.seq)) }
      })
      for (const boundary of boundaries) {
        if (!boundary.settle) continue
        const durable = await this.durable({ roleId, sessionId: boundary.sessionId }, this.lifecycle, this.epoch)
        if (durable.header.id !== boundary.sessionId || prefixes(durable)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) {
          return fail('$.history', '重置前的历史尚未持久化或已变化', 'history')
        }
      }
      this.guard()
      if (this.blockedRoles.has(roleId)) return fail('$.target', '角色进度已回收', 'stale')
      if (digest(this.options.config(roleId) ?? null) !== digest(definition ?? null)) return fail('$.configRevision', '配置已变化', 'conflict')
      // Reload after awaits so synchronous invalidation cannot be overwritten.
      const journal = this.load(roleId); journal.configs[digest(config)] = config
      if (next !== undefined) journal.pendingConfigRevision = digest(config)
      for (const boundary of boundaries) {
        const { sessionId } = boundary; const target = { roleId, sessionId }; const cut = this.options.history.capture(sessionId)
        if (cut.header.id !== sessionId || prefixes(cut)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) {
          return fail('$.history', '重置前的历史已变化', 'history')
        }
        if (boundary.settle) {
          const old = definition === undefined ? config : validateConfig(definition)
          const previous = this.ensure(journal, target, boundary.cut, old)
          this.settle(journal, previous, boundary.cut, old)
        }
        this.sealSession(journal, sessionId, prefixes(cut))
        for (const previous of journal.progress.filter(item => item.sessionId === sessionId)) {
          for (const item of [...previous.records, ...previous.turns]) {
            try { this.migrate(journal, item.snapshot, digest(config)) } catch (error) {
              if (!(error instanceof DynamicsError) || error.code !== 'incompatible') throw error
              item.isolatedByReset = true
            }
          }
        }
        const progress = this.newProgress(target, cut)
        this.record(journal, progress, this.snapshot(target, progress, config), anchor(cut, 'before'), 'owner', this.id(), '', 'committed', 0)
        journal.progress.push(progress)
      }
      // Settlement, historical evidence and reset are one atomic journal write.
      for (const progress of journal.progress) for (const turn of progress.turns) if (!turn.result) turn.revoked = true
      this.save(journal); this.invalidateHandles(roleId)
  }
  /** Trusted data-layer boundary: ROLE.md and journal recovery share the existing queue.
   * The scoped port expires before queued model/user operations can resume. */
  withRolePersistence<T>(roleId: string, body: (port: RolePersistencePort) => Promise<T>): Promise<T> {
    return this.run(async () => {
      let active = true
      const guard = () => { this.guard(); if (!active) fail('$.transaction', '事务句柄已失效', 'stale') }
      const port: RolePersistencePort = {
        guard,
        prepare: () => { guard(); return this.preparePersistence(roleId, guard) },
        plan: (next, renames = {}) => { guard(); return this.planConfiguration(roleId, next, renames) },
        approve: (next, renames = {}) => { guard(); this.approveEvolutionNow(roleId, next, renames) },
        reset: next => { guard(); return this.resetRoleNow(roleId, next) },
        invalidate: () => { guard(); this.invalidateTarget(roleId) },
        detach: stamp => {
          guard(); this.invalidateTarget(roleId); this.blockedRoles.add(roleId)
          this.options.store.detach(roleId, stamp, guard)
        },
        restore: stamp => { guard(); this.options.store.restore(roleId, stamp, guard); this.blockedRoles.delete(roleId) },
        release: () => { guard(); this.blockedRoles.delete(roleId) },
      }
      try { return await body(port) } finally { active = false }
    })
  }
  /** Freeze the operation boundary before any flush. Keep completed history recoverable
   * even if preparation fails, and persist it before the outer rollback backup. */
  private async preparePersistence(roleId: string, guard: () => void): Promise<void> {
    if (this.blockedRoles.has(roleId)) return fail('$.target', '角色进度已回收', 'stale')
    const definition = this.config(roleId)
    const before = this.load(roleId)
    const boundaries = [...new Set(before.progress.map(progress => progress.sessionId))].map(sessionId => {
      const cut = clone(this.options.history.capture(sessionId)); prefixes(cut)
      if (cut.header.id !== sessionId) return fail('$.history', '源会话身份不匹配', 'history')
      return { sessionId, cut }
    })
    this.invalidateHandles(roleId)
    let revoked = false
    for (const progress of before.progress) {
      const cut = boundaries.find(boundary => boundary.sessionId === progress.sessionId)!.cut
      for (const turn of progress.turns) if (!turn.result && !turn.revoked && !turnEnd(cut, turn.start.seq)) {
        turn.revoked = true; revoked = true
      }
    }
    if (revoked) this.save(before)
    const ended = boundaries.filter(({ sessionId, cut }) => before.progress.some(progress => progress.sessionId === sessionId
      && progress.turns.some(turn => !turn.result && !turn.revoked && turnEnd(cut, turn.start.seq))))
    if (!ended.length) return
    for (const boundary of ended) {
      const durable = await this.durable({ roleId, sessionId: boundary.sessionId }, this.lifecycle, this.epoch)
      guard()
      if (durable.header.id !== boundary.sessionId || prefixes(durable)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) {
        return fail('$.history', '资料操作前的历史尚未持久化或已变化', 'history')
      }
    }
    guard()
    if (this.blockedRoles.has(roleId)) return fail('$.target', '角色进度已回收', 'stale')
    if (digest(this.config(roleId) ?? null) !== digest(definition ?? null)) return fail('$.configRevision', '配置已变化', 'conflict')
    if (!definition) return fail('$.config', '旧配置缺失')
    const journal = this.load(roleId)
    for (const boundary of ended) {
      const cut = this.options.history.capture(boundary.sessionId)
      if (cut.header.id !== boundary.sessionId || prefixes(cut)[boundary.cut.seq] !== prefixes(boundary.cut).at(-1)) {
        return fail('$.history', '资料操作前的历史已变化', 'history')
      }
      const progress = this.ensure(journal, { roleId, sessionId: boundary.sessionId }, boundary.cut, definition)
      this.settle(journal, progress, boundary.cut, definition)
    }
    this.save(journal)
  }
  private invalidateHandles(roleId: string, sessionId?: string) {
    for (const [token, entry] of this.handles) if (entry.target.roleId === roleId && (sessionId === undefined || entry.target.sessionId === sessionId)) this.handles.delete(token)
  }
  /** Stop an adapter without discarding rounds already closed before unload. */
  invalidateOpenTarget(target: Target): void {
    this.invalidateHandles(target.roleId, target.sessionId)
    const journal = this.load(target.roleId)
    if (!journal.progress.some(progress => progress.sessionId === target.sessionId && progress.turns.some(turn => !turn.result))) return
    const cut = this.options.history.capture(target.sessionId)
    let changed = false
    for (const progress of journal.progress) if (progress.sessionId === target.sessionId) {
      for (const turn of progress.turns) if (!turn.result && !turnEnd(cut, turn.start.seq)) {
        this.stoppedTurns.add(turn.id); turn.revoked = true; changed = true
      }
    }
    if (changed) this.save(journal)
  }
  invalidateTarget(roleId: string, sessionId?: string) {
    this.invalidateHandles(roleId, sessionId)
    const journal = this.load(roleId)
    if (!journal.progress.length) return
    for (const progress of journal.progress) if (sessionId === undefined || progress.sessionId === sessionId) {
      for (const turn of progress.turns) if (!turn.result) turn.revoked = true
    }
    this.save(journal)
  }
  clearCaches() { this.guard(this.epoch, this.lifecycle) /* Derived projections are not cached; durable receipts remain intact. */ }
  invalidate(epoch: string) {
    // Maintenance is a synchronous new lifecycle, independent of an old awaiting task.
    const active = this.active; this.active = undefined
    try {
      for (const roleId of this.knownRoles) this.invalidateTarget(roleId)
    } finally {
      this.epoch = epoch; this.lifecycle++; this.handles.clear(); this.sources.clear(); this.ai = this.source('ai', 'AI', 'ai'); this.active = active
    }
  }
  dispose() {
    if (this.disposed) return
    this.lifecycle++; this.handles.clear(); this.listeners.clear(); this.sources.clear()
    try {
      for (const roleId of this.knownRoles) {
        const journal = this.load(roleId); let changed = false
        for (const progress of journal.progress) for (const turn of progress.turns) if (!turn.result && !turn.revoked) { turn.revoked = true; changed = true }
        if (changed) this.options.store.save(roleId, journal, () => { if (this.disposed) fail('$.lifecycle', '已停用', 'stale') })
      }
    } finally { this.disposed = true }
  }
  detachRole(roleId: string, stamp: string): Promise<void> {
    this.invalidateTarget(roleId)
    const alreadyBlocked = this.blockedRoles.has(roleId)
    this.blockedRoles.add(roleId)
    return this.run(() => {
      try { this.options.store.detach(roleId, stamp, () => this.guard()) } catch (error) {
        // A readable original proves the move did not consume the authority.
        // Absence or an unreadable original keeps the gate closed for explicit restore.
        if (!alreadyBlocked && this.options.store.load(roleId) !== undefined) this.blockedRoles.delete(roleId)
        throw error
      }
    })
  }
  restoreRole(roleId: string, stamp: string): Promise<void> {
    return this.run(() => { this.options.store.restore(roleId, stamp, () => this.guard()); this.blockedRoles.delete(roleId) })
  }
  readExtension(source: SourceHandle, target: Target): Promise<{ revision: number; values: Values } | undefined> {
    return this.run(async () => {
      const registered = this.authorize(source)
      if (registered.kind !== 'plugin') return fail('$.source', '需要插件来源', 'source')
      const ctx = await this.stableContext(target); this.authorize(source)
      const extension = ctx?.progress.extensions[digest(registered.identity)]
      return extension ? freeze({ revision: extension.revision, values: clone(extension.values) }) : undefined
    })
  }
  commitExtension(source: SourceHandle, target: Target, definition: RoleDynamicsConfig, operation: Omit<Operation, 'source'>): Promise<{ revision: number; values: Values }> {
    return this.run(async () => {
      const registered = this.authorize(source)
      if (registered.kind !== 'plugin') return fail('$.source', '需要插件来源', 'source')
      const config = validateConfig(definition)
      if (config.entries.length) return fail('$.extension', '私有扩展不含角色条件')
      const ctx = await this.stableContext(target); this.authorize(source)
      if (!ctx) return fail('$.target', '角色没有动态配置')
      if (!this.options.isSelected(target)) return fail('$.target', '角色选择已变化', 'conflict')
      const key = digest(registered.identity)
      const extension = ctx.progress.extensions[key] ?? { config, revision: 0, values: initialValues(config), receipts: [] }
      if (digest(extension.config) !== digest(config) || operation.configRevision !== digest(config)) return fail('$.configRevision', '扩展定义已变化', 'conflict')
      const snapshot = this.current(ctx.journal, ctx.progress, ctx.cut, ctx.config)
      // Private fields use owner-level field permissions inside the caller's partition.
      const valid = this.operation({ ...operation, source }, snapshot, config, false, 'owner')
      const changes = valid.changes; const payload = valid.payload
      const receipt = extension.receipts.find(item => item.key === operation.operationId)
      if (receipt) {
        if (receipt.payload !== payload) return fail('$.operationId', '操作标识冲突', 'conflict')
        return freeze({ revision: receipt.result.snapshot.revision, values: clone(receipt.result.snapshot.values) })
      }
      if (operation.baseRevision !== extension.revision) return fail('$.baseRevision', '扩展状态已变化', 'conflict')
      const values = clone(extension.values); changes.forEach(change => { values[change.name] = change.value })
      const changed = digest(values) !== digest(extension.values)
      extension.values = values; extension.revision += changed ? 1 : 0
      const next = { ...snapshot, configRevision: digest(config), revision: extension.revision, values }
      extension.receipts.push({ key: operation.operationId, payload, result: { status: changed ? 'committed' : 'no-change', snapshot: next } })
      ctx.progress.extensions[key] = extension; this.save(ctx.journal)
      return freeze({ revision: extension.revision, values: clone(values) })
    })
  }
}

export { DynamicsError }
