/** 只读显示，参考旧 dsh-serveu 的 stage-display.js；同一作者，以 MIT 重写。 */
import { AUTO_ACTION, intentPosition, RANGE_LABELS, TIER_LABELS, reduceIntent, type Intent } from '../core/intent.ts'
import type { MotionConfig } from '../core/config.ts'
import type { SegmentStage } from './controller.ts'
import type { ComponentType } from 'react'

/** 与 qqbotSegments.annotate 的结构契约一致；运行时不导入 QQbot。 */
export interface SegmentPlayback {
  readonly index: number
  readonly status: 'history' | 'running' | 'paused' | 'complete' | 'interrupted' | 'failed' | 'closed'
  readonly remainingMs: number
}
export interface SegmentAnnotationProps {
  readonly session: string
  readonly reply: string
  readonly stages: readonly SegmentStage[]
  readonly index: number
  readonly playback: () => SegmentPlayback | undefined
}
export type Annotate = (component: ComponentType<SegmentAnnotationProps>) => () => void

/** chosen：播放器实际选中的动作名；和写的名称不同（auto 或不在该档动作池）时标为自动选择。 */
export function describeAction(intent: Intent | null, config?: MotionConfig, chosen?: string): string {
  if (intent === null) return '停止'
  const position = config === undefined ? '' : ` ${intentPosition(intent, config).map(value => Number(value.toFixed(1))).join('–')}`
  const auto = intent.action === AUTO_ACTION || (chosen !== undefined && chosen.toLowerCase() !== intent.action.toLowerCase())
  const action = !auto ? intent.action : chosen === undefined ? '自动选择' : `自动选择 · ${chosen}`
  return `${RANGE_LABELS[intent.range]}${position} · ${TIER_LABELS[intent.tier]}速 · ${action}`
}

/** 历史只在本条回复内解析继承。跨回复选择和当时的数值设置未知，绝不借用当前设备状态。 */
export function historicalAction(stages: readonly SegmentStage[], index: number): string {
  let intent: Intent | null = null
  let known = false
  for (const stage of stages.slice(0, index + 1)) {
    if (stage.salvaged) return '动作信息不可用'
    if (stage.motion === undefined) continue
    try { intent = reduceIntent(intent, stage.motion); known = true } catch { return '动作信息不完整或无效' }
  }
  if (!known) return '无动作'
  return `${describeAction(intent)}${stages[index]?.motion === undefined ? ' · 沿用' : ''}`
}

export interface TailPlayback { readonly remainingMs: number; readonly paused: boolean; readonly standby?: boolean }
const seconds = (ms: number) => (Math.ceil(Math.max(0, ms) / 100) / 10).toFixed(1)

export function countdownLabel(index: number, playback: SegmentPlayback | undefined, tail?: TailPlayback): string | undefined {
  if (playback === undefined || playback.status === 'history') return undefined
  if (index < playback.index) return undefined
  if (index > playback.index) return undefined
  if (playback.status === 'interrupted' || playback.status === 'closed') return '已取消'
  if (playback.status === 'failed') return '未完成'
  if (playback.status === 'complete') {
    return tail === undefined ? undefined : `${tail.paused ? '已暂停 · ' : ''}${Number.isFinite(tail.remainingMs) ? `${seconds(tail.remainingMs)} 秒后${tail.standby ? '转入待机' : '自动停止'}` : '不自动停止'}`
  }
  if (playback.status === 'paused') return `已暂停 · 剩余 ${seconds(playback.remainingMs)} 秒`
  return playback.remainingMs > 0 ? `剩余 ${seconds(playback.remainingMs)} 秒` : '等待下一段'
}
