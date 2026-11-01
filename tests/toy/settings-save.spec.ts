import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToyHost } from '../../src/toy/index.ts'
import { ToyController } from '../../src/toy/client/controller.ts'
import { mergeActionLibrary, mergeSettings } from '../../src/toy/client/settings-merge.ts'
import { defaultSettings } from '../../src/toy/settings.ts'
import { FakeClock, MockTransport } from './fakes.ts'
import type { ToyAction } from '../../src/toy/api-types.ts'

async function setup() {
  const host = new ToyHost(mkdtempSync(join(tmpdir(), 'toy-settings-')), () => {})
  host.settings.save({ ...defaultSettings(), enabled: true, display: { actions: true, countdown: true }, authorized: true })
  const clock = new FakeClock()
  const transport = new MockTransport(clock)
  let fail = false
  const actions: ToyAction[] = []
  const controller = new ToyController({ kind: 'buttplug', clock, transport: () => transport, api: {
    get: async () => host.view(), beacon() {}, post: async action => {
      actions.push(action)
      await Promise.resolve()
      if (fail) { fail = false; throw new Error('模拟写入失败') }
      return host.view(host.apply(action))
    },
  } })
  await controller.load()
  return { controller, host, actions, fail: () => { fail = true } }
}

describe('toy settings save boundaries', () => {
  it('serializes full-snapshot callers as field mutations', async () => {
    const { controller, host } = await setup()
    const base = controller.getSnapshot().settings!
    await Promise.all([
      controller.saveSettings({ ...base, motion: { ...base.motion, maxSpeed: 400 } }),
      controller.saveSettings({ ...base, display: { actions: false, countdown: false } }),
      controller.updateSettings(latest => ({ ...latest, hotkey: 'Ctrl+KeyM' })),
    ])
    expect(host.settings.value.motion.maxSpeed).toBe(400)
    expect(host.settings.value.display).toEqual({ actions: false, countdown: false })
    expect(host.settings.value.hotkey).toBe('Ctrl+KeyM')
  })

  it('continues after failure and retries without undoing a later independent save', async () => {
    const { controller, host, fail } = await setup()
    const base = controller.getSnapshot().settings!
    fail()
    const speed = (latest: typeof base) => ({ ...latest, motion: { ...latest.motion, maxSpeed: 400 } })
    const results = await Promise.allSettled([
      controller.updateSettings(speed),
      controller.updateSettings(latest => ({ ...latest, display: { actions: false, countdown: true } })),
    ])
    expect(results.map(r => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(host.settings.value.motion.maxSpeed).toBe(base.motion.maxSpeed)
    await controller.updateSettings(speed)
    expect(host.settings.value.display?.actions).toBe(false)
    expect(host.settings.value.motion.maxSpeed).toBe(400)
  })

  it('keeps a saved pool and a concurrent clip edit across revisions', async () => {
    const { controller, host } = await setup()
    const base = controller.getSnapshot().actionLibrary!
    const next = { ...base, library: { ...base.library, clips: base.library.clips.map((c, i) => i ? c : { ...c, description: '新的描述' }) } }
    await Promise.all([
      controller.saveActionLibrary({ ...base, pools: { ...base.pools, low: base.pools.low.map((e, i) => i ? e : { ...e, weight: 'high' as const }) } }, base),
      controller.saveActionLibrary(next, base),
    ])
    expect(host.view().actionLibrary!.pools.low[0]!.weight).toBe('high')
    expect(host.view().actionLibrary!.library.clips[0]!.description).toBe('新的描述')
    expect(host.view().actionLibrary!.revision).toBe(base.revision + 2)
  })

  it('merges different clips and rejects conflicting edits to one field', async () => {
    const { controller } = await setup()
    const base = controller.getSnapshot().actionLibrary!
    const edit = (index: number, description: string) => ({ ...base, library: { ...base.library, clips: base.library.clips.map((c, i) => i === index ? { ...c, description } : c) } })
    const combined = mergeActionLibrary(base, edit(0, '第一项修改'), edit(1, '第二项修改'))
    expect(combined.library.clips[0]!.description).toBe('第一项修改')
    expect(combined.library.clips[1]!.description).toBe('第二项修改')
    expect(() => mergeActionLibrary(base, edit(0, '我的修改'), edit(0, '其他位置的修改'))).toThrow('同一项')
    expect(mergeActionLibrary(base, edit(0, '我的修改'), edit(0, '其他位置的修改'), false).library.clips[0]!.description).toBe('我的修改')
  })

  it('follows a renamed clip while preserving concurrent pool weights', async () => {
    const { controller } = await setup()
    const base = controller.getSnapshot().actionLibrary!
    const name = base.pools.low[0]!.name
    const renamed = { ...base, library: { ...base.library, clips: base.library.clips.map(c => c.name === name ? { ...c, name: '改名动作' } : c) }, pools: Object.fromEntries(Object.entries(base.pools).map(([tier, pool]) => [tier, pool.map(e => e.name === name ? { ...e, name: '改名动作' } : e)])) as typeof base.pools }
    const changed = { ...base, pools: { ...base.pools, low: base.pools.low.map(e => e.name === name ? { ...e, weight: 'high' as const } : e) } }
    const merged = mergeActionLibrary(base, renamed, changed)
    expect(merged.pools.low.find(e => e.name === '改名动作')?.weight).toBe('high')
    expect(merged.pools.low.some(e => e.name === name)).toBe(false)
  })

  it('does not post a queued stale edit after module shutdown', async () => {
    const { controller, actions } = await setup()
    const pending = controller.updateSettings(latest => ({ ...latest, hotkey: 'Ctrl+KeyM' }))
    const stopped = controller.setEnabled(false)
    await expect(pending).rejects.toThrow('设置已变化')
    await stopped
    expect(actions.map(a => a.action)).toEqual(['module.enable'])
  })

  it('preserves deleting optional fields and unrelated newer settings', () => {
    const base = { resumeHotkey: 'Ctrl+R', motion: { speed: 500, delay: 30 } }
    expect(mergeSettings(base, { motion: { speed: 400, delay: 30 } }, { ...base, motion: { speed: 500, delay: 60 } })).toEqual({ motion: { speed: 400, delay: 60 } })
  })
})
