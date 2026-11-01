import type { Clock } from '../../src/toy/client/player.ts'
import { Listeners, type MoveLimits, type MoveResult, type Transport, type TransportState } from '../../src/toy/client/transport.ts'
import type { MotionProfile } from '../../src/toy/core/motion.ts'
import { defaultMotion, type MotionConfig } from '../../src/toy/core/config.ts'

/** 速度机制测试固定在旧分界 200／350，默认值调整不影响这些数值断言。 */
export const legacyMotion = (): MotionConfig => ({ ...defaultMotion(), speedBreakpoints: [200, 350] })

export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** 手动推进的时钟。advance 按到期顺序触发计时器，每个之后清空微任务。 */
export class FakeClock implements Clock {
  time = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  private nextId = 1
  now(): number { return this.time }
  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback })
    return id
  }
  clear(handle: unknown): void { this.timers.delete(handle as number) }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    await flush()
    while (true) {
      const due = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.time = due[1].at
      due[1].callback()
      await flush()
    }
    this.time = target
  }
}

export interface MoveRecord { position: number; durationMs: number; limits: MoveLimits; at: number }

/** 记录发包的传输。move 立即返回整包时长。 */
export class MockTransport implements Transport {
  readonly kind = 'buttplug'
  state: TransportState = { phase: 'ready', message: '', error: '' }
  readonly moves: MoveRecord[] = []
  stops = 0
  fail: Error | undefined
  private readonly listeners = new Listeners<TransportState>()
  constructor(private readonly clock: FakeClock, readonly profile: MotionProfile = {}) {}
  subscribe(listener: (state: TransportState) => void) { return this.listeners.add(listener, this.state) }
  async connect() { return this.state }
  async move(position: number, durationMs: number, limits: MoveLimits): Promise<MoveResult> {
    if (this.fail !== undefined) throw this.fail
    this.moves.push({ position, durationMs, limits, at: this.clock.now() })
    return { remainingMs: durationMs }
  }
  async stop() { this.stops++ }
  disconnect() { this.setPhase('disconnected') }
  setPhase(phase: TransportState['phase']) {
    this.state = { ...this.state, phase }
    this.listeners.emit(this.state)
  }
}
