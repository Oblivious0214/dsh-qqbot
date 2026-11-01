import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoReplyPromptSettings } from '../../src/auto-reply/prompt-settings.ts'
import { AUTO_REPLY_TEXT } from '../../src/auto-reply/types.ts'
import { AutoReplySessions } from '../../src/client/auto-reply/sessions.ts'

const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('按会话编辑接话提示词', () => {
  it('保留内置原文，保存与重载隔离不同会话，恢复后仍使用内置默认', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-notice-')); dirs.push(dir)
    const settings = new AutoReplyPromptSettings(dir, () => {})
    expect(settings.get('s').prompt).toBe(AUTO_REPLY_TEXT)
    settings.set('s', '以当前角色身份聊聊今天的晚餐。')
    const reloaded = new AutoReplyPromptSettings(dir, () => {})
    expect(reloaded.get('s').prompt).toContain('晚餐')
    expect(reloaded.get('other').prompt).toBe(AUTO_REPLY_TEXT)
    reloaded.set('s', AUTO_REPLY_TEXT)
    expect(new AutoReplyPromptSettings(dir, () => {}).get('s').prompt).toBe(AUTO_REPLY_TEXT)
  })
  it.each(['', '   ', 'a'.repeat(6001), 123])('拒绝无效内容且保留已保存文本 (%s)', value => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-notice-')); dirs.push(dir)
    const settings = new AutoReplyPromptSettings(dir, () => {})
    settings.set('s', '聊聊晚餐。')
    expect(() => settings.set('s', value)).toThrow('提示词')
    expect(settings.get('s').prompt).toBe('聊聊晚餐。')
  })
})

describe('设置窗口与接话生命周期分离', () => {
  it('设置订阅卸载不停止接话；草稿持续阻挡；输入组件卸载才停止且不恢复', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => ({ enabled: true, count: 0, remainingSeconds: 10, status: 'waiting' as const, message: '' }))
    const sessions = new AutoReplySessions(request)
    const gate = { active: true, blocked: false, activity: 0 }
    const unmount = sessions.mount('s', () => gate)
    const entry = sessions.get('s')!
    sessions.setOptions('s', { waitSeconds: 30, maxReplies: 2 })
    await entry.client.start(entry.options)
    const closeSettings = sessions.subscribe(() => {}); closeSettings()
    await vi.advanceTimersByTimeAsync(1000)
    expect(entry.client.snapshot.enabled).toBe(true)
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pulse', blocked: false }))
    gate.blocked = true; gate.activity++
    await vi.advanceTimersByTimeAsync(1000)
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pulse', blocked: true, activity: 1 }))
    expect(sessions.get('s')!.options.waitSeconds).toBe(30)
    unmount()
    expect(entry.client.snapshot.enabled).toBe(false)
    expect(sessions.get('s')).toBeUndefined()
    const remount = sessions.mount('s', () => gate)
    expect(sessions.get('s')!.client.snapshot.enabled).toBe(false)
    remount(); sessions.dispose()
  })
})
