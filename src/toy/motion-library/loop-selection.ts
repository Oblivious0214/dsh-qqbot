import { closeLoop, parsePoints, sliceScript, SCRIPT_LIMITS, type MotionPoint, type MotionScript } from './script.ts'

export interface LoopSelection extends MotionScript {
  readonly fromMs: number
  readonly toMs: number
  readonly method: 'natural' | 'tail'
}

const WINDOW_MS = 2000
// 整数毫秒取整造成的位置误差最多容许 0.1；只将最后一个点对齐起点，不改中间原点。
const POSITION_ERROR = .1
const SPEED_RATIO = .75
const BIN_SCALE = 1 / Math.log(1 / SPEED_RATIO)
type Cut = { at: number; pos: number; before: number; after: number; leftAt: number; leftPos: number; phase: string; beforeBin: number; afterBin: number }
const speedBin = (speed: number) => speed === 0 ? 0 : Math.floor(Math.log(Math.abs(speed)) * BIN_SCALE)
const bins = (speed: number, bin: number) => speed === 0 ? [0] : [bin - 1, bin, bin + 1]
const key = (position: number, phase: string, before: number, after: number) => `${position}:${phase}:${before}:${after}`
const speedMatches = (a: number, b: number) => Math.sign(a) === Math.sign(b) && (a === 0 || Math.min(Math.abs(a), Math.abs(b)) / Math.max(Math.abs(a), Math.abs(b)) >= SPEED_RATIO - 1e-9)
const cycle = (fromMs: number, toMs: number, method: LoopSelection['method'], points: readonly MotionPoint[]): LoopSelection => {
  if (points.length >= 3) return { fromMs, toMs, method, points }
  const first = points[0]!, last = points[1]!
  // 动作库循环需要至少三个点；纯停留加等值中点，1ms 极短段追加一毫秒停留。
  return last.at >= 2 ? { fromMs, toMs, method, points: [first,{at:Math.floor(last.at/2),pos:first.pos},last] }
    : { fromMs, toMs, method:'tail', points:[first,last,{at:2,pos:first.pos}] }
}

/** 按整数毫秒扫描局部原始线段，折点两侧分别保留速度，识别往返、换向和停留的相位。 */
function cuts(points: readonly MotionPoint[], low: number, high: number): Cut[] {
  let i = 1
  const slope = (right: number) => (points[right]!.pos - points[right-1]!.pos) / (points[right]!.at - points[right-1]!.at)
  const result: Cut[] = []
  for (let at = low; at <= high; at++) {
    while (i < points.length - 1 && points[i]!.at < at) i++
    const a = points[i-1]!, b = points[i]!, before = slope(i)
    const after = at === b.at && i < points.length - 1 ? slope(i+1) : before
    result.push({ at, pos: a.pos + (b.pos-a.pos) * (at-a.at)/(b.at-a.at), before, after, leftAt:a.at, leftPos:a.pos,
      phase: `${Math.sign(before)}:${Math.sign(after)}`, beforeBin: speedBin(before), afterBin: speedBin(after) })
  }
  return result
}

/** 唯一的循环准备入口：预览和保存共用相同原始源、手选范围和确定性结果。 */
export function prepareLoopSelection(script: MotionScript, fromMs: number, toMs: number): LoopSelection {
  const points = parsePoints(script.points), source = { points }, selected = sliceScript(source, fromMs, toMs)
  const first = points[0]!.at, last = points.at(-1)!.at
  // 源边界外没有上下文可比较；已有闭合整段保持原样，也避免重开已保存循环时再次漂移。
  if (selected.points[0]!.pos === selected.points.at(-1)!.pos && (fromMs === first || toMs === last)) {
    return cycle(fromMs,toMs,'natural',selected.points)
  }
  const starts = cuts(points, Math.max(first, fromMs-WINDOW_MS), Math.min(last-1, fromMs+WINDOW_MS))
    .sort((a,b) => Math.abs(a.at-fromMs)-Math.abs(b.at-fromMs) || a.at-b.at)
  const ends = cuts(points, Math.max(first+1, toMs-WINDOW_MS), Math.min(last, toMs+WINDOW_MS))
    .sort((a,b) => Math.abs(a.at-toMs)-Math.abs(b.at-toMs) || a.at-b.at)
  const index = new Map<string, Cut[]>()
  for (const end of ends) {
    const k = key(Math.floor(end.pos/POSITION_ERROR), end.phase, end.beforeBin, end.afterBin)
    const bucket = index.get(k)
    if (bucket) bucket.push(end)
    else index.set(k, [end])
  }
  const minDuration = Math.max(1, Math.ceil((toMs-fromMs)/2))
  const maxDuration = Math.min(SCRIPT_LIMITS.clipDurationMs, toMs-fromMs + Math.min(WINDOW_MS*2,Math.floor((toMs-fromMs)/2)))
  let best: { start: Cut; end: Cut; distance: number; error: number; startShift: number } | undefined
  for (const start of starts) {
    const startShift = Math.abs(start.at-fromMs)
    if (best && startShift > best.distance) break
    const position = Math.floor(start.pos/POSITION_ERROR)
    for (const before of bins(start.before, start.beforeBin)) for (const after of bins(start.after, start.afterBin)) for (const p of [position-1,position,position+1]) {
      for (const end of index.get(key(p,start.phase,before,after)) ?? []) {
        const distance = startShift + Math.abs(end.at-toMs)
        if (best && distance > best.distance) break
        const duration = end.at-start.at, error = Math.abs(start.pos-end.pos)
        if (duration < minDuration || duration > maxDuration || error > POSITION_ERROR || !speedMatches(start.before,end.before) || !speedMatches(start.after,end.after)) continue
        // 毫秒取整后对齐终点也应保持最后一小段的方向和速度，避免在密集折点旁制造突变。
        const leftPos = end.leftAt > start.at ? end.leftPos : start.pos
        const joinedSpeed = (start.pos-leftPos)/(end.at-Math.max(end.leftAt,start.at))
        if (error > 1e-9 && (!speedMatches(joinedSpeed,end.before) || !speedMatches(joinedSpeed,start.before))) continue
        if (!best || distance < best.distance || distance === best.distance && (error < best.error || error === best.error && startShift < best.startShift)) {
          best = { start, end, distance, error, startShift }
        }
      }
    }
    if (best?.distance === 0) break
  }
  if (best) {
    const natural = sliceScript(source,best.start.at,best.end.at).points.slice()
    natural[natural.length-1] = { ...natural.at(-1)!, pos: natural[0]!.pos }
    return cycle(best.start.at,best.end.at,'natural',natural)
  }
  return cycle(fromMs,toMs,'tail',closeLoop(selected.points))
}
