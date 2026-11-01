import { describe, expect, it, vi } from 'vitest'
import { WorkerClock, type TimerWorker } from '../../src/toy/client/worker-clock.ts'

function setup() {
  const worker: TimerWorker = { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() }
  const create = vi.fn(() => worker)
  const failed = vi.fn()
  const clock = new WorkerClock(failed, create)
  const fire = (id: number) => worker.onmessage?.call(worker as Worker, { data: id } as MessageEvent)
  return { worker, create, failed, clock, fire }
}

describe('device worker clock', () => {
  it('creates lazily and wakes from worker messages without window timers', () => {
    const { worker, create, clock, fire } = setup()
    expect(create).not.toHaveBeenCalled()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      const callback = vi.fn()
      const id = clock.set(callback, 80)
      expect(worker.postMessage).toHaveBeenCalledWith({ id, ms: 80 })
      fire(id)
      fire(id)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(timer).not.toHaveBeenCalled()
    } finally { timer.mockRestore(); clock.dispose() }
  })

  it('cancels a wakeup already queued on the page and keeps other timers', () => {
    const { clock, worker, fire } = setup()
    const cancelled = vi.fn(), active = vi.fn()
    const first = clock.set(cancelled, 80)
    const second = clock.set(active, 100)
    clock.clear(first)
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: first })
    fire(first); fire(second)
    expect(cancelled).not.toHaveBeenCalled()
    expect(active).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('can schedule the next motion from a callback', () => {
    const { clock, fire } = setup()
    const next = vi.fn()
    let second = 0
    const first = clock.set(() => { second = clock.set(next, 80) }, 80)
    fire(first); fire(second)
    expect(next).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('terminates and ignores late callbacks when unloaded', () => {
    const { clock, worker, fire } = setup()
    const callback = vi.fn()
    const id = clock.set(callback, 80)
    const queued = worker.onmessage!
    clock.dispose(); fire(id)
    queued.call(worker as Worker, { data: id } as MessageEvent)
    expect(callback).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(() => clock.set(callback, 80)).toThrow('设备计时器已关闭')
  })

  it.each(['onerror', 'onmessageerror'] as const)('stops on %s and can recreate for a manual reconnect', event => {
    const { clock, worker, create, failed, fire } = setup()
    const callback = vi.fn()
    const id = clock.set(callback, 80)
    worker[event]!.call(worker as Worker, { preventDefault() {} } as ErrorEvent & MessageEvent)
    fire(id)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    const next = clock.set(callback, 80)
    expect(create).toHaveBeenCalledTimes(2)
    fire(next)
    expect(callback).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('reports unsupported workers after the current player call, with no timer fallback', async () => {
    const failed = vi.fn()
    const clock = new WorkerClock(failed, () => { throw new Error('blocked') })
    clock.set(vi.fn(), 80)
    expect(failed).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(failed).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('cancels all callbacks if posting fails', async () => {
    const { clock, worker, failed, fire } = setup()
    const callback = vi.fn()
    const first = clock.set(callback, 80)
    vi.mocked(worker.postMessage).mockImplementation(() => { throw new Error('closed') })
    clock.set(callback, 80)
    await Promise.resolve()
    fire(first)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
    clock.dispose()
  })
})
