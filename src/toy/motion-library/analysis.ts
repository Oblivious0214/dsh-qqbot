import { parsePoints, sliceScript, type MotionPoint, type MotionScript } from './script.ts'

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

export interface LoopCandidate extends MotionScript {
  readonly fromMs: number
  readonly toMs: number
  readonly periodMs: number
  readonly observedRepeats: number
  readonly maxPositionError: number
  readonly observedCoverage: number
  readonly reviewRequired: true
}

export interface LoopAnalysis {
  readonly candidates: readonly LoopCandidate[]
  readonly fallback: 'keep-original'
  readonly reason: 'repeated-waveform-found' | 'no-reliable-repeat' | 'search-limited'
}

function sampled(points: readonly MotionPoint[]): number[] {
  const start = points[0]!.at, duration = points[points.length - 1]!.at - start
  let i = 1
  return Array.from({ length: 65 }, (_, n) => {
    const at = start + duration * n / 64
    while (i < points.length - 1 && points[i]!.at < at) i++
    const a = points[i - 1]!, b = points[i]!
    return a.pos + (b.pos - a.pos) * (at - a.at) / (b.at - a.at)
  })
}

/** 对两段所有折点的归一化时间取并集，避免固定采样漏掉很窄的尖峰。 */
function maximumDeviation(a: readonly MotionPoint[], b: readonly MotionPoint[]): number {
  const aStart = a[0]!.at, bStart = b[0]!.at
  const aDuration = a[a.length - 1]!.at - aStart, bDuration = b[b.length - 1]!.at - bStart
  const phases = [...a.map(p => (p.at - aStart) / aDuration), ...b.map(p => (p.at - bStart) / bDuration)].sort((x, y) => x - y)
  let ai = 1, bi = 1, error = 0
  for (const phase of phases) {
    const at = aStart + phase * aDuration, bt = bStart + phase * bDuration
    while (ai < a.length - 1 && a[ai]!.at < at) ai++
    while (bi < b.length - 1 && b[bi]!.at < bt) bi++
    const leftA = a[ai - 1]!, rightA = a[ai]!, leftB = b[bi - 1]!, rightB = b[bi]!
    const ap = leftA.pos + (rightA.pos - leftA.pos) * (at - leftA.at) / (rightA.at - leftA.at)
    const bp = leftB.pos + (rightB.pos - leftB.pos) * (bt - leftB.at) / (rightB.at - leftB.at)
    error = Math.max(error, Math.abs(ap - bp))
  }
  return error
}

/** 保守启发式：至少三个相近周期，闭合谷点、相近周期与形状；从不强拼首尾。 */
export function analyzeLoops(script: MotionScript): LoopAnalysis {
  const points = parsePoints(script.points)
  const valleys: number[] = []
  let direction = 0
  for (let i = 1; i < points.length; i++) {
    const sign = Math.sign(points[i]!.pos - points[i - 1]!.pos)
    if (sign === 0) continue
    if (sign > 0 && direction <= 0) valleys.push(i - 1)
    direction = sign
  }
  if (direction < 0) valleys.push(points.length - 1)
  const candidates: LoopCandidate[] = []
  const visited = new Set<string>()
  const maxStarts = Math.min(valleys.length, 128)
  for (let start = 0; start < maxStarts; start++) {
    for (let span = 1; span <= 4 && start + span * 3 < valleys.length; span++) {
      const from = points[valleys[start]!]!.at
      const to = points[valleys[start + span]!]!.at
      const period = to - from
      if (period < 400 || period > 8000) continue
      const cycle = points.slice(valleys[start]!, valleys[start + span]! + 1)
      if (Math.abs(cycle[0]!.pos - cycle[cycle.length - 1]!.pos) > 1e-6) continue
      const features = analyzeFeatures({ points: cycle })
      if (features.maxPosition - features.minPosition < 5) continue
      const reference = sampled(cycle)
      let repeats = 1, worstError = 0
      for (let r = 1; r < 8 && start + span * (r + 1) < valleys.length; r++) {
        const next = points.slice(valleys[start + span * r]!, valleys[start + span * (r + 1)]! + 1)
        const duration = next[next.length - 1]!.at - next[0]!.at
        if (Math.abs(duration - period) / period > 0.08) break
        const sample = sampled(next)
        const errors = sample.map((v, i) => Math.abs(v - reference[i]!))
        const maxError = maximumDeviation(cycle, next)
        const rms = Math.sqrt(errors.reduce((sum, v) => sum + v * v, 0) / errors.length)
        if (maxError > 3 || rms > 1.5) break
        worstError = Math.max(worstError, maxError)
        repeats++
      }
      if (repeats < 3) continue
      // 同一相位形状和周期只给一个候选，避免重复周期占满目录。
      const signature = `${Math.round(period / 50)}:${reference.map(n => Math.round(n)).join(',')}`
      if (visited.has(signature)) continue
      visited.add(signature)
      const whole = points[points.length - 1]!.at - points[0]!.at
      candidates.push({ ...sliceScript(script, from, to), fromMs: from, toMs: to, periodMs: period,
        observedRepeats: repeats, maxPositionError: worstError,
        observedCoverage: (points[valleys[start + span * repeats]!]!.at - from) / whole, reviewRequired: true })
    }
  }
  candidates.sort((a, b) => a.periodMs - b.periodMs || b.observedCoverage - a.observedCoverage || a.fromMs - b.fromMs)
  return { candidates: candidates.slice(0, 3), fallback: 'keep-original',
    reason: candidates.length ? 'repeated-waveform-found' : valleys.length > 128 ? 'search-limited' : 'no-reliable-repeat' }
}
