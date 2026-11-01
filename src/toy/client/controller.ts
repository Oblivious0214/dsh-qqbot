/**
 * 浏览器端的联动控制：把 dsh-qqbot 的显示时钟、用户输入、急停和运动播放器接在一起。
 * 只有本文件决定"哪个会话在驱动设备"；界面只读快照、调方法。
 *
 * - 一台设备同一时间只驱动一个会话（owner）。在另一个会话里点"接入对话"时，先让原会话退出联动。
 * - qqbot 每显示一段，按这一段的 motion 开始、改变或停止（resolveStageIntents 的规则，逐段增量算）。
 * - 设备按 AI 动作运动时，段落按“段落间隔”停留（写了新动作的停满，接续段只停到读完）；AI 动作一直重复，持续多久由看门狗决定。
 * - 回复格式坏了（段落标 salvaged，或以 failed 结束）时立即停止；后续能独立解析的有效动作仍可执行。
 * - 暂停按钮和暂停快捷键：设备和文字一起停，"继续"按钮或恢复快捷键之后，设备从未知位置限速重新进入，文字接着走剩余时间。
 * - 可选安全词直接降低当前速度，下一条 AI 回复接管；急停仍用暂停按钮或快捷键。
 * - 播放器自己的停止（看门狗、断开、出错）见 player.ts。
 *
 * 状态行（qqbot:runtime 的 device）只在用户操作和连接变化时改，见 core/rules.ts。
 */

import { DEFAULT_BURST, type BurstSettings, type ToyAction, type ToySessionView, type ToySettings, type ToyView } from '../api-types.ts'
import { liveMotion, manualPosition, NO_ADJUST, type LiveAdjust, type LiveMotion } from '../core/motion.ts'
import type { MotionConfig } from '../core/config.ts'
import { matchesHotkey, type KeyLike } from '../core/hotkey.ts'
import { AUTO_ACTION, RANGE_LABELS, TIER_LABELS, reduceIntent, type Intent } from '../core/intent.ts'
import { resolveStageIntents } from '../core/replies.ts'
import type { DeviceStatus } from '../core/rules.ts'
import type { ToyApi } from './api.ts'
import { MotionPlayer, realClock, type Clock, type ProgramKind, type StopCause } from './player.ts'
import type { Transport, TransportState } from './transport.ts'
import { describeAction, type Annotate, type TailPlayback } from './stage-display.ts'
import { readInterruptionHistory, writeInterruptionHistory } from './interruption-history.ts'
import { mergeActionLibrary, mergeSettings } from './settings-merge.ts'
import type { ActionLibrary } from '../motion-library/config.ts'
import { slowerSpeed } from '../core/safety-words.ts'
import { DEFAULT_PACING, pacingHold, parsePacing, type MotionPacing } from '../core/pacing.ts'
import { SafetyWordInput } from './safety-word-input.ts'

/** dsh-qqbot 浏览器端服务 `qqbotSegments` 中用到的部分。按结构声明，不引用 dsh-qqbot 的代码。 */
export interface SegmentStage {
  readonly text: string
  readonly motion?: unknown
  readonly salvaged?: true
}
export type SegmentEndReason = 'complete' | 'interrupted' | 'failed' | 'closed'
export interface SegmentHooks {
  durations?(session: string, reply: string, stages: readonly SegmentStage[], index: number): number | undefined
  revealed?(session: string, reply: string, index: number, stage: SegmentStage, holdMs: number | undefined): void
  ended?(session: string, reply: string, reason: SegmentEndReason): void
}
export interface QqbotSegments {
  annotate?: Annotate
  register(hooks: SegmentHooks): () => void
  pause(session: string): () => void
}

export type TransportKind = Transport['kind']
/** 浏览器本页的执行结果；不写入提示词或持久化设置。 */
export type ToyActivity = 'waiting' | 'no-motion' | 'model-stop' | 'moving' | 'invalid' | 'timeout' | 'error'

/** 右栏高潮／温存阶段，由程序驱动设备；期间 AI 回复只出字，不执行动作。 */
export interface BurstPhase {
  readonly kind: 'burst' | 'aftercare'
}

export interface ControllerOptions {
  readonly api: ToyApi
  readonly transport: (kind: TransportKind) => Transport
  readonly kind: TransportKind
  readonly clock?: Clock
}

export interface ToySnapshot {
  readonly actionLibrary?: ActionLibrary
  readonly enabled: boolean
  readonly conflict: string
  /** host 设置；还没读到时为 undefined。 */
  readonly settings: ToySettings | undefined
  readonly loadError: string
  /** dsh-qqbot 的 host 端在场。 */
  readonly qqbot: boolean
  /** dsh-qqbot 的浏览器端时钟在场。没有它时段落动作不会执行。 */
  readonly segments: boolean
  readonly kind: TransportKind
  readonly transport: TransportState
  /** 正在驱动设备的会话。 */
  readonly owner: string | undefined
  readonly ownerView: ToySessionView | undefined
  readonly paused: boolean
  /** 设备正在按某个选择运动（暂停时为 false）。 */
  readonly moving: boolean
  readonly activity: ToyActivity
  /** 最近一条给用户看的说明，例如"等不到下一段动作，已自动停止"。 */
  readonly notice: string
  readonly noticeSession: string | undefined
  readonly syncWarning: string
  readonly busy: boolean
  /** 本场实际参数，切换接入会话或刷新页面后清空。 */
  readonly adjust: LiveAdjust
  /** 设备运动时的段落间隔，设置页和右栏共用。 */
  readonly pacing: MotionPacing
  readonly liveMotion: LiveMotion | undefined
  readonly phase: BurstPhase | undefined
  /** 播放器当前由谁驱动。 */
  readonly mode: ProgramKind | 'ai'
}

