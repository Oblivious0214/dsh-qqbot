import { describe, expect, it } from 'vitest'
import { prepareLoopSelection } from '../../../src/toy/motion-library/loop-selection.ts'
import { closeLoop, sliceScript, type MotionScript } from '../../../src/toy/motion-library/script.ts'
import { emptyLibrary, saveClip } from '../../../src/toy/motion-library/library.ts'

const wave = (offset = 0): MotionScript => ({ points: Array.from({ length: 25 }, (_,i) => ({ at: offset+i*500, pos: i%2 ? 100 : 0 })) })
describe('用户选区两端的自然衔接', () => {
  it('前后各2秒内按同位置、同相位、相近速度寻找最近原点节奏', () => {
    const source = wave(), result = prepareLoopSelection(source,1030,5070)
    expect(result).toMatchObject({ method:'natural', fromMs:1030, toMs:5030 })
    expect(result.points).toEqual(sliceScript(source,1030,5030).points)
    expect(result.points.at(-1)!.at).toBe(4000)
    expect(source).toEqual(wave())
    expect(prepareLoopSelection(source,1030,5070)).toEqual(result)
  })
  it('已经自然衔接的范围保持原样，不反复吸附漂移', () => {
    const source = wave(), result = prepareLoopSelection(source,1030,5030)
    expect(result).toMatchObject({ method:'natural', fromMs:1030, toMs:5030 })
    expect(prepareLoopSelection(result,0,4000).points).toEqual(result.points)
  })
  it('换向点需要两侧相位一致，保留原始谷点而不补人工回程', () => {
    expect(prepareLoopSelection(wave(),1000,5010)).toMatchObject({ method:'natural', fromMs:1000, toMs:5000 })
  })
  it('非零源起点及文件边缘收窄搜索，不访问源外时间', () => {
    const result = prepareLoopSelection(wave(100),1130,5170)
    expect(result).toMatchObject({ method:'natural', fromMs:1130, toMs:5130 })
    const edge = prepareLoopSelection(wave(100),100,12100)
    expect(edge).toMatchObject({ method:'natural', fromMs:100, toMs:12100 })
  })
  it.each([
    [{points:[{at:0,pos:0},{at:5000,pos:50},{at:10000,pos:0},{at:15000,pos:100},{at:20000,pos:0}]},3000,13000,'速度相差过大'],
    [{points:[{at:0,pos:0},{at:5000,pos:100},{at:10000,pos:0}]},3000,8000,'运动方向相反'],
  ] as const)('%s 找不到自然接点时沿用手选范围补尾', (source,from,to) => {
    const result = prepareLoopSelection(source,from,to)
    expect(result).toMatchObject({ method:'tail', fromMs:from, toMs:to })
    expect(result.points).toEqual(closeLoop(sliceScript(source,from,to).points))
  })
  it('短选区不会被压成零长或扩成附近一整轮', () => {
    const result = prepareLoopSelection(wave(),1030,1040)
    expect(result).toMatchObject({ method:'tail', fromMs:1030, toMs:1040 })
    expect(result.points[0]!.pos).toBe(result.points.at(-1)!.pos)
  })
  it('密集折点旁对齐终点也不制造反向或突然加速的小尾巴', () => {
    const source = {points:[{at:0,pos:0},{at:1000,pos:1},{at:1001,pos:1.03},{at:2000,pos:30},{at:3000,pos:0},{at:5000,pos:1.02},{at:5001,pos:1.05},{at:6000,pos:31.02}]}
    const result = prepareLoopSelection(source,1001,5001)
    expect(result.method).toBe('natural')
    expect([result.fromMs,result.toMs]).not.toEqual([1001,5001])
    const firstSpeed = (result.points[1]!.pos-result.points[0]!.pos)/(result.points[1]!.at-result.points[0]!.at)
    const end = result.points.at(-1)!, before = result.points.at(-2)!, lastSpeed = (end.pos-before.pos)/(end.at-before.at)
    expect(Math.sign(lastSpeed)).toBe(Math.sign(firstSpeed))
    expect(Math.min(Math.abs(firstSpeed),Math.abs(lastSpeed))/Math.max(Math.abs(firstSpeed),Math.abs(lastSpeed))).toBeGreaterThanOrEqual(.75)
  })
  it('超过2秒的接点不会被采用，停留末尾仍能补尾', () => {
    const source = {points:[{at:0,pos:0},{at:10000,pos:90},{at:20000,pos:90}]}
    const result = prepareLoopSelection(source,5000,18000)
    expect(result).toMatchObject({method:'tail',fromMs:5000,toMs:18000})
    expect(result.points.at(-1)!.pos).toBe(45)
  })
  it('预览数据直接保存，保存过程不会再次移动已匹配的范围', () => {
    const source = wave(), preview = prepareLoopSelection(source,1030,5070)
    const saved = saveClip(emptyLibrary(),'自然节奏',preview,0,preview.points.at(-1)!.at,{kind:'loop'})
    expect(saved.clips[0]!.points).toEqual(preview.points)
    expect(saveClip(saved,'完整原段',source,1030,5070).clips[1]!.points).toEqual(sliceScript(source,1030,5070).points)
  })
  it.each([1,1000])('两点的纯停留选区也能保存循环（%sms）', duration => {
    const result = prepareLoopSelection({points:[{at:0,pos:50},{at:duration,pos:50}]},0,duration)
    const saved = saveClip(emptyLibrary(),'停留循环',result,0,result.points.at(-1)!.at,{kind:'loop'})
    expect(saved.clips[0]!.points).toEqual(result.points)
    expect(result.points.length).toBe(3)
  })
  it('接近600秒和20000点的源仍输出合法闭合数据', () => {
    const source = {points:Array.from({length:20000},(_,i)=>({at:i*30,pos:i/200}))}
    const result = prepareLoopSelection(source,0,599970)
    expect(result.method).toBe('tail')
    expect(result.points.length).toBeLessThanOrEqual(20000)
    expect(result.points.at(-1)!.at).toBeLessThanOrEqual(600000)
    expect(result.points.at(-1)!.pos).toBe(result.points[0]!.pos)
    expect(result.points.every((p,i)=>Number.isSafeInteger(p.at) && (!i||p.at>result.points[i-1]!.at))).toBe(true)
  })
})
