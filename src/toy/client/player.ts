/**
 * 运动播放器：按 dsh-qqbot 的显示时钟驱动设备。qqbot 每显示一段就调用 reveal()，
 * 播放器在后台按当前选择循环发包，自己不决定文字什么时候出现。
 *
 * 程序层停止都在这里（CLAUDE.md"急停只能由程序执行"）：
 * - stop()：退出联动、出错等都走它，立即停止并清掉当前选择（暂停按钮和快捷键走 pause()）；
 * - 看门狗：每段显示后，在预定间隔加 5 秒余量内没等到下一段就停止；最后一段按用户设置停止或转入待机；
 * - 设备断开、发送出错时停止；
 * - 换选择或改限制时从未知位置限速重新进入（轨迹的进入包）。
 * - 换到更快的选择时从上一包的速度按 RAMP_UP 升速；停止、暂停、改限制之后从慢档起步。
 *
 * 节奏循环迁移自 dsh-serveu 的 live-player.js（LivePlayer.pump/setMotion），显示计时部分已移到 dsh-qqbot。
 */

import { burstTier, tierBudget, type MotionConfig, type Tier } from '../core/config.ts'
import type { BurstSpeed } from '../api-types.ts'
import { AUTO_ACTION, sameIntent, type Intent } from '../core/intent.ts'
import { gentleSpeed, liveMotion, manualPackets, NO_ADJUST, type LiveAdjust, type Packet } from '../core/motion.ts'
import { LAST_STAGE_STOP_MS, STAGE_GRACE_MS } from '../core/safety.ts'
import type { Transport, TransportState } from './transport.ts'
import { PresetPlayback } from '../motion-library/playback.ts'
import { selectAction } from '../motion-library/catalog.ts'
import type { ActionLibrary } from '../motion-library/config.ts'
import type { MotionClip } from '../motion-library/library.ts'

export type StopCause = 'user' | 'model' | 'timeout' | 'disconnected' | 'error' | 'stop-error' | 'complete' | 'burst-end' | 'aftercare-end'

/** 用户在右栏发起、由程序直接驱动的动作；AI 的段落不能改写它。 */
export type ProgramKind = 'manual' | 'burst' | 'aftercare' | 'standby'
type Source = { readonly generator?: Generator<Packet, unknown, undefined>; readonly preset?: PresetPlayback }
interface Program {
  readonly kind: ProgramKind
  /** fresh：开始或快调后重建；否则（暂停恢复）沿用原播放进度。 */
  source(fresh: boolean): Source
  /** 单次片段播完后换下一个。 */
  renew?(): Source
}
/** 程序动作占位的选择，只用于“正在运动”的判断，不参与 AI 的沿用。 */
const PROGRAM_INTENT: Intent = Object.freeze({ range: 'full', tier: 'low', action: AUTO_ACTION })
const randomSeed = () => Math.floor(Math.random() * 0x1_0000_0000)

