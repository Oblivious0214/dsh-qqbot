import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeActionLibrary } from '../../src/toy/client/settings-merge.ts'
import { MotionPlayer } from '../../src/toy/client/player.ts'
import { defaultMotion, tierBudget } from '../../src/toy/core/config.ts'
import { outputBounds } from '../../src/toy/core/motion.ts'
import { parseActionLibrary, presetRuntime } from '../../src/toy/motion-library/config.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { ActionLibraryStore } from '../../src/toy/motion-library/store.ts'
import { FakeClock, MockTransport } from './fakes.ts'

describe('独立爆发预设', () => {
  it('校验非空、有效动作和权重，爆发选择不改变模型的三档目录', () => {
    const base = defaultActionLibrary()
    const burstPool = [{ name: '滑动', weight: 'high' as const }]
    expect(parseActionLibrary({ ...base, burstPool }).burstPool).toEqual(burstPool)
    expect(presetRuntime({ ...base, burstPool })).toBe(presetRuntime(base))
    for (const pool of [[], [{ name: '不存在', weight: 'low' }], [{ name: '滑动', weight: 'invalid' }], [...burstPool, ...burstPool]]) {
      expect(() => parseActionLibrary({ ...base, burstPool: pool })).toThrow()
    }
  })

  it('独立写入索引、重开恢复、上一版备份保留爆发选择，三档池保持原样', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toy-burst-pool-'))
    const store = ActionLibraryStore.at(dir, () => {})
    const base = store.value
    const saved = store.save({ ...base, burstPool: [{ name: '滑动', weight: 'medium' }] })
    expect(saved.pools).toEqual(base.pools)
    expect(ActionLibraryStore.at(dir, () => {}).value).toEqual(saved)
    store.save({ ...saved, burstPool: [{ name: '渐快', weight: 'high' }] })
    expect(JSON.parse(readFileSync(join(dir, 'motion-library.json.bak'), 'utf8')).burstPool).toEqual(saved.burstPool)
  })

  it('爆发与中速选择并发保存互不覆盖，动作改名后爆发引用跟随', () => {
    const base = defaultActionLibrary()
    const burst = { ...base, burstPool: [{ name: '滑动', weight: 'high' as const }] }
    const medium = { ...base, pools: { ...base.pools, medium: [{ name: '渐快', weight: 'low' as const }] } }
    const merged = mergeActionLibrary(base, burst, medium)
    expect(merged.burstPool).toEqual(burst.burstPool)
    expect(merged.pools.medium).toEqual(medium.pools.medium)
    const renamed = { ...merged, library: { ...merged.library, clips: merged.library.clips.map(c => c.name === '滑动' ? { ...c, name: '改名滑动' } : c) },
      pools: Object.fromEntries(Object.entries(merged.pools).map(([key, pool]) => [key, pool.map(e => e.name === '滑动' ? { ...e, name: '改名滑动' } : e)])) as typeof merged.pools,
      burstPool: [{ name: '改名滑动', weight: 'high' as const }] }
    const changed = { ...merged, burstPool: [{ name: '滑动', weight: 'low' as const }] }
    expect(mergeActionLibrary(merged, changed, renamed).burstPool).toEqual([{ name: '改名滑动', weight: 'low' }])
  })

  it.each([80, 300])('爆发只播放所选动作，遵守速度上限 %i 和暂停／超时', async maxSpeed => {
    const clock = new FakeClock()
    const transport = new MockTransport(clock)
    const player = new MotionPlayer(transport, {}, clock)
    const base = defaultActionLibrary()
    // 单次动作播完后继续从爆发池选择。
    const clip = { ...base.library.clips.find(c => c.name === '滑动')!, playback: 'once' as const }
    const library = { ...base, library: { ...base.library, clips: base.library.clips.map(c => c.id === clip.id ? clip : c) },
      burstPool: [{ name: clip.name, weight: 'low' as const }] }
    player.configure({ ...defaultMotion(), maxSpeed, minPosition: 20, maxPosition: 60 })
    player.configureLibrary(library)
    player.burst(library, 20000)
    await clock.advance(3000)
    expect(player.presetName).toBe(clip.name)
    expect(transport.moves.length).toBeGreaterThan(0)
    expect(transport.moves.every(m => m.position >= 20 && m.position <= 60 && m.limits.maxSpeed <= maxSpeed)).toBe(true)
    player.pause()
    const count = transport.moves.length
    await clock.advance(10000)
    expect(transport.moves).toHaveLength(count)
    player.resume()
    await clock.advance(15000)
    expect(player.presetName).toBe(clip.name)
    await clock.advance(3000)
    expect(player.mode).toBe('ai')
    expect(player.intent).toBeNull()
    player.dispose()
  })

  it('温存只播放温存池里的动作，用慢档、靠龟头的浅行程；没单独保存时沿用慢档池', async () => {
    const clock = new FakeClock()
    const transport = new MockTransport(clock)
    const player = new MotionPlayer(transport, {}, clock)
    const base = defaultActionLibrary()
    const config = { ...defaultMotion(), maxSpeed: 300 }
    const [low, high] = outputBounds({ range: 'upper', tier: 'low', action: 'auto' }, config)
    player.configure(config)
    const library = { ...base, aftercarePool: [{ name: '滑动', weight: 'low' as const }] }
    expect(parseActionLibrary(library).aftercarePool).toEqual(library.aftercarePool)
    player.configureLibrary(library)
    player.aftercare(library, 10000)
    await clock.advance(1000)
    expect(player.mode).toBe('aftercare')
    expect(player.presetName).toBe('滑动')
    const start = clock.now()
    await clock.advance(5000)
    const moves = transport.moves.filter(m => m.at > start)
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.every(m => m.position >= low && m.position <= high && m.limits.maxSpeed <= tierBudget(config, 'low').max)).toBe(true)
    await clock.advance(5000)
    expect(player.mode).toBe('ai')

    player.aftercare(base, 10000)
    await clock.advance(1000)
    expect(base.pools.low.map(e => e.name)).toContain(player.presetName)
    player.dispose()
  })

  it('温存池校验、保存和改名合并与爆发池一致', () => {
    const base = defaultActionLibrary()
    expect(() => parseActionLibrary({ ...base, aftercarePool: [] })).toThrow()
    const dir = mkdtempSync(join(tmpdir(), 'toy-aftercare-pool-'))
    const store = ActionLibraryStore.at(dir, () => {})
    const saved = store.save({ ...store.value, aftercarePool: [{ name: '滑动', weight: 'medium' }] })
    expect(ActionLibraryStore.at(dir, () => {}).value.aftercarePool).toEqual(saved.aftercarePool)
    const edited = { ...base, aftercarePool: [{ name: '滑动', weight: 'high' as const }] }
    const other = { ...base, burstPool: [{ name: '渐快', weight: 'low' as const }] }
    const merged = mergeActionLibrary(base, edited, other)
    expect(merged.aftercarePool).toEqual(edited.aftercarePool)
    expect(merged.burstPool).toEqual(other.burstPool)
  })
})