interface Run {
  /** 这条回复开始时本会话的选择。 */
  readonly start: Intent | null
  current: Intent | null
  lastIndex: number
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const motionError = (error: unknown): string => {
  const detail = messageOf(error)
  if (detail === 'motion 须为对象') return '动作内容不是可解析的动作结构'
  if (detail === 'motion.range 无效') return '动作范围不受支持'
  if (detail === 'motion.tier 无效') return '速度档位不受支持'
  if (detail === 'motion.action 无效') return '动作类型不受支持'
  if (detail.includes('首次启动或停止后')) return '首次启动或停止后，需要完整的范围、速度档位和动作类型'
  if (detail.includes('motion 只接受')) return '动作含有不支持的字段，或把停止与运动参数混在一起'
  return detail
}
const runKey = (session: string, reply: string) => `${session}\u0000${reply}`

export class ToyController {
  private settings: ToySettings | undefined
  private actionLibrary: ActionLibrary | undefined
  private loadError = ''
  private conflict = ''
  private epoch = 0
  private connectionAttempt = 0
  private controlEpoch: string | undefined
  private readonly watchAbort = new AbortController()
  private qqbot = false
  private segments: QqbotSegments | undefined
  private kind: TransportKind
  private transport: Transport
  private player: MotionPlayer
  private unsubscribe: () => void
  private owner: string | undefined
  private ownerView: ToySessionView | undefined
  private paused = false
  private releaseText: (() => void) | undefined
  /** 本会话最近已显示段落的选择。新回复第一段没写 motion 时沿用它。 */
  private previous: Intent | null = null
  private readonly runs = new Map<string, Run>()
  /** 本页解析结果的只读副本，不参与运动决策；保留结束后的标注。 */
  private readonly annotations = new Map<string, Map<number, string>>()
  private lastStage: { key: string; index: number; tail: boolean; holdMs: number | undefined; interrupted?: boolean } | undefined
  private effective: MotionConfig | undefined
  private notice = ''
  private noticeSession: string | undefined
  private syncWarning = ''
  /** 每个会话仅保留最近一次原因，标签页内刷新可回看；不进入模型或角色资料。 */
  private readonly interruptions = readInterruptionHistory()
  private activity: ToyActivity = 'waiting'
  private busy = 0
  private draftGeneration = 0
  private viewRevision: number | undefined
  private readonly retiredControlEpochs = new Set<string>()
  get settingsDraftGeneration(): number { return this.draftGeneration }
  /** 上一次报给 host 的状态和排队中的请求，保证按顺序到达。 */
  private posted: DeviceStatus | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private snapshot: ToySnapshot | undefined
  private disposed = false
  private adjust: LiveAdjust = NO_ADJUST
  private phase: BurstPhase | undefined
  private safetyInput = new SafetyWordInput()
  private safetySpeed: number | undefined
  private readonly safetyReplies = new Set<string>()

  constructor(private readonly options: ControllerOptions) {
    this.kind = options.kind
    this.transport = options.transport(this.kind)
    this.player = this.createPlayer()
    this.unsubscribe = this.follow()
  }

  // ---- 快照 ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ToySnapshot => {
    this.snapshot ??= {
      enabled: !this.disposed && this.settings !== undefined && this.settings.enabled !== false && this.conflict === '', conflict: this.conflict,
      settings: this.settings, loadError: this.loadError, qqbot: this.qqbot, segments: this.segments !== undefined,
      ...this.actionLibrary === undefined ? {} : { actionLibrary: this.actionLibrary },
      kind: this.kind, transport: this.transport.state, owner: this.owner, ownerView: this.ownerView,
      paused: this.paused, moving: this.player.intent !== null && !this.player.paused,
      activity: this.activity,
      notice: this.notice, noticeSession: this.noticeSession, syncWarning: this.syncWarning, busy: this.busy > 0,
      adjust: this.adjust, pacing: this.pacing, liveMotion: this.effective === undefined ? undefined : { ...liveMotion(this.player.intent, this.effective, this.adjust), speed: this.player.targetSpeed },
      phase: this.phase, mode: this.player.mode,
    }
    return this.snapshot
  }

  private notify(): void {
    this.snapshot = undefined
    for (const listener of [...this.listeners]) listener()
  }

  private say(notice: string, session: string | undefined | null = this.owner): void {
    this.notice = notice
    this.noticeSession = session ?? undefined
    this.notify()
  }

  private report(reason: string, session: string | undefined | null = this.owner): void {
    if (session != null) {
      this.interruptions.delete(session)
      this.interruptions.set(session, reason)
      if (this.interruptions.size > 200) this.interruptions.delete(this.interruptions.keys().next().value!)
      writeInterruptionHistory(this.interruptions)
    }
    this.say(reason, session)
  }

  lastInterruption(session: string): string | undefined { return this.interruptions.get(session) }

  clearNotice(): void {
    if (this.notice !== '') this.say('')
  }

  // ---- 设置 ----

  async load(): Promise<void> {
    const epoch = this.epoch
    try {
      const view = await this.options.api.get(this.owner)
      if (this.disposed || epoch !== this.epoch) return
      this.loadError = ''
      if (!this.acceptView(view)) return
      if (this.owner !== undefined) this.acceptOwner(view.session)
    } catch (error) {
      if (this.disposed || epoch !== this.epoch) return
      this.loadError = `读取设置失败：${messageOf(error)}`
    }
    this.notify()
  }

