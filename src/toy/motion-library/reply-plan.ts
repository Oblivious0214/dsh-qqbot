import type { MotionConfig, Tier } from '../core/config.ts'
import { emptyLibrary, parseLibrary, type MotionClip } from './library.ts'
import { previewPreset } from './catalog.ts'
import { integer, SCRIPT_LIMITS } from './script.ts'
import type { MotionPreview } from './preview.ts'

export type PlanStopReason = 'completed' | 'reply-ended' | 'user-interrupted' | 'replaced' | 'timeout' | 'detached' | 'disconnected' | 'disabled' | 'revoked'

export interface ReplyMotionPlan {
  readonly kind: 'reply-motion-plan-preview'
  readonly executable: false
  readonly reply: string
  readonly clipName: string
  readonly seed: number
  readonly playback: 'once' | 'loop'
  readonly preview: MotionPreview
  /** 原生控制层授予的最大运行预算；气泡事件不能延长它。 */
  readonly budgetMs: number
  readonly finish: 'full-clip' | 'protection-will-stop' | 'finite-loop-budget'
  readonly phase: 'active' | 'paused' | 'stopped'
  readonly elapsedMs: number
  readonly stopReason?: PlanStopReason
}

export interface ReplyPlanOptions {
  readonly reply: string
  readonly tier: Tier
  readonly seed: number
  readonly budgetMs: number
  readonly tempo?: 'original' | 'tier'
  readonly positionJitter?: number
  readonly timingJitter?: number
}

/** 同一轮回复的离线计划快照；生成不代表授权，也不发任何设备命令。 */
export function createReplyPlan(clip: MotionClip, config: MotionConfig, options: ReplyPlanOptions): ReplyMotionPlan {
  const checked = parseLibrary({ ...emptyLibrary(), clips: [clip] }).clips[0]!
  if (typeof options.reply !== 'string' || !options.reply || options.reply.length > 200) throw new Error('回复标识无效')
  const budgetMs = integer(options.budgetMs, 100, 120_000, '运行保护预算')
  const preview = previewPreset(checked, options.tier, config, { seed: options.seed,
    positionJitter: options.positionJitter ?? 0, timingJitter: options.timingJitter ?? 0,
    maxDurationMs: SCRIPT_LIMITS.previewDurationMs, ...options.tempo === undefined ? {} : { tempo: options.tempo } })
  return { kind: 'reply-motion-plan-preview', executable: false, reply: options.reply, clipName: checked.name,
    seed: preview.seed, playback: checked.playback, preview, budgetMs,
    finish: checked.playback === 'loop' ? 'finite-loop-budget' : preview.durationMs <= budgetMs ? 'full-clip' : 'protection-will-stop',
    phase: 'active', elapsedMs: 0 }
}

export type ReplyPlanEvent =
  | { readonly type: 'bubble'; readonly reply: string }
  | { readonly type: 'elapsed'; readonly ms: number }
  | { readonly type: 'pause' | 'resume' }
  | { readonly type: PlanStopReason }

/** 模拟状态机：气泡只继承；终止优先且不可被 resume/bubble 复活；暂停冻结进度。 */
export function reduceReplyPlan(plan: ReplyMotionPlan, event: ReplyPlanEvent): ReplyMotionPlan {
  if (plan.phase === 'stopped') return plan
  // 同轮和无关会话气泡均不会重新选片段、增加预算或改变进度。
  if (event.type === 'bubble') return plan
  if (event.type === 'pause') return plan.phase === 'paused' ? plan : { ...plan, phase: 'paused' }
  if (event.type === 'resume') return plan.phase === 'active' ? plan : { ...plan, phase: 'active' }
  if (event.type === 'elapsed') {
    integer(event.ms, 0, SCRIPT_LIMITS.previewDurationMs, '经过时长')
    if (plan.phase === 'paused') return plan
    const completion = plan.playback === 'once' ? plan.preview.durationMs : Infinity
    const stopAt = Math.min(completion, plan.budgetMs)
    const elapsedMs = Math.min(plan.elapsedMs + event.ms, stopAt)
    if (elapsedMs >= stopAt) return { ...plan, elapsedMs, phase: 'stopped', stopReason: completion <= plan.budgetMs ? 'completed' : 'timeout' }
    return { ...plan, elapsedMs }
  }
  return { ...plan, phase: 'stopped', stopReason: event.type }
}
