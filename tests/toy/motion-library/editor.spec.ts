import { describe, it, expect } from 'vitest'
import { buildHeatmap, heatmapColor } from '../../../src/toy/motion-library/heatmap.ts'
import { sliceScript } from '../../../src/toy/motion-library/script.ts'
import { emptyLibrary, saveClip, updateClip } from '../../../src/toy/motion-library/library.ts'
const source = {points:[{at:100,pos:0},{at:500,pos:0},{at:501,pos:100},{at:502,pos:0},{at:1100,pos:0}]}
describe('编辑器原始数据边界',()=>{
 it('相对运动量使用五档配色，静止透明且不依赖绝对强度',()=>{
  expect([0, .01, .25, .5, .75, 1].map(n=>heatmapColor(n,1))).toEqual(['transparent','#244b5c','#75b9d1','#efce62','#f39944','#f53e2e'])
  expect(heatmapColor(0,0)).toBe('transparent')
  expect(heatmapColor(25,50)).toBe(heatmapColor(.5,1))
 })
 it('非零起点、窄峰、停留和缩放积分',()=>{
  const b=buildHeatmap(source,100,1100,10)
  expect(Math.max(...b.map(x=>x.max))).toBe(100)
  expect(b.reduce((s,x)=>s+x.movement,0)).toBe(200)
  expect(b.reduce((s,x)=>s+x.coveredMs,0)).toBe(1000)
  expect(buildHeatmap(source,500,502,2).map(x=>x.max)).toEqual([100,100])
  expect(source.points[0]!.at).toBe(100)
 })
 it('跨点裁剪、重复名失败不影响多次保存',()=>{
  const points=sliceScript(source,300,700).points
  expect(points[0]).toEqual({at:0,pos:0});expect(points.at(-1)).toEqual({at:400,pos:0})
  const a=saveClip(emptyLibrary(),'片段',source,300,700)
  expect(()=>saveClip(a,'片段',source,100,1100)).toThrow()
  expect(saveClip(a,'整段',source,100,1100).clips).toHaveLength(2)
  const legacy={...a,clips:a.clips.map(c=>({...c,legacyAiRepeat:true as const}))}
  expect(updateClip(legacy,'片段',{name:'改名'}).clips[0]!.legacyAiRepeat).toBe(true)
  expect(updateClip(legacy,'片段',{playback:'once'}).clips[0]!.legacyAiRepeat).toBeUndefined()
 })
})