  /** Serialize the mutation itself, so each edit reads the last accepted snapshot. */
  async updateSettings(update: (latest: ToySettings) => ToySettings): Promise<void> {
    const epoch = this.epoch
    await this.post(() => {
      if (this.disposed || epoch !== this.epoch || this.settings === undefined) throw new Error('设置已变化，请重新打开设置')
      return { action: 'settings.save', settings: update(this.settings) }
    }, view => {
      if (!this.disposed && epoch === this.epoch) this.acceptView(view)
    })
    if (this.owner !== undefined && !this.disposed && epoch === this.epoch) await this.refreshOwner()
    this.notify()
  }

  /** Existing callers also submit only their changes, not a stale full snapshot. */
  async saveSettings(next: ToySettings): Promise<void> {
    const base = this.settings
    if (base === undefined) throw new Error('联动设置尚未就绪')
    await this.updateSettings(latest => mergeSettings(base, next, latest))
  }

  async saveActionLibrary(next: ActionLibrary, base = this.actionLibrary): Promise<void> {
    const epoch = this.epoch
    await this.post(() => {
      if (this.disposed || epoch !== this.epoch || this.actionLibrary === undefined || base === undefined) throw new Error('动作库尚未就绪')
      const library = mergeActionLibrary(base, next, this.actionLibrary)
      return { action: 'library.save', library: { ...library, revision: this.actionLibrary.revision } }
    }, view => {
      if (!this.disposed && epoch === this.epoch) this.acceptView(view)
    })
    this.notify()
  }