export interface Clock {
  now(): number
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realClock: Clock = {
  now: () => performance.now(),
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export interface PlayerEvents {
  /** 播放已停止或发生停止请求错误；error / stop-error 携带具体错误。 */
  readonly onStop?: (cause: StopCause, error?: Error) => void
  /** 在发送停止前取得失败回调，便于调用方绑定当时的会话，避免迟到错误归到新会话。 */
  readonly stopFailureHandler?: () => (error: Error) => void
}

export class MotionPlayer {
  /** 当前选择；null 表示静止。 */
  intent: Intent | null = null
  paused = false

  private config: MotionConfig | undefined
  private library: ActionLibrary | undefined
  private preset: PresetPlayback | undefined
  /** 每次新选择抽一次；暂停恢复、快调都用同一个种子，池里抽到的动作不变。 */
  private presetSeed = 0
  /** 抽到或点名的动作名。 */
  private chosenName: string | undefined
  private adjust: LiveAdjust = NO_ADJUST
  private speedLimit: number | undefined
  /** 安全词的临时速度上限；不重启轨迹、不延长计时。 */
  setSpeedLimit(speed: number | undefined): void { this.speedLimit = speed }
  get targetSpeed(): number {
    const config = this.config
    if (config === undefined) return 2
    const mode = this.mode
    const speed = mode === 'standby' ? config.standby?.maxSpeed ?? 2
      : mode === 'manual' ? gentleSpeed(config)
      : mode === 'aftercare' ? this.programSpeed ?? gentleSpeed(config)
      : mode === 'burst' ? this.adjust.speed ?? this.programSpeed ?? config.maxSpeed
      : liveMotion(this.intent, config, this.adjust).speed
    return Math.min(config.maxSpeed, speed, this.speedLimit ?? Infinity)
  }
  private program: Program | undefined
  /** 高潮／温存所用速度（档位上限或自己填的速度），只供显示和安全词降速参考。 */
  private programSpeed: number | undefined
  /** 上一包走完后的位置；停止后未知。 */
  private lastPosition: number | undefined
  get mode(): ProgramKind | 'ai' { return this.program?.kind ?? 'ai' }
  /** 最近一包发出的目标位置，只供界面显示（没有位置反馈）。 */
  lastTarget: number | undefined
  private displayMove: { from: number; to: number; at: number; duration: number } | undefined
  /** 无硬件反馈；按当前发包的运动时长推算，仅供界面显示。 */
  get displayPosition(): number | undefined {
    const move = this.displayMove
    if (move === undefined) return this.lastTarget
    const progress = Math.max(0, Math.min(1, (this.clock.now() - move.at) / move.duration))
    return move.from + (move.to - move.from) * progress
  }
  /** 最近一次停止前由谁驱动，供停止回调区分原因。 */
  endedMode: ProgramKind | 'ai' = 'ai'
  private scriptTick: { source: PresetPlayback; packet: Packet; at: number } | undefined
  private lastDuration = 0
  get presetName(): string | undefined { return this.preset?.name ?? this.chosenName }
  private generator: Generator<Packet, unknown, undefined> | undefined
  /** 上一包实际发出的速度，换选择时作为起步速度；停下后清空，再启动从慢档起步。 */
  private lastSpeed: number | undefined
  /** 每次停止、换选择、改限制加一，作废还在路上的发包结果。 */
  private epoch = 0
  private motionTimer: unknown
  private pending = false
  /** pump 正在等上一次停止完成。 */
  private waiting = false
  /** 上一次停止的 Promise；新的发包要等它完成。 */
  private barrier: Promise<void> | undefined
  private watchdog: unknown
  private deadline: number | undefined
  /** 暂停时看门狗还剩多久。 */
  private remaining: number | undefined
  private tail = false
  private readonly unsubscribe: () => void

  constructor(
    private readonly transport: Transport,
    private readonly events: PlayerEvents = {},
    private readonly clock: Clock = realClock,
  ) {
    let first = true
    this.unsubscribe = transport.subscribe((state: TransportState) => {
      if (first) { first = false; return }
      if (state.phase !== 'ready' && (this.intent !== null || this.generator !== undefined)) this.stop('disconnected')
    })
  }

  private autoStopMs(): number {
    const seconds = this.config?.autoStopSeconds ?? 30
    return seconds === 0 ? Infinity : seconds * 1000
  }

  /** 设置用户允许的限制。变化时正在运行的选择从未知位置重新进入。 */
  configure(config: MotionConfig): void {
    if (this.config !== undefined && JSON.stringify(this.config) === JSON.stringify(config)) return
    this.config = config
    if (this.intent === null) return
    // 用同一个种子按新限制重建轨迹，抽到的动作不变。
    if (this.program === undefined) this.preset = undefined
    if (this.paused) return
    this.halt()
    this.start()
  }

  /** 动作库变化时，AI 选的动作停止；用户在右栏发起的动作不受影响。 */
  configureLibrary(library: ActionLibrary | undefined): void {
    if (JSON.stringify(this.library) === JSON.stringify(library)) return
    if (this.intent !== null && this.program === undefined) this.stop('user')
    this.library = library
  }

  /** 按选择取播放源：名称在该档动作池里就用它，否则（含 auto）按权重抽一个。 */
  private sourceFor(intent: Intent, seed: number, adjust: LiveAdjust): { readonly name: string; readonly preset: PresetPlayback } {
    if (this.library === undefined) throw new Error('动作库尚未就绪')
    const clip = selectAction(this.library.library, this.library.pools[intent.tier], seed, intent.action === AUTO_ACTION ? undefined : intent.action)
    const preset = new PresetPlayback(intent, this.config!, clip, this.transport.profile, adjust)
    // AI 动作在段落停留期间一直重复，单次动作播完从头再播；持续多久由看门狗决定。
    preset.repeat()
    return { name: clip.name, preset }
  }

  /**
   * qqbot 显示了一段。
   * @param intent 这一段的动作：选择、null（停止）或 undefined（不变），见 resolveStageIntents。
   * @param holdMs 到下一段预计还要多久；最后一段传 undefined，按自动停止设置计时。
   */
  reveal(intent: Intent | null | undefined, holdMs: number | undefined): void {
    if (this.program?.kind === 'standby' && intent !== undefined) this.stop('user')
    this.tail = holdMs === undefined
    if (intent === undefined && this.program !== undefined) return
    if (intent !== undefined) this.setIntent(intent)
    if (this.intent === null) {
      this.clearWatchdog()
      return
    }
    this.arm(holdMs !== undefined ? holdMs + STAGE_GRACE_MS : this.autoStopMs())
  }

  /** 暂停：设备停下，选择和看门狗剩余时间保留，resume() 后从未知位置重新进入。 */
  pause(): void {
    if (this.paused) return
    this.paused = true
    if (this.deadline !== undefined) this.remaining = Math.max(0, this.deadline - this.clock.now())
    this.clearWatchdog()
    this.halt()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.intent === null) return
    this.start()
    if (this.intent === null) return
    const budget = this.remaining ?? this.autoStopMs()
    this.remaining = undefined
    this.arm(budget)
  }

  /** 只读现有看门狗；显示代码不能重设安全超时。 */
  remainingMs(): number | undefined {
    if (this.intent === null) return undefined
    return this.paused ? this.remaining : this.deadline === undefined ? this.remaining : Math.max(0, this.deadline - this.clock.now())
  }

  /** 立即停止并清掉选择。 */
  stop(cause: StopCause, error?: Error): void {
    const wasActive = this.intent !== null || this.generator !== undefined || this.paused
    this.endedMode = this.mode
    this.intent = null
    this.paused = false
    this.remaining = undefined
    this.clearWatchdog()
    this.halt()
    this.preset = undefined
    this.chosenName = undefined
    this.program = undefined
    if (wasActive || cause === 'error') this.events.onStop?.(cause, error)
  }

  dispose(): void {
    this.stop('user')
    this.unsubscribe()
  }

  private setIntent(intent: Intent | null): void {
    if (this.program === undefined && sameIntent(intent, this.intent)) return
    this.program = undefined
    this.intent = intent
    this.preset = undefined
    this.chosenName = undefined
    this.presetSeed = randomSeed()
    if (this.paused) return
    if (intent === null) {
      this.halt()
      return
    }
    // 换目标时，等正在走的那一包结束再接上新的轨迹，不打断它。
    this.generator = undefined
    this.choose(intent)
    if (this.preset !== undefined && this.motionTimer === undefined && !this.pending) void this.pump()
  }

  /** 建好当前选择的轨迹；暂停恢复时沿用原进度。出错时停止。 */
  private choose(intent: Intent): void {
    if (this.config === undefined) {
      this.stop('error', new Error('还没有设置行程和速度限制'))
      return
    }
    if (this.preset !== undefined) return
    try {
      const source = this.sourceFor(intent, this.presetSeed, this.adjust)
      this.chosenName = source.name
      this.preset = source.preset
    } catch (error) {
      this.stop('error', error instanceof Error ? error : new Error(String(error)))
    }
  }

  private start(): void {
    if (this.intent === null) return
    if (this.program !== undefined) {
      const program = this.program
      if (this.useSource(() => program.source(false))) void this.pump()
      return
    }
    this.choose(this.intent)
    if (this.preset !== undefined) void this.pump()
  }

  private endCause(fallback: 'timeout' | 'complete'): StopCause {
    const kind = this.program?.kind
    return kind === 'burst' ? 'burst-end' : kind === 'aftercare' ? 'aftercare-end' : fallback
  }

  /** 换上播放源；出错时停止。返回是否可以继续发包。 */
  private useSource(make: () => Source): boolean {
    try {
      const source = make()
      this.generator = source.generator
      this.preset = source.preset
      return this.generator !== undefined || this.preset !== undefined
    } catch (error) {
      this.stop('error', error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private idle(): boolean { return this.motionTimer === undefined && !this.pending && !this.waiting }

  /** 本场快调。运行中的动作等当前一包走完后按新偏移接上；手动定位和温存不受影响。 */
  setAdjust(adjust: LiveAdjust): void {
    if (adjust.bounds?.[0] === this.adjust.bounds?.[0] && adjust.bounds?.[1] === this.adjust.bounds?.[1] && adjust.speed === this.adjust.speed) return
    this.adjust = adjust
    if (this.intent === null || this.config === undefined) return
    const program = this.program
    if (program?.kind === 'manual' || program?.kind === 'aftercare' || program?.kind === 'standby') return
    // 暂停时重建播放源但不发包，恢复后才执行新参数。
    let ok: boolean
    if (program !== undefined) ok = this.useSource(() => program.source(true))
    else {
      // 同一个种子重建，池里抽到的动作不变。
      const intent = this.intent
      ok = this.useSource(() => this.sourceFor(intent, this.presetSeed, adjust))
    }
    if (ok && !this.paused && this.idle()) void this.pump()
  }

  /** 手动定位：打断当前动作，慢速移到 position（已在总设置行程内）后停住。暂停中不执行。 */
  moveTo(position: number): void {
    if (this.config === undefined || this.paused) return
    const config = this.config, profile = this.transport.profile
    const self = this
    this.startProgram({
      kind: 'manual',
      // 生成器第一次取包时才读上一包走完的位置。
      source: () => ({ generator: (function* () { return yield* manualPackets(position, config, profile, self.lastPosition) })() }),
    }, LAST_STAGE_STOP_MS)
  }

  /**
   * 高潮刺激：从独立动作池随机选，按设置的速度档（或自己填的速度）播放；单次动作播完换下一个。
   * 本场快调手动调过速度时以快调为准。
   */
  burst(library: ActionLibrary | undefined, durationMs: number, speed: BurstSpeed = 'high'): void {
    this.presetProgram('burst', config => burstTier(config, speed), 'full', library, library?.burstPool, durationMs,
      typeof speed === 'number' ? speed : undefined)
  }

  /** 温存：从温存动作池随机选，用最低可用速度档、靠龟头的浅行程播放；单次动作播完换下一个。 */
  aftercare(library: ActionLibrary | undefined, durationMs: number): void {
    this.presetProgram('aftercare', config => (['low', 'medium', 'high'] as const).find(t => { try { tierBudget(config, t); return true } catch { return false } }),
      'upper', library, library?.aftercarePool, durationMs)
  }

  private presetProgram(kind: 'burst' | 'aftercare', pick: (config: MotionConfig) => Tier | undefined, range: Intent['range'],
    library: ActionLibrary | undefined, own: ActionLibrary['burstPool'], durationMs: number, fixedSpeed?: number): void {
    const config = this.config
    if (config === undefined || this.paused) return
    if (library === undefined) { this.stop('error', new Error('动作库尚未就绪')); return }
    const tier = pick(config)
    if (tier === undefined) { this.stop('error', new Error('当前速度上限下没有可用的速度档')); return }
    let seed = randomSeed()
    let preset: PresetPlayback | undefined
    const intent: Intent = { range, tier, action: AUTO_ACTION }
    // 温存不受本场快调影响；高潮沿用快调，没手调速度时用自己填的速度。
    const adjust = () => kind === 'aftercare' ? NO_ADJUST
      : this.adjust.speed !== undefined || fixedSpeed === undefined ? this.adjust : { ...this.adjust, speed: fixedSpeed }
    const make = (fresh: boolean): Source => {
      // 暂停恢复时沿用原进度。
      if (!fresh && preset !== undefined) return { preset }
      preset = new PresetPlayback(intent, this.config!, selectAction(library.library, own ?? library.pools[tier], seed), this.transport.profile, adjust())
      return { preset }
    }
    this.programSpeed = Math.min(config.maxSpeed, fixedSpeed ?? tierBudget(config, tier).max)
    this.startProgram({ kind, source: make, renew: () => { seed = randomSeed(); return make(true) } }, durationMs)
  }

  private startProgram(program: Program, budgetMs: number): void {
    // 连续拖动手动定位时接在当前一包之后，其余情况立即打断当前动作。
    if (!(program.kind === 'manual' && this.program?.kind === 'manual')) this.halt()
    this.program = program
    this.intent = PROGRAM_INTENT
    if (!this.useSource(() => program.source(true))) return
    if (this.idle()) void this.pump()
    this.arm(budgetMs)
  }

  /** 停下设备、作废所有在路上的发包；不改 intent。 */
  private halt(): void {
    if (this.scriptTick !== undefined) {
      const tick = this.scriptTick
      tick.source.consume(tick.packet, Math.max(0, this.clock.now() - tick.at))
      this.scriptTick = undefined
    }
    this.preset?.reenter()
    this.epoch++
    this.waiting = false
    if (this.motionTimer !== undefined) this.clock.clear(this.motionTimer)
    this.motionTimer = undefined
    this.pending = false
    this.generator = undefined
    this.lastSpeed = undefined
    this.lastPosition = undefined
    this.displayMove = undefined
    this.lastDuration = 0
    if (this.transport.state.phase !== 'ready') return
    const stopFailed = this.events.stopFailureHandler?.()
    // 停止失败只报告，不再递归停止；barrier 本身不会 reject。
    this.barrier = this.transport.stop().catch((error: unknown) => {
      const reason = error instanceof Error ? error : new Error(String(error))
      if (stopFailed !== undefined) stopFailed(reason)
      else this.events.onStop?.('stop-error', reason)
    })
  }

  private arm(ms: number): void {
    this.clearWatchdog()
    if (!Number.isFinite(ms)) {
      this.remaining = Infinity
      return
    }
    if (this.paused) {
      this.remaining = ms
      return
    }
    this.remaining = undefined
    this.deadline = this.clock.now() + ms
    this.watchdog = this.clock.set(() => { this.expire() }, ms)
  }

  private expire(): void {
    this.clearWatchdog()
    if (this.tail && this.program === undefined && this.config?.standby !== undefined) this.startStandby()
    else this.stop(this.endCause('timeout'))
  }

  private startStandby(): void {
    const settings = this.config?.standby
    const library = this.library
    if (settings === undefined || library === undefined || this.config === undefined) { this.stop('error', new Error('待机动作库尚未就绪')); return }
    const { preset: name, ...limits } = settings
    const config: MotionConfig = { ...this.config, ...limits }
    const intent: Intent = { range: 'full', tier: 'high', action: name }
    const profile = this.transport.profile
    // 待机动作按循环播放。
    const clip = library.library.clips.find(c => c.name === name)
    if (clip === undefined) { this.stop('error', new Error('待机动作已不存在，请重新选择')); return }
    const looped: MotionClip = { ...clip, playback: 'loop' }
    this.startProgram({ kind: 'standby', source: () => ({ preset: new PresetPlayback(intent, config, looped, profile) }) }, Infinity)
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) this.clock.clear(this.watchdog)
    this.watchdog = undefined
    this.deadline = undefined
  }

  private async pump(): Promise<void> {
    this.motionTimer = undefined
    const token = this.epoch
    try {
      if (this.barrier !== undefined) {
        this.waiting = true
        try { await this.barrier } finally { if (token === this.epoch) this.waiting = false }
        if (token !== this.epoch) return
        this.barrier = undefined
      }
      // 页面曾被冻结时，运动唤醒可能先于看门狗消息到达；过期后不再补发旧动作。
      if (this.deadline !== undefined && this.clock.now() >= this.deadline) { this.expire(); return }
      const generator = this.generator
      const config = this.config
      const source = this.preset
      if (this.paused || (generator === undefined && source === undefined) || config === undefined) return
      let packet: Packet | undefined
      if (source === undefined) { const step = generator!.next(); packet = step.done === true ? undefined : step.value as Packet }
      else packet = source.next(this.lastSpeed, this.lastDuration)
      if (packet === undefined) {
        const program = this.program
        if (program?.renew !== undefined && this.useSource(() => program.renew!())) { void this.pump(); return }
        if (this.intent !== null) this.stop(this.endCause('complete'))
        return
      }
      if (!packet.hold && this.speedLimit !== undefined && packet.speed > this.speedLimit) {
        const speed = Math.min(packet.speed, this.speedLimit)
        const quantize = this.transport.profile.quantize ?? (value => value)
        const actual = quantize(speed)
        if (actual < 2) throw new Error('该速度低于设备可表达范围')
        // 按量化后的速度延长同一包，不变更目标点或轨迹进度。
        packet = { ...packet, speed, durationMs: Math.ceil(packet.durationMs * packet.speed / actual) }
      }
      if (source !== undefined) this.scriptTick = { source, packet, at: this.clock.now() }
      let wait = packet.durationMs
      if (!packet.hold) {
        this.pending = true
        this.displayMove = { from: this.lastPosition ?? packet.position, to: packet.position, at: this.clock.now(), duration: packet.durationMs }
        this.lastTarget = packet.position
        this.lastSpeed = packet.speed
        const result = await this.transport.move(packet.position, packet.durationMs, {
          minPosition: config.minPosition, maxPosition: config.maxPosition, maxSpeed: Math.min(config.maxSpeed, packet.speed),
        })
        if (token !== this.epoch) return
        this.displayMove.duration = Math.max(1, this.clock.now() - this.displayMove.at + result.remainingMs)
        this.pending = false
        wait = result.remainingMs
      }
      this.motionTimer = this.clock.set(() => {
        if (token !== this.epoch) return
        if (source !== undefined) source.consume(packet, packet.durationMs)
        this.scriptTick = undefined
        this.lastDuration = packet.durationMs
        this.lastPosition = packet.position
        void this.pump()
      }, wait)
    } catch (error) {
      if (token === this.epoch) this.stop('error', error instanceof Error ? error : new Error(String(error)))
    }
  }
}
