import { describe, it, expect } from 'vitest'
import { MotionPlayer } from '../../src/toy/client/player.ts'
import { defaultMotion, parseMotion } from '../../src/toy/core/config.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { FakeClock, MockTransport } from './fakes.ts'
const intent = { range: 'full', tier: 'low', action: 'steady' } as const
function setup(seconds: number, standby = false, presets = false) {
  const clock = new FakeClock(), transport = new MockTransport(clock)
  const player = new MotionPlayer(transport, {}, clock)
  const library = defaultActionLibrary()
  player.configure(parseMotion({ ...defaultMotion(), autoStopSeconds: seconds,
    ...standby ? { standby: { preset: library.library.clips[0]!.name, minPosition: 20, maxPosition: 40, maxSpeed: 30 } } : {} }))
  player.configureLibrary(library)
  return { clock, transport, player }
}
describe('自动停止与待机', () => {
  it('延长到自定义时间', async () => {
    const { clock, player } = setup(60)
    player.reveal(intent, undefined)
    await clock.advance(30001); expect(player.intent).not.toBeNull()
    await clock.advance(29999); expect(player.intent).toBeNull()
  })
  it('不停止支持暂停恢复', async () => {
    const { clock, player } = setup(0)
    player.reveal(intent, undefined)
    await clock.advance(61000); expect(player.intent).not.toBeNull()
    player.pause(); player.resume()
    expect(player.remainingMs()).toBe(Infinity)
    await clock.advance(61000); expect(player.intent).not.toBeNull()
    player.pause(); expect(player.paused).toBe(true)
  })
  it('预设不受旧 30 秒预算限制', async () => {
    const { clock, player } = setup(0, false, true)
    player.reveal({ ...intent, preset: 'auto' }, undefined)
    await clock.advance(31000)
    expect(player.intent).not.toBeNull()
  })
  it('超时转入限定行程速度的待机，暂停恢复，新动作接管', async () => {
    const { clock, player, transport } = setup(2, true)
    player.reveal(intent, undefined)
    await clock.advance(2000)
    expect(player.mode).toBe('standby')
    const n = transport.moves.length
    await clock.advance(61000)
    expect(player.mode).toBe('standby')
    for (const move of transport.moves.slice(n)) {
      expect(move.position).toBeGreaterThanOrEqual(20)
      expect(move.position).toBeLessThanOrEqual(40)
      expect(move.limits.maxSpeed).toBeLessThanOrEqual(30)
    }
    player.pause(); player.resume()
    await clock.advance(1000); expect(player.mode).toBe('standby')
    player.reveal(intent, undefined)
    expect(player.mode).toBe('ai')
    player.stop('user'); await clock.advance(61000)
    expect(player.intent).toBeNull()
  })
  it('等待下一段失败依然停止，不进入待机', async () => {
    const { clock, player } = setup(2, true)
    player.reveal(intent, 100)
    await clock.advance(5100)
    expect(player.intent).toBeNull()
  })
  it('校验待机不得超过总限制', () => {
    expect(() => parseMotion({ ...defaultMotion(), autoStopSeconds: -1 })).toThrow()
    expect(() => parseMotion({ ...defaultMotion(), standby: { preset: 'x', minPosition: 0, maxPosition: 101, maxSpeed: 20 } })).toThrow()
  })
})
