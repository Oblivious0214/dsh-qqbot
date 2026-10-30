/**
 * 把助手回复的文字读成要显示的 [qq] 段落。严格解析见共享协议；这里只加一层"坏了尽量显示文字"：
 * - 流式时严格解析失败，不再推进，保持上次读到的段落，等回复结束；
 * - 回复结束后仍失败，用 salvageTimedReply 抽出文字（不带动作，段落标 salvaged），
 *   抽出的前几段和已经读到的一致时接着显示，不一致或抽不出来时显示错误提示。
 */

import { parseTimedStream, salvageTimedReply, type TimedStream } from '../vendor/dialogue-timing/protocol.js'

export const INVALID_REPLY = '分段回复格式无效，请让 AI 重试。'

export interface DecodedReply {
  readonly stream: TimedStream | null
  /** 不能显示时给用户看的提示；为空表示没有错误（或还在生成）。 */
  readonly error: string
}

/** previous 是这条回复上一次成功读到的段落，没有时为 null。 */
export function decodeReply(source: string, running: boolean, previous: TimedStream | null): DecodedReply {
  try {
    return { stream: parseTimedStream(source), error: '' }
  } catch {
    if (running) return { stream: previous && { stages: previous.stages, complete: false }, error: '' }
    const salvaged = salvageTimedReply(source)
    const head = previous?.stages ?? []
    if (salvaged === null || head.some((stage, i) => stage.text !== salvaged.stages[i]?.text)) {
      return { stream: null, error: INVALID_REPLY }
    }
    return { stream: { stages: [...head, ...salvaged.stages.slice(head.length)], complete: true }, error: '' }
  }
}
