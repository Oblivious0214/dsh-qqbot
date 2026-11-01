import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { presetForAgent } from '../src/agent-preset.ts'

const agent = { ctx: {} as Context, session: { header: { agentPreset: 'qqbot' } } } as Parameters<typeof presetForAgent>[1]

describe('宿主预设读取兼容', () => {
  it('新接口返回空值时保留该结果，不再回退', () => {
    const composedPreset = vi.fn(() => 'qqbot')
    expect(presetForAgent({ presetForSession: () => null, composedPreset }, agent)).toBeNull()
    expect(composedPreset).not.toHaveBeenCalled()
  })

  it('保留宿主方法的接收对象和错误，不将读取失败误判成 QQ 对话', () => {
    const reader = { value: 'standard', presetForSession() { return this.value } }
    expect(presetForAgent(reader, agent)).toBe('standard')
    const older = { value: 'qqbot', composedPreset() { return this.value } }
    expect(presetForAgent(older, agent)).toBe('qqbot')
    expect(() => presetForAgent({ presetForSession: () => { throw new Error('读取失败') } }, agent)).toThrow('读取失败')
  })

  it('未绑定或没有读取接口时，不用创建 header 放行 QQ 功能', () => {
    expect(presetForAgent({ composedPreset: () => undefined }, agent)).toBeNull()
    expect(presetForAgent({}, agent)).toBeNull()
  })
})
