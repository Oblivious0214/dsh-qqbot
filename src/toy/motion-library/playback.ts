/** 可执行适配：仅由现有 MotionPlayer 拉取；本模块没有设备连接或计时器。 */
import { HARD_LIMITS, tierBudget, type MotionConfig } from '../core/config.ts'
import { liveMotion, MIN_INTERVAL_MS, NO_ADJUST, RAMP_UP, type LiveAdjust, type MotionProfile, type Packet } from '../core/motion.ts'
import type { Intent } from '../core/intent.ts'
import { previewPreset } from './catalog.ts'
import type { MotionClip } from './library.ts'

interface Step { readonly from: number; readonly to: number; readonly durationMs: number }

export class PresetPlayback {
  readonly name: string
  private readonly steps: Step[] = []
  private readonly looping: boolean
  /** 单次动作从头重复播放（AI 动作都这样播）。 */
  private repeating = false
  private index = 0
  /** 循环时回到的步序号：片段写了 loopFromMs 就从那里循环，否则从头。 */
  private loopIndex = 0
  private offset = 0
  private entering = true
  private readonly quantize: (speed: number) => number
  private readonly cap: number
  private readonly start: number

  /** clip 由调用方从动作池选定（见 selectAction）；intent 只提供范围和速度档。 */
  constructor(intent: Intent, config: MotionConfig, clip: MotionClip, profile: MotionProfile, adjust: LiveAdjust = NO_ADJUST) {
    this.name = clip.name
    this.looping = clip.playback === 'loop'
    this.quantize = profile.quantize ?? (speed => speed)
    const budget = tierBudget(config, intent.tier)
    const actual = liveMotion(intent, config, adjust)
    this.cap = adjust.speed === undefined ? budget.max : actual.speed
    try { this.start = Math.min(budget.nominal, tierBudget(config, 'low').nominal) }
    catch { this.start = budget.min }
    const preview = previewPreset(clip, intent.tier, config, { tempo: 'tier', window: actual.bounds, maxDurationMs: 3600000 })
    // 手调速度是绝对目标：按映射后轨迹的峰值整体调速，不再乘档位倍率。
    let peak = 0
    for (let i = 1; i < preview.legs.length; i++) peak = Math.max(peak, Math.abs(preview.legs[i]!.target - preview.legs[i - 1]!.target) * 1000 / preview.legs[i]!.durationMs)
    const factor = adjust.speed === undefined || peak === 0 ? 1 : actual.speed / peak
    let from = preview.legs[0]!.target
    for (const leg of preview.legs.slice(1)) {
      if (this.looping && clip.loopFromMs !== undefined && leg.sourceAtMs > clip.loopFromMs && this.loopIndex === 0) this.loopIndex = this.steps.length
      const legMs = leg.durationMs / factor
      const count = Math.max(1, Math.floor(legMs / MIN_INTERVAL_MS))
      const durationMs = Math.ceil(legMs / count)
      for (let i = 1; i <= count; i++) {
        const to = Math.round(from + (leg.target - from) * i / count)
        const previous = this.steps.at(-1)?.to ?? from
        this.steps.push({ from: previous, to, durationMs })
      }
      from = leg.target
    }
  }

  /** 完整走一遍的时长（不含进入包），按该档速度算，不含升速；有循环起点时也按整条轨迹算。 */
  get passMs(): number { return this.steps.reduce((sum, step) => sum + step.durationMs, 0) }

  /** 第二遍起每遍的时长：有循环起点时只算从起点到终点。 */
  get loopPassMs(): number { return this.steps.slice(this.loopIndex).reduce((sum, step) => sum + step.durationMs, 0) }

  /** 单次动作播完从头再播，直到换选择或停止；循环动作本来就一直循环。 */
  repeat(): void { this.repeating = true }

  /** 暂停只重做限速进入；已完成和已耗时的轨迹保留。 */
  reenter(): void { this.entering = true }

  next(lastSpeed?: number, lastDurationMs = 0): Packet | undefined {
    const step = this.steps[this.index]
    if (step === undefined) return undefined
    const fraction = Math.min(1, this.offset / step.durationMs)
    const from = Math.round(step.from + (step.to - step.from) * fraction)
    if (this.entering) {
      const speed = Math.floor(Math.min(this.cap, this.start))
      const actual = this.quantize(speed)
      if (actual < HARD_LIMITS.minSpeed) throw new Error('该预设速度低于设备可表达范围')
      return { position: from, speed, durationMs: Math.max(MIN_INTERVAL_MS, Math.ceil(Math.max(from, 100 - from) * 1000 / actual)), hold: false, entry: true }
    }
    const distance = Math.abs(step.to - from)
    const ceiling = Math.min(this.cap, (lastSpeed ?? this.start) + RAMP_UP * lastDurationMs / 1000)
    const speed = Math.max(HARD_LIMITS.minSpeed, Math.floor(ceiling))
    const actual = this.quantize(speed)
    if (actual < HARD_LIMITS.minSpeed) throw new Error('该预设速度低于设备可表达范围')
    const durationMs = Math.max(MIN_INTERVAL_MS, Math.ceil(step.durationMs - this.offset), Math.ceil(distance * 1000 / actual))
    return { position: step.to, speed, durationMs, hold: distance === 0 }
  }

  /** 消费实际运行时间；暂停时可提交半包进度，进入包不消耗源轨迹。 */
  consume(packet: Packet, elapsedMs: number): void {
    if (packet.entry) { if (elapsedMs >= packet.durationMs) this.entering = false; return }
    const step = this.steps[this.index]
    if (step === undefined) return
    const remaining = step.durationMs - this.offset
    this.offset += remaining * Math.min(1, Math.max(0, elapsedMs / packet.durationMs))
    if (elapsedMs + 1e-6 < packet.durationMs) return
    this.offset = 0
    this.index++
    if (this.index === this.steps.length && (this.looping || this.repeating)) this.index = this.looping ? this.loopIndex : 0
  }
}
