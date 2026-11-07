import type { MotionScript } from './script.ts'
export interface HeatBucket { fromMs: number; toMs: number; min: number; max: number; movement: number; coveredMs: number }
// 参照 ServeUCentral 热力图的五档配色，积分仍使用本插件原始线段。
const HEAT_COLORS = ['#244b5c', '#75b9d1', '#efce62', '#f39944', '#f53e2e'] as const
export function heatmapColor(movement: number, peak: number): string {
  const heat = peak > 0 ? Math.max(0, Math.min(1, movement / peak)) : 0
  return heat < .001 ? 'transparent' : HEAT_COLORS[Math.round(heat * (HEAT_COLORS.length - 1))]!
}
/** 原始线段与窗口桶相交积分；显示数据从不用于保存。 */
export function buildHeatmap(script: MotionScript, from: number, to: number, count: number): HeatBucket[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from || from < script.points[0]!.at || to > script.points.at(-1)!.at) throw new Error('热力图窗口无效')
  const n = Math.min(1024, Math.max(1, Math.floor(count)))
  const buckets: HeatBucket[] = []
  let cursor = 1
  for (let i = 0; i < n; i++) {
    const a = Math.round(from + (to - from) * i / n), b = Math.round(from + (to - from) * (i + 1) / n)
    if (b <= a) continue
    const bucket: HeatBucket = { fromMs: a, toMs: b, min: 100, max: 0, movement: 0, coveredMs: 0 }
    while (cursor < script.points.length - 1 && script.points[cursor]!.at <= a) cursor++
    for (let j = cursor; j < script.points.length; j++) {
      const l = script.points[j - 1]!, r = script.points[j]!
      if (l.at >= b) break
      const x = Math.max(a, l.at), y = Math.min(b, r.at)
      if (y <= x) continue
      const p = l.pos + (r.pos - l.pos) * (x - l.at) / (r.at - l.at), q = l.pos + (r.pos - l.pos) * (y - l.at) / (r.at - l.at)
      bucket.min = Math.min(bucket.min, p, q); bucket.max = Math.max(bucket.max, p, q)
      bucket.movement += Math.abs(q - p); bucket.coveredMs += y - x
    }
    buckets.push(bucket)
  }
  return buckets
}