  /** 关闭先在本页同步停止，再持久化。保存失败也不会恢复连接或动作。 */
  async setEnabled(enabled: boolean): Promise<void> {
    const previous = this.settings
    if (previous === undefined || this.disposed) throw new Error('联动设置尚未就绪')
    const session = this.owner
    this.quiesce(enabled ? '联动重新启用前已停止旧动作；请手动连接设备并接入对话。' : '用户关闭联动：本页已停止发动作、断开设备并退出对话。')
    const epoch = this.epoch
    this.settings = { ...previous, enabled: false }
    this.notify()
    try {
      const view = await this.post({ action: 'module.enable', enabled })
      if (this.disposed || epoch !== this.epoch) return
      this.acceptView(view)
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) {
        this.settings = previous
        this.report(`联动开关保存失败：${messageOf(error)}。本页仍保持停止和断开；请重试保存。`, session)
      }
      throw error
    }
    this.notify()
  }

  clearCache(): void { this.interruptions.clear(); writeInterruptionHistory(this.interruptions); this.notify() }
  resetForCleanup(): void { this.draftGeneration++; this.quiesce('QQ Bot 数据已清理，设备已停止并断开。'); this.clearCache() }

  private quiesce(reason: string): void {
    this.epoch++
    const session = this.owner
    const active = session !== undefined || this.transport.state.phase !== 'disconnected'
    const previousNotice = this.notice, previousSession = this.noticeSession
    this.dropOwner('')
    this.transport.disconnect()
    if (active) this.report(reason, session)
    else this.say(previousNotice, previousSession)
    if (session !== undefined) this.options.api.beacon({ action: 'session.detach', session })
  }

  private acceptView(view: ToyView): boolean {
    // A delayed GET/watch must not undo a newer accepted save. Epoch changes allow
    // host restarts to begin a fresh revision sequence, but never revisit a retired one.
    if (view.controlEpoch !== undefined && this.retiredControlEpochs.has(view.controlEpoch)) return false
    if (view.controlEpoch === this.controlEpoch && view.revision !== undefined
      && this.viewRevision !== undefined && view.revision < this.viewRevision) return false
    if (view.controlEpoch !== this.controlEpoch) {
      if (this.controlEpoch !== undefined) this.retiredControlEpochs.add(this.controlEpoch)
      this.viewRevision = undefined
    }
    if (view.revision !== undefined) this.viewRevision = view.revision
    const reset = view.controlEpoch !== undefined && this.controlEpoch !== undefined && view.controlEpoch !== this.controlEpoch
    this.controlEpoch = view.controlEpoch
    this.conflict = view.conflict ?? ''
    const reason = this.conflict !== '' ? `旧独立联动插件冲突：${this.conflict} 本页已停止并断开。`
      : view.settings.enabled === false ? '联动总开关已关闭，本页已停止并断开；重新开启后需手动连接和接入。'
        : !view.settings.authorized ? '联动授权已撤回，本页已停止并断开；重新授权后需手动连接和接入。'
          : reset ? '后台控制状态已重置，旧动作已停止并断开。可能是宿主重启或联动曾被关闭再开启；请手动连接并接入。' : ''
    if (reason !== '' && (reset || this.owner !== undefined || this.transport.state.phase !== 'disconnected')) {
      this.quiesce(reason)
    }
    this.actionLibrary = view.actionLibrary
    this.accept(view.settings, view.qqbot)
    return true
  }

  /** 跨页面长轮询。失去同步时停止并断开，不自动恢复设备连接。 */
  async watch(): Promise<void> {
    const watch = this.options.api.watch
    if (watch === undefined) return
    let revision = -1
    while (!this.disposed) {
      const epoch = this.epoch
      try {
        const view = await watch(revision, this.watchAbort.signal)
        if (this.disposed) return
        if (epoch !== this.epoch) { revision = -1; continue }
        revision = view.revision ?? -1
        this.loadError = ''
        if (!this.acceptView(view)) { revision = this.viewRevision ?? -1; continue }
        this.notify()
      } catch (error) {
        if (this.disposed) return
        const detail = error instanceof Error && error.name === 'TimeoutError' ? '后台状态请求超过 25 秒未返回' : messageOf(error)
        this.quiesce(`联动同步已中断：${detail}。本页已停止并断开；同步恢复后仍需手动连接和接入。`)
        this.loadError = `联动同步已中断：${detail}。请检查 DSH 后台连接。`
        this.notify()
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.watchAbort.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, 1000)
          this.watchAbort.signal.addEventListener('abort', done, { once: true })
        })
        revision = -1
      }
    }
  }

  private accept(settings: ToySettings, qqbot: boolean): void {
    if (this.settings?.authorized && !settings.authorized) this.draftGeneration++
    this.settings = settings
    this.qqbot = qqbot
    this.applyConfig()
  }

  /** 控制层只执行已保存的用户限制；未来蓝牙的机内范围约束由设置层负责。 */
  private applyConfig(): void {
    if (this.settings === undefined) return
    const changed = this.effective !== undefined && JSON.stringify(this.effective) !== JSON.stringify(this.settings.motion)
    const restarting = changed && this.player.intent !== null && !this.player.paused
    this.effective = this.settings.motion
    this.player.configureLibrary(this.actionLibrary)
    this.player.configure(this.effective)
    if (restarting) this.report('运动参数已更新：已短暂停止旧动作，并按新的用户限制重新起步。')
  }

  // ---- 连接 ----

  /** 换连接方式，只能在断开时换。 */
  select(kind: TransportKind): void {
    if (kind === this.kind) return
    if (this.transport.state.phase !== 'disconnected') throw new Error('请先断开设备再换连接方式')
    this.unsubscribe()
    this.player.dispose()
    this.kind = kind
    this.transport = this.options.transport(kind)
    this.player = this.createPlayer()
    this.unsubscribe = this.follow()
    this.applyConfig()
    this.notify()
  }

  async connect(address?: string): Promise<void> {
    if (!this.getSnapshot().enabled) throw new Error(this.conflict || '联动已关闭')
    if (this.settings?.authorized !== true) throw new Error('请先完成首次授权')
    const epoch = this.epoch
    const attempt = ++this.connectionAttempt
    this.clearNotice()
    try {
      await this.track(this.transport.connect(address))
      if (this.disposed || epoch !== this.epoch) this.transport.disconnect()
    } catch (error) {
      if (this.disposed || epoch !== this.epoch || attempt !== this.connectionAttempt) return
      if (this.transport.state.error === '') this.say(messageOf(error))
    }
  }

  /** 断开设备。会话保持接入，状态变成"未连接"；重新连上后恢复。 */
  disconnect(): void {
    this.connectionAttempt++
    const connecting = this.transport.state.phase === 'connecting'
    this.transport.disconnect()
    this.report(connecting ? '用户取消了设备连接；需要时可重新连接。' : '用户主动断开设备，已停止继续发动作；重新连接后等待新的有效动作。')
  }

  private createPlayer(): MotionPlayer {
    return new MotionPlayer(this.transport, {
      onStop: (cause, error) => { this.stopped(cause, error) },
      stopFailureHandler: () => {
        const session = this.owner
        return error => {
          if (session === this.owner) this.activity = 'error'
          this.report(`停止指令发送失败：${error.message}。无法确认设备已停下，请检查设备端并手动停止。`, session ?? null)
        }
      },
    }, this.options.clock ?? realClock)
  }

  private follow(): () => void {
    return this.transport.subscribe(() => {
      this.applyConfig()
      this.syncStatus()
      this.notify()
    })
  }

  private stopped(cause: StopCause, error: Error | undefined): void {
    const ended = this.player.endedMode
    if (cause === 'burst-end' && this.phase !== undefined) { this.burstEnded(); return }
    if (cause === 'aftercare-end' && this.phase !== undefined) {
      this.phase = undefined
      this.activity = 'waiting'
      this.report('温存已结束，设备已停下；等待 AI 的下一段动作。')
      return
    }
    // 设备阶段被其他原因（断开、出错、超时）中止时，阶段一起结束。
    if (this.phase !== undefined && ended !== 'ai') this.phase = undefined
    if (cause === 'timeout' && ended === 'manual') {
      this.activity = 'timeout'
      this.report('手动定位已保持 30 秒，已自动停止；等待 AI 的下一段动作。')
      return
    }
    // 超时不清选择：AI 不知道已经超时，下一条回复只写变化项时仍按原来的选择补全（同旧插件）。
    if (cause !== 'timeout') this.previous = null
    this.activity = cause === 'timeout' ? 'timeout' : cause === 'error' || cause === 'stop-error' ? 'error' : 'waiting'
    const stage = this.lastStage === undefined ? '' : `第 ${this.lastStage.index + 1} 段`
    if (cause === 'error') this.report(`${stage}动作执行已中断：${error?.message ?? '未提供具体原因'}。请检查动作与用户限制，等待后续有效动作。`)
    else if (cause === 'stop-error') this.report(`停止指令发送失败：${error?.message ?? '未提供具体原因'}。无法确认设备已停下，请检查设备端并手动停止。`)
    else if (cause === 'complete') this.report('单次动作片段已播放完成。')
    else if (cause === 'timeout') this.report(this.lastStage?.tail
      ? `${stage}为末段，已到 ${this.settings?.motion.autoStopSeconds ?? 30} 秒保护时限，已自动停止；等待后续有效动作。`
      : `${this.lastStage?.interrupted ? '该回复剩余段落已被新消息打断；' : ''}${stage}之后未等到下一段，超过预计间隔 ${((this.lastStage?.holdMs ?? 0) / 1000).toFixed(1)} 秒加 5 秒保护余量，已自动停止；等待后续有效动作。`)
    else if (cause === 'disconnected') {
      const state = this.transport.state
      this.report(state.phase === 'waiting'
        ? `设备已不可用：${state.error || state.message}。已停止继续发动作；恢复可用后等待新的有效动作。`
        : `设备连接已断开：${state.error || state.message || '连接状态已改变'}。已停止继续发动作；请手动重连。`)
    }
    this.notify()
  }

  // ---- 接入和暂停 ----

  /** 在这个会话里接入对话。别的会话在驱动设备时，先让它退出。 */
  async attach(session: string): Promise<void> {
    if (!this.getSnapshot().enabled) throw new Error(this.conflict || '联动已关闭')
    const epoch = this.epoch
    if (this.settings?.authorized !== true) throw new Error('请先完成首次授权')
    if (this.transport.state.phase !== 'ready') throw new Error('请先连接设备并等它就绪')
    if (this.owner !== undefined && this.owner !== session) await this.detach('设备联动已转交另一个对话，本会话已停止并退出。')
    const view = await this.post({ action: 'session.attach', session, status: 'ready' })
    if (this.disposed || epoch !== this.epoch || !this.getSnapshot().enabled) {
      this.options.api.beacon({ action: 'session.detach', session }); return
    }
    this.dropOwner('')
    this.owner = session
    this.posted = 'ready'
    this.acceptOwner(view.session)
    this.say('')
  }

  /** 退出联动：设备停下，规则从这个会话的提示词里去掉。 */
  async detach(reason = '用户退出当前对话的联动，动作已停止；重新接入后等待新的有效动作。'): Promise<void> {
    const session = this.owner
    if (session === undefined) return
    this.dropOwner(reason)
    await this.post({ action: 'session.detach', session })
  }

  /** 暂停按钮和暂停快捷键：设备和文字一起停。 */
  pause(notice = '已通过暂停按钮暂停设备和分段文字；点击“继续设备”恢复。'): void {
    if (this.owner === undefined || this.paused) return
    this.paused = true
    // 手动定位不保留：暂停后设备停在原位，恢复时等 AI 的下一段动作。
    if (this.player.mode === 'manual') this.player.stop('user')
    this.player.pause()
    this.releaseText ??= this.segments?.pause(this.owner)
    this.report(notice)
    this.syncStatus()
    this.notify()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.notice = ''
    this.releaseText?.()
    this.releaseText = undefined
    if (this.transport.state.phase === 'ready') this.player.resume()
    this.syncStatus()
    this.notify()
  }

  /** 本页不再驱动这个会话。只改本地状态，不通知 host。 */
  private dropOwner(notice: string): void {
    const session = this.owner
    this.player.stop('user')
    this.previous = null
    this.releaseText?.()
    this.releaseText = undefined
    this.owner = undefined
    this.ownerView = undefined
    this.posted = undefined
    this.syncWarning = ''
    this.paused = false
    this.runs.clear()
    this.lastStage = undefined
    this.activity = 'waiting'
    this.adjust = NO_ADJUST
    this.player.setAdjust(NO_ADJUST)
    this.phase = undefined
    this.safetyInput = new SafetyWordInput()
    this.safetySpeed = undefined
    this.safetyReplies.clear()
    this.player.setSpeedLimit(undefined)
    if (notice !== '') this.report(notice, session)
    else this.say('', session)
  }

  private acceptOwner(view: ToySessionView | undefined): void {
    if (view === undefined) return
    if (!view.attached) {
      this.dropOwner('后台确认本会话已退出联动，本页动作已停止；需要时请重新接入。')
      return
    }
    this.ownerView = view
  }

  private async refreshOwner(): Promise<void> {
    const session = this.owner
    if (session === undefined) return
    const view = await this.options.api.get(session)
    if (this.owner === session) this.acceptOwner(view.session)
  }

  private status(): DeviceStatus {
    if (this.transport.state.phase !== 'ready') return 'disconnected'
    return this.paused ? 'paused' : 'ready'
  }

  /** 设备状态变了就报给 host（进 qqbot:runtime 的 device 行）。按顺序发，失败时重读会话。 */
  private syncStatus(): void {
    const session = this.owner
    if (session === undefined) return
    const status = this.status()
    if (status === this.posted) return
    this.posted = status
    void this.post({ action: 'session.status', session, status }).then(
      (view) => { if (this.owner === session) { this.syncWarning = ''; this.acceptOwner(view.session); this.notify() } },
      async (error: unknown) => {
        if (this.owner !== session) return
        this.posted = undefined
        this.syncWarning = `上次设备状态未同步到对话：${messageOf(error)}。这次上报失败本身没有触发停止。`
        this.notify()
        await this.refreshOwner().catch(() => {})
      },
    )
  }

  private post(action: ToyAction | (() => ToyAction), accept?: (view: ToyView) => void) {
    const next = this.queue.catch(() => {}).then(() => this.options.api.post(typeof action === 'function' ? action() : action)).then(view => { accept?.(view); return view })
    this.queue = next
    return this.track(next)
  }

  private async track<T>(promise: Promise<T>): Promise<T> {
    this.busy++
    this.notify()
    try {
      return await promise
    } finally {
      this.busy--
      if (!this.disposed) this.notify()
    }
  }

  // ---- 右栏本场控制 ----

  /** 只由 QQ 会话的发送回显／用户消息观察器调用，草稿和 AI 文字不进入这里。 */
  observeInput(session: string, chat: string, submissions: string): void {
    if (!this.driving(session)) return
    this.safetyInput.observe(chat, submissions, (text, replies) => { this.safetyWord(session, text, replies) })
  }

  private safetyWord(session: string, text: string, replies: readonly string[]): void {
    const options = this.settings?.safetyWords
    if (!options?.enabled || !options.words.some(word => text.toLocaleLowerCase().includes(word.toLocaleLowerCase()))) return
    if (!this.canControl() || this.player.intent === null || this.effective === undefined) return
    for (const reply of replies) this.safetyReplies.add(runKey(session, reply))
    for (const key of this.runs.keys()) this.safetyReplies.add(key)
    if (this.lastStage !== undefined) this.safetyReplies.add(this.lastStage.key)
    while (this.safetyReplies.size > 500) this.safetyReplies.delete(this.safetyReplies.keys().next().value!)
    this.safetySpeed = slowerSpeed(this.player.targetSpeed, this.effective)
    this.player.setSpeedLimit(this.safetySpeed)
    this.phase = undefined
    this.say('已降一档速度，等待 AI 的新回复接管。')
  }

  get burstSettings(): BurstSettings { return this.settings?.burst ?? DEFAULT_BURST }

  /** 能否由右栏直接驱动：已接入、设备就绪、未暂停。 */
  private canControl(): boolean {
    return this.driving(this.owner ?? '') && this.transport.state.phase === 'ready' && !this.paused
  }

  /** 本场实际行程／速度：只改执行参数，不保存或上报给模型。 */
  setLiveMotion(patch: LiveAdjust): void {
    if (this.owner === undefined || this.effective === undefined) return
    if (patch.bounds !== undefined && (!patch.bounds.every(Number.isFinite) || patch.bounds[0] >= patch.bounds[1])) return
    if (patch.speed !== undefined && !Number.isFinite(patch.speed)) return
    const next = { ...this.adjust, ...patch }
    const actual = liveMotion(null, this.effective, next)
    this.adjust = { ...next, ...next.bounds === undefined ? {} : { bounds: actual.bounds }, ...next.speed === undefined ? {} : { speed: actual.speed } }
    this.player.setAdjust(this.adjust)
    this.notify()
  }

  private get pacing(): MotionPacing { return this.settings?.pacing ?? DEFAULT_PACING }

  /** 保存设备运动时的段落间隔，从下一段起使用。无需接入或连接设备。 */
  async setPacing(seconds: number): Promise<void> {
    const pacing = parsePacing({ seconds })
    await this.updateSettings(latest => ({ ...latest, pacing }))
  }

  resetLiveMotion(): void {
    this.adjust = NO_ADJUST
    this.player.setAdjust(NO_ADJUST)
    this.notify()
  }

  /** 手动定位，value 为 0–100（映射到总设置行程）。打断当前 AI 动作，AI 的下一段动作照常接管。 */
  manual(value: number): void {
    if (!this.canControl() || this.phase !== undefined || !Number.isFinite(value)) return
    this.player.moveTo(manualPosition(value, this.effective!))
    if (this.player.mode !== 'manual') return
    this.activity = 'moving'
    this.notice = ''
    this.notify()
  }

  /** 高潮按钮：设备立即从高潮动作池随机选预设刺激设定秒数，同时告诉 AI 已开始高潮流程。 */
  async burst(): Promise<void> {
    if (!this.canControl()) throw new Error('请先连接设备、接入对话，并确认没有暂停')
    if (this.phase !== undefined) return
    const session = this.owner!
    this.player.burst(this.actionLibrary, this.burstSettings.seconds * 1000, this.burstSettings.speed)
    if (this.player.mode !== 'burst') return
    this.phase = { kind: 'burst' }
    this.activity = 'moving'
    this.say('')
    // 消息发不出去不影响设备流程。
    try { await this.post({ action: 'session.climax', session }) }
    catch (error) { if (this.owner === session) this.say(`设备已开始高潮，但没能通知 AI：${messageOf(error)}`) }
  }

  /** 取消高潮／结束温存：设备停在原位，不退出联动，等 AI 的下一段动作。 */
  async cancelPhase(): Promise<void> {
    const phase = this.phase
    if (phase === undefined) return
    const session = this.owner
    this.phase = undefined
    this.player.stop('user')
    this.activity = 'waiting'
    this.report(phase.kind === 'burst' ? '已取消高潮，设备停在原位；等待 AI 的下一段动作。' : '已结束温存，设备停在原位；等待 AI 的下一段动作。')
    // 高潮／温存消息还没开始处理时撤回；已在处理的回复照常出字，动作不会补执行。
    if (session !== undefined) await this.post({ action: 'session.climax.cancel', session }).catch(() => {})
  }

  /** 高潮刺激自然结束：按设置进入温存或停止。 */
  private burstEnded(): void {
    this.phase = undefined
    if (this.burstSettings.after === 'aftercare' && this.owner !== undefined) { this.startAftercare(); return }
    this.activity = 'waiting'
    this.report('高潮已结束，设备已停下；等待 AI 的下一段动作。')
  }

  private startAftercare(): void {
    this.player.aftercare(this.actionLibrary, this.burstSettings.aftercareSeconds * 1000)
    if (this.player.mode !== 'aftercare') { this.phase = undefined; this.notify(); return }
    this.phase = { kind: 'aftercare' }
    this.activity = 'moving'
    this.say('')
    // 消息发不出去不影响设备温存。
    const session = this.owner!
    void this.post({ action: 'session.aftercare', session })
      .catch(error => { if (this.owner === session) this.say(`设备已转入温存，但没能通知 AI：${messageOf(error)}`) })
  }

  // ---- dsh-qqbot 的显示时钟 ----

  /** 接上或断开 dsh-qqbot 的浏览器端服务。返回撤销函数；调用方插件停用时 cordis 也会自动撤销登记和暂停。 */
  connectSegments(segments: QqbotSegments): () => void {
    this.segments = segments
    if (this.paused && this.owner !== undefined) this.releaseText = segments.pause(this.owner)
    const unregister = segments.register({
      durations: (session, reply, stages, index) => this.durations(session, reply, stages, index),
      revealed: (session, reply, index, stage, holdMs) => { this.revealed(session, reply, index, stage, holdMs) },
      ended: (session, reply, reason) => { this.ended(session, reply, reason) },
    })
    this.notify()
    return () => {
      unregister()
      if (this.segments !== segments) return
      this.segments = undefined
      this.releaseText = undefined
      // 没有时钟就没有段落，也就不会再有动作；正在走的停下。
      this.player.stop('user')
      if (this.owner !== undefined) this.report('分段显示服务已退出，当前动作已停止；服务恢复后等待新的有效动作。')
      this.notify()
    }
  }

  /** 这个会话的段落动作要不要执行。 */
  private driving(session: string): boolean {
    return this.getSnapshot().enabled && session === this.owner && this.settings?.authorized === true && this.effective !== undefined
  }

  private run(session: string, reply: string): Run {
    const key = runKey(session, reply)
    let run = this.runs.get(key)
    if (run === undefined) {
      this.annotations.delete(key)
      run = { start: this.previous, current: this.previous, lastIndex: -1 }
      this.runs.set(key, run)
    }
    return run
  }

  /**
   * 设备按 AI 动作运动时的段落停留：写了新动作的段落停满节奏秒数（右栏本场 > 设置默认），
   * 动作没变的接续段只停到读完。设备停着时返回 undefined，用 qqbot 的打字节奏。
   */
  private durations(session: string, reply: string, stages: readonly SegmentStage[], index: number): number | undefined {
    const stage = stages[index]
    if (!this.driving(session) || stage === undefined || stage.salvaged === true) return undefined
    const key = runKey(session, reply)
    if (this.safetyReplies.has(key) || this.phase !== undefined) return undefined
    const run = this.run(session, reply)
    try {
      let active = run.start
      for (const intent of resolveStageIntents(stages.slice(0, index + 1), run.start)) if (intent !== undefined) active = intent
      return active === null ? undefined : pacingHold(stage.text, stage.motion !== undefined, this.pacing)
    } catch {
      // 动作本身不合法时，显示这一段时会停下并报告；这里只退回 qqbot 自己的间隔。
      return undefined
    }
  }

  private revealed(session: string, reply: string, index: number, stage: SegmentStage, holdMs: number | undefined): void {
    if (!this.driving(session)) return
    const key = runKey(session, reply)
    if (this.safetyReplies.has(key)) return
    const takeover = this.safetySpeed !== undefined
    if (takeover) {
      this.safetySpeed = undefined
      this.player.setSpeedLimit(undefined)
    }
    const run = this.run(session, reply)
    // 流式结束会为已经显示的末段补一次通知，只更新现有看门狗，不能重放动作。
    // 特别是保护停止或设备异常之后，这个通知不能重新启动原段落。
    if (index <= run.lastIndex) {
      if (index === run.lastIndex && holdMs === undefined) {
        this.player.reveal(undefined, holdMs)
        this.lastStage = { key: runKey(session, reply), index, tail: true, holdMs }
        this.notify()
      }
      return
    }
    run.lastIndex = index
    if (stage.salvaged === true) {
      this.recordAction(session, reply, index, '动作信息不可用')
      this.fail(run, `第 ${index + 1} 段回复格式有误，只能恢复文字，动作未执行`)
      return
    }
    let intent: Intent | null | undefined
    try {
      // 与 resolveStageIntents 相同：第一段没写 motion 时沿用回复开始时的选择，其余没写的不变。
      if (stage.motion === undefined) intent = index === 0 ? run.start ?? undefined : undefined
      else intent = run.current = reduceIntent(run.current, stage.motion)
    } catch (error) {
      this.recordAction(session, reply, index, '动作信息无效')
      this.fail(run, `第 ${index + 1} 段的动作无效：${motionError(error)}`)
      return
    }
    if (this.phase !== undefined) {
      this.recordAction(session, reply, index, this.actionLabel())
      this.notify()
      return
    }
    const keepReason = intent === undefined && this.player.intent === null && ['invalid', 'error', 'timeout', 'model-stop'].includes(this.activity)
    // 新回复未写动作时也交还控制；先完成校验，再切换程序动作。
    if (takeover && this.player.mode !== 'ai' && intent === undefined) intent = run.start
    if (!keepReason) {
      this.notice = ''
      this.activity = intent === null ? 'model-stop' : intent !== undefined || this.player.intent !== null ? 'moving' : 'no-motion'
    }
    if (intent === null) this.report(`AI 在第 ${index + 1} 段要求停止；等待后续有效动作。`)
    this.lastStage = { key: runKey(session, reply), index, tail: holdMs === undefined, holdMs }
    this.player.reveal(intent, holdMs)
    this.recordAction(session, reply, index, `${this.actionLabel()}${stage.motion === undefined && this.player.intent !== null ? ' · 沿用' : ''}`)
    if (intent !== undefined) this.previous = this.player.intent
    this.notify()
  }

  private ended(session: string, reply: string, reason: SegmentEndReason): void {
    const key = runKey(session, reply)
    const run = this.runs.get(key)
    this.runs.delete(key)
    if (this.safetyReplies.has(key)) return
    if (reason === 'closed' && run !== undefined && this.driving(session) && this.player.mode === 'ai') {
      this.player.stop('user')
      return
    }
    // 只有已经开始驱动的回复才停；没显示过段落的回复没有 run。
    if (reason === 'failed' && run !== undefined && this.driving(session)) this.fail(run, `回复在第 ${run.lastIndex + 1} 段后被分段时钟判为无效或被替换，无法继续可靠执行`)
    if (reason === 'interrupted' && run !== undefined && this.driving(session)) {
      if (this.lastStage?.key === key) this.lastStage.interrupted = true
      this.report(`新消息已打断这条回复的剩余段落；${this.paused ? '设备仍处于用户暂停状态。' : this.player.intent !== null ? '当前动作不会因此立即停止，仍受现有保护倒计时限制。' : '当前没有运行中的动作。'}`)
    }
  }

  private fail(run: Run, reason: string): void {
    // 只停止出错段；下一段仍可用完整有效动作重新开始，不能继承出错前的选择。
    run.current = null
    this.player.stop('error', new Error(reason))
    if (this.paused) this.player.pause()
    this.activity = 'invalid'
    this.report(`${reason}；当前动作已停止，后续完整有效动作仍可执行。`)
    this.notify()
  }

  private recordAction(session: string, reply: string, index: number, label: string): void {
    const key = runKey(session, reply)
    let row = this.annotations.get(key)
    if (row === undefined) { row = new Map(); this.annotations.set(key, row) }
    row.set(index, label)
    if (this.annotations.size > 500) this.annotations.delete(this.annotations.keys().next().value!)
  }

  stageAction(session: string, reply: string, index: number): string | undefined {
    return this.annotations.get(runKey(session, reply))?.get(index)
  }

  private actionLabel(): string {
    const mode = this.player.mode
    if (mode === 'manual') return '手动定位'
    if (mode === 'standby') return `待机缓动 · ${this.player.presetName ?? ''}`
    if (mode === 'aftercare') return this.player.presetName === undefined ? '温存' : `温存 · ${this.player.presetName}`
    if (mode === 'burst') return this.player.presetName === undefined ? '高潮' : `高潮 · ${this.player.presetName}`
    if (this.player.intent !== null && this.effective !== undefined && (this.adjust.bounds !== undefined || this.adjust.speed !== undefined)) {
      const actual = liveMotion(this.player.intent, this.effective, this.adjust)
      return `${this.player.presetName ?? this.player.intent.action} · 行程 ${actual.bounds.join('–')} · ${actual.speed} unit/s`
    }
    return describeAction(this.player.intent, this.effective, this.player.presetName)
  }

  /** 右侧面板只读播放器现有状态；读取不续期、不发包、不恢复运动。 */
  livePlayback(session: string): { action: string; name: string; range: string | undefined; speed: string | undefined; remainingMs: number | undefined; tail: boolean; position: number | undefined } | undefined {
    if (this.owner !== session || !this.getSnapshot().enabled) return undefined
    const target = this.player.intent === null ? undefined : this.player.displayPosition
    const config = this.effective
    const intent = this.player.mode === 'ai' ? this.player.intent : null
    const actual = intent === null || config === undefined ? undefined : liveMotion(intent, config, this.adjust)
    const chosen = this.player.presetName
    const auto = intent !== null && (intent.action === AUTO_ACTION || (chosen !== undefined && chosen.toLowerCase() !== intent.action.toLowerCase()))
    return {
      action: this.actionLabel(),
      name: intent === null ? chosen ?? this.actionLabel() : auto ? chosen === undefined ? '自动选择' : `自动选择 · ${chosen}` : chosen ?? intent.action,
      range: actual === undefined || intent === null ? undefined : `${this.adjust.bounds === undefined ? `${RANGE_LABELS[intent.range]} ` : ''}${actual.bounds.join('–')}`,
      speed: this.player.intent === null ? undefined : `${intent === null ? '' : `${TIER_LABELS[intent.tier]}速 · `}${this.player.targetSpeed} unit/s`,
      remainingMs: this.player.remainingMs(),
      tail: this.lastStage?.tail === true,
      // 显示为总设置行程内的 0–100，和手动定位滑条一致。
      position: target === undefined || config === undefined ? undefined
        : (target - config.minPosition) * 100 / (config.maxPosition - config.minPosition),
    }
  }

  tailPlayback(session: string, reply: string, index: number): TailPlayback | undefined {
    if (this.owner !== session || this.lastStage?.key !== runKey(session, reply) || this.lastStage.index !== index || !this.lastStage.tail) return undefined
    const remainingMs = this.player.remainingMs()
    return remainingMs === undefined ? undefined : { remainingMs, paused: this.player.paused, ...this.settings?.motion.standby !== undefined && this.player.mode !== 'standby' ? { standby: true } : {} }
  }

  // ---- 快捷键 ----

  /** 全局 keydown（捕获阶段）。暂停键只暂停；恢复键（用户设了才有）只恢复。返回是否处理了。 */
  hotkey(event: KeyLike): boolean {
    if (this.owner === undefined || this.settings === undefined) return false
    const resume = this.settings.resumeHotkey
    if (this.paused) {
      if (resume === undefined || !matchesHotkey(resume, event)) return false
      this.resume()
      return true
    }
    if (!matchesHotkey(this.settings.hotkey, event)) return false
    this.pause('已通过暂停快捷键暂停设备和分段文字；点击“继续设备”或使用已设置的恢复快捷键恢复。')
    return true
  }

  // ---- 结束 ----

  /** 页面关闭：停下设备，告诉 host 退出联动（keepalive，不等结果）。 */
  pagehide(reason = '当前页面正在关闭或刷新，已停止继续发动作并退出联动。'): void {
    const session = this.owner
    this.dropOwner(reason)
    if (session !== undefined) this.options.api.beacon({ action: 'session.detach', session })
    this.transport.disconnect()
  }

  dispose(): void {
    if (this.disposed) return
    this.pagehide('联动模块已卸载，已停止继续发动作、断开设备并退出联动。')
    this.epoch++
    this.disposed = true
    this.watchAbort.abort()
    this.unsubscribe()
    this.player.dispose()
    this.listeners.clear()
    this.annotations.clear()
  }
}
