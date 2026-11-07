import { parsePoints, sliceScript, type MotionScript } from './script.ts'

export interface ClipFeatures {
  readonly durationMs: number
  readonly minPosition: number
  readonly maxPosition: number
  readonly reversals: number
  readonly holdFraction: number
}

export function analyzeFeatures(script: MotionScript): ClipFeatures {
  const points = parsePoints(script.points)
  let minPosition = 100, maxPosition = 0, reversals = 0, holds = 0, direction = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    minPosition = Math.min(minPosition, p.pos)
    maxPosition = Math.max(maxPosition, p.pos)
    if (i === 0) continue
    const before = points[i - 1]!
    const sign = Math.sign(p.pos - before.pos)
    if (sign === 0) holds += p.at - before.at
    else { if (direction !== 0 && direction !== sign) reversals++; direction = sign }
  }
  const durationMs = points[points.length - 1]!.at - points[0]!.at
  return { durationMs, minPosition, maxPosition, reversals, holdFraction: holds / durationMs }
}

export interface DescriptionDraft {
  readonly text: string
  readonly source: 'objective' | 'ai-draft'
  readonly requiresReview: true
}

/** 接受外部 AI 返回的数据而非执行回调；失败或无效时使用客观特征初稿。 */
export function descriptionDraft(script: MotionScript, result?: { readonly ok: boolean; readonly text?: unknown }): DescriptionDraft {
  const features = analyzeFeatures(script)
  if (result?.ok === true && typeof result.text === 'string') {
    const text = result.text.trim()
    if (text.length > 0 && text.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(text)) return { text, source: 'ai-draft', requiresReview: true }
  }
  return {
    text: `${(features.durationMs / 1000).toFixed(2)} 秒；相对位置 ${features.minPosition.toFixed(1)}–${features.maxPosition.toFixed(1)}；换向 ${features.reversals} 次；停留约 ${Math.round(features.holdFraction * 100)}%。`,
    source: 'objective', requiresReview: true,
  }
}

/** 受限时间表达式解析；只产生待预览范围，不能自动保存或播放。 */
export function selectTimeRange(script: MotionScript, text: string): { fromMs: number; toMs: number; script: MotionScript } {
  if (typeof text !== 'string' || text.length > 500) throw new Error('请用“从 x 秒到 y 秒”指定一段时间')
  const matches = [...text.matchAll(/从\s*(\d+(?:\.\d{1,3})?)\s*秒\s*(?:到|至|[-~～])\s*(\d+(?:\.\d{1,3})?)\s*秒/gu)]
  if (matches.length !== 1) throw new Error('请明确指定一个“从 x 秒到 y 秒”的范围')
  const fromMs = Math.round(Number(matches[0]![1]) * 1000)
  const toMs = Math.round(Number(matches[0]![2]) * 1000)
  return { fromMs, toMs, script: sliceScript(script, fromMs, toMs) }
}
