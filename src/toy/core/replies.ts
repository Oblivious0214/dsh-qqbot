/**
 * 从 [qq] 分段回复里读出设备动作。显示由 dsh-qqbot 负责，这里只回答两件事：
 * 每一段显示时设备该做什么。段落停留时间由控制器按联动设置决定。
 *
 * 规则迁移自 dsh-serveu 的 live-stream.js（流式解析）和 definition-live.js（inheritLiveIntent、resolveLiveTiming）。
 * 不再接受独立的 [dsh-intent] 块，动作只能写在 [qq] 段落的 motion 里。
 */

import { parseFinishedReply, parseTimedStream, proseOnly, type TimedStage } from '../../vendor/dialogue-timing/protocol.js'
import { reduceIntent, type Intent } from './intent.ts'

/** 段落里设备相关的字段：motion。 */
export type MotionStage = TimedStage

export interface StreamedReply {
  readonly stages: readonly MotionStage[]
  /** 已经读到 [/qq]。false 时只含已经闭合的段落，后面还会有。 */
  readonly complete: boolean
}

/**
 * 解析可能还在流式输出的回复，读法见共享协议的 parseTimedStream。没有 [qq] 块时返回 null。
 * 回复结束时缺 [/qq] 按已结束处理（见 parseFinishedReply）；格式读不出、或有块却没有段落时抛出。
 */
export function parseStream(text: string, finished: boolean): StreamedReply | null {
  if (!finished) return parseTimedStream(text)
  const stream = parseFinishedReply(text)
  if (stream === null && proseOnly(text).includes('[qq]')) throw new Error('分段回复没有可用段落')
  return stream
}

/**
 * 每一段显示时设备该做什么：
 * - `Intent`：按这个选择运动（和正在运行的相同时不重启节奏）；
 * - `null`：停止；
 * - `undefined`：不改变。
 *
 * `previous` 是本会话最近已显示段落的选择。第一处 motion 只写变化项时在它上面补全；
 * 第一段没写 motion 时沿用它（新回复延续当前动作）。停止之后再启动须三项齐全。
 * 无效动作或抢救文字段视为停止并清空选择；后续有效段仍单独解析。
 */
export function resolveStageIntents(stages: readonly MotionStage[], previous: Intent | null): (Intent | null | undefined)[] {
  let current = previous
  return stages.map((stage, index) => {
    if (stage.salvaged === true) return current = null
    if (stage.motion === undefined) return index === 0 ? current ?? undefined : undefined
    try { current = reduceIntent(current, stage.motion) } catch { current = null }
    return current
  })
}

