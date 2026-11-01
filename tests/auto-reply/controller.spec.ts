import { describe, expect, it, vi } from 'vitest'
import { AutoReplyController, LEASE_MS, type Availability } from '../../src/auto-reply/controller.ts'
import { DEFAULT_OPTIONS, parseOptions } from '../../src/auto-reply/types.ts'

function fixture() {
  let now = 0
  const available: Availability = { allowed: true, busy: false, started: true }
  const send = vi.fn(), cancelPending = vi.fn()
  const controller = new AutoReplyController({ now: () => now, availability: () => available, send, cancelPending })
  const enable = (maxReplies = 2, owner = 'a') => controller.enable('s', owner, { waitSeconds: 10, maxReplies })
  const pulse = (seconds = 1, blocked = false, activity = 0) => {
    now += seconds * 1000
    return controller.pulse('s', 'a', { blocked, activity })
  }
  const wait = (seconds: number) => { for (let i = 0; i < seconds; i++) pulse() }
  return { controller, send, cancelPending, available, enable, pulse, wait, advance: (ms: number) => { now += ms } }
}

describe('自动接话宿主状态机', () => {
  it('默认关闭，等待完整间隔才发，重复请求不重复唤醒', () => {
    const f = fixture()
    expect(f.controller.view('s').enabled).toBe(false)
    f.enable(); f.pulse(); f.wait(9)
    expect(f.send).not.toHaveBeenCalled()
    f.pulse(); expect(f.send).toHaveBeenCalledTimes(1)
    f.pulse(0); f.wait(30)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('同页重复开启不重置计时，另一个页面不能抢占', () => {
    const f = fixture(); f.enable(); f.pulse(); f.wait(4)
    f.enable()
    expect(() => f.enable(2, 'other')).toThrow('另一个页面')
    f.wait(6); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('忙碌和排队不发，空闲后重新等待整个间隔', () => {
    const f = fixture(); f.enable(); f.pulse(); f.wait(5)
    f.available.busy = true; f.wait(30)
    f.available.busy = false; f.wait(10)
    expect(f.send).not.toHaveBeenCalled()
    f.pulse(); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('尚未开始的会话不会自行发起第一轮', () => {
    const f = fixture(); f.available.started = false; f.enable(); f.wait(20)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('草稿/附件/逐段显示阻挡接话，清空后从头等待', () => {
    const f = fixture(); f.enable(); f.pulse(); f.wait(9)
    f.pulse(1, true, 1)
    expect(f.send).not.toHaveBeenCalled()
    f.pulse(1, false, 2); f.wait(10)
    // Further activity resets the interval rather than preserving an old deadline.
    expect(f.send).not.toHaveBeenCalled()
    f.pulse(); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('达到上限关闭，完成/输入/空闲不会自动重新开启', () => {
    const f = fixture(); f.enable(1); f.pulse(); f.wait(10)
    f.controller.completed('s')
    expect(f.controller.view('s')).toMatchObject({ enabled: false, status: 'limit', count: 1 })
    f.controller.userInput('s'); f.controller.completed('s'); f.wait(20)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('新用户输入重置连续次数并等该轮回复结束', () => {
    const f = fixture(); f.enable(); f.pulse(); f.wait(10)
    f.controller.completed('s'); f.controller.userInput('s'); f.wait(20)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.controller.view('s').count).toBe(0)
    f.controller.completed('s'); f.wait(11)
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('断线/休眠超过租期后不补发，必须主动重开', () => {
    const f = fixture(); f.enable(); f.pulse(); f.advance(LEASE_MS + 1)
    expect(f.pulse(0).enabled).toBe(false)
    f.wait(20); expect(f.send).not.toHaveBeenCalled()
    f.enable(); f.pulse(); f.wait(10); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('归档、不可用与预设变更关闭，恢复不唤醒', () => {
    const f = fixture(); f.enable(); f.pulse(); f.available.allowed = false
    expect(f.pulse().enabled).toBe(false)
    f.available.allowed = true; f.wait(20)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('投递失败不自动重试', () => {
    const f = fixture(); f.send.mockImplementation(() => { throw new Error('offline') })
    f.enable(); f.pulse(); f.wait(10)
    expect(f.controller.view('s')).toMatchObject({ enabled: false, status: 'stopped' })
    f.wait(20); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('取消、错误停止；关闭、过期、卸载清理待发项', () => {
    const f = fixture(); f.enable(); f.pulse(); f.controller.stop('s', '已取消'); f.wait(20)
    expect(f.send).not.toHaveBeenCalled()
    f.enable(); f.controller.disable('s', 'other'); expect(f.controller.view('s').enabled).toBe(true)
    f.controller.disable('s', 'a'); expect(f.controller.view('s').enabled).toBe(false)
    f.enable(); f.advance(LEASE_MS + 1); f.controller.sweep(); expect(f.controller.view('s').status).toBe('off')
    f.enable(); f.controller.dispose(); expect(f.controller.view('s').enabled).toBe(false)
    expect(f.cancelPending).toHaveBeenCalled()
    expect(() => f.enable()).toThrow()
  })
  it('不为标准、归档或无活跃 agent 的会话开启', () => {
    const f = fixture(); f.available.allowed = false
    expect(() => f.enable()).toThrow('QQ Bot')
  })
  it('验证范围和整数，不接受 NaN、分数和无限次数', () => {
    expect(parseOptions(DEFAULT_OPTIONS)).toEqual(DEFAULT_OPTIONS)
    for (const value of [null, {}, { waitSeconds: 9, maxReplies: 1 }, { waitSeconds: 3601, maxReplies: 1 },
      { waitSeconds: 10, maxReplies: 0 }, { waitSeconds: 10, maxReplies: 21 }, { waitSeconds: 10.5, maxReplies: 1 },
      { waitSeconds: NaN, maxReplies: 1 }, { waitSeconds: 10, maxReplies: Infinity }]) expect(() => parseOptions(value)).toThrow()
  })
})
