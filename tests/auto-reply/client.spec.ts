import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoReplyClient, type ClientGate } from '../../src/client/auto-reply/state.ts'
import type { AutoReplyView } from '../../src/auto-reply/types.ts'

const enabled: AutoReplyView = { enabled: true, count: 0, remainingSeconds: 10, status: 'waiting', message: '' }
function fixture() {
  vi.useFakeTimers()
  const gate: ClientGate = { active: true, blocked: false, activity: 0 }
  const request = vi.fn(async (_body: Record<string, unknown>) => ({ ...enabled }))
  const client = new AutoReplyClient('session', () => gate, request, () => 'owner-abcdefghijkl')
  const start = () => client.start({ waitSeconds: 10, maxReplies: 2 })
  return { client, request, gate, start }
}
afterEach(() => vi.useRealTimers())
describe('自动接话页面生命周期', () => {
  it('默认无请求；只有主动开启才发送心跳', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(5000)
    expect(f.request).not.toHaveBeenCalled()
    await f.start(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.request.mock.calls.map(([body]) => body['action'])).toEqual(['enable', 'pulse'])
    f.client.dispose()
  })
  it('读取最新草稿状态，不捕获旧闭包', async () => {
    const f = fixture(); await f.start(); f.gate.blocked = true; f.gate.activity = 2
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pulse', blocked: true, activity: 2 }))
    f.client.dispose()
  })
  it('离开会话后停止，返回不恢复', async () => {
    const f = fixture(); await f.start(); f.gate.active = false
    await vi.advanceTimersByTimeAsync(1000); expect(f.client.snapshot.enabled).toBe(false)
    f.gate.active = true; await vi.advanceTimersByTimeAsync(10000)
    expect(f.request.mock.calls.filter(([body]) => body['action'] === 'pulse')).toHaveLength(0)
  })
  it('网络错误不自动重试，晚到的开启结果被释放', async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error('offline'))
    await f.start(); await vi.advanceTimersByTimeAsync(10000)
    expect(f.client.snapshot.enabled).toBe(false)
    expect(f.request.mock.calls.filter(([body]) => body['action'] === 'enable')).toHaveLength(1)
    let resolve!: (view: AutoReplyView) => void
    f.request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const starting = f.start(); f.client.stop(); resolve(enabled); await starting
    expect(f.client.snapshot.enabled).toBe(false)
    expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'disable' }))
  })
  it('请求在途不叠加心跳，卸载使晚到回复失效', async () => {
    const f = fixture(); await f.start()
    let resolve!: (view: AutoReplyView) => void
    f.request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.request.mock.calls.filter(([body]) => body['action'] === 'pulse')).toHaveLength(1)
    f.client.dispose(); resolve(enabled); await vi.advanceTimersByTimeAsync(20000)
    expect(f.client.snapshot.enabled).toBe(false)
    expect(f.request.mock.calls.filter(([body]) => body['action'] === 'pulse')).toHaveLength(1)
  })
})
