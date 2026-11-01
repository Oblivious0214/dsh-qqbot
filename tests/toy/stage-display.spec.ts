import { describe, expect, it } from 'vitest'
import { countdownLabel, describeAction, historicalAction } from '../../src/toy/client/stage-display.ts'
import { defaultSettings, parseSettings } from '../../src/toy/settings.ts'
import { defaultMotion } from '../../src/toy/core/config.ts'

describe('read-only stage labels', () => {
  it('shows the written name, marks auto and pool fallbacks, without inventing old coordinates', () => {
    const intent = { range: 'upper', tier: 'high', action: '滑动' } as const
    expect(describeAction(intent, defaultMotion())).toBe('龟头 70–100 · 快速 · 滑动')
    expect(describeAction(intent, defaultMotion(), '滑动')).toBe('龟头 70–100 · 快速 · 滑动')
    // 写的名称不在该档动作池里时，按 auto 抽到别的动作。
    expect(describeAction(intent, defaultMotion(), '稳定节奏')).toBe('龟头 70–100 · 快速 · 自动选择 · 稳定节奏')
    expect(describeAction({ ...intent, action: 'auto' })).toBe('龟头 · 快速 · 自动选择')
    const stages = [{ text: 'a', motion: intent }, { text: 'b', motion: { tier: 'low' } }, { text: 'c' }, { text: 'd', motion: { stop: true } }]
    expect(historicalAction(stages, 2)).toBe('龟头 · 慢速 · 滑动 · 沿用')
    expect(historicalAction(stages, 3)).toBe('停止')
    expect(historicalAction([{ text: 'a', motion: { tier: 'high' } }], 0)).toContain('不完整')
    expect(historicalAction([{ text: 'a' }], 0)).toBe('无动作')
    expect(historicalAction([{ text: 'a', salvaged: true }], 0)).toBe('动作信息不可用')
  })
  it('distinguishes paragraph timing from the last action safety timeout', () => {
    expect(countdownLabel(0, undefined)).toBeUndefined()
    expect(countdownLabel(0, { index: 0, status: 'history', remainingMs: 0 })).toBeUndefined()
    expect(countdownLabel(0, { index: 0, status: 'paused', remainingMs: 1234 })).toBe('已暂停 · 剩余 1.3 秒')
    expect(countdownLabel(0, { index: 0, status: 'running', remainingMs: 0 })).toBe('等待下一段')
    expect(countdownLabel(0, { index: 0, status: 'complete', remainingMs: 0 }, { remainingMs: 5000, paused: true })).toBe('已暂停 · 5.0 秒后自动停止')
    expect(countdownLabel(0, { index: 0, status: 'interrupted', remainingMs: 0 }, { remainingMs: 5000, paused: false })).toBe('已取消')
    expect(countdownLabel(0, { index: 0, status: 'failed', remainingMs: 0 })).toBe('未完成')
    expect(countdownLabel(0, { index: 1, status: 'running', remainingMs: 500 })).toBeUndefined()
    expect(countdownLabel(0, { index: 0, status: 'complete', remainingMs: 0 })).toBeUndefined()
  })
  it('persists independent preferences without altering motion or authorization', () => {
    const initial = defaultSettings()
    const next = parseSettings({ ...initial, display: { actions: false, countdown: true } })
    expect(next).toEqual({ ...initial, display: { actions: false, countdown: true } })
    expect(parseSettings(initial)).toEqual(initial)
    expect(() => parseSettings({ ...initial, display: { actions: 'false', countdown: true } })).toThrow('气泡显示')
  })
})
