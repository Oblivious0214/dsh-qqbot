import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, IconRefreshOutlineRegular: () => null }))
import { installPromptView } from '../src/client/prompt-viewer.tsx'

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() },
    listeners,
  }
}

function fixture() {
  const current = source<{ key: string | undefined }>({ key: undefined })
  const list = source({ byId: {} as Record<string, { projectionValues: { agentPreset?: string } }> })
  const registered = new Map<string, { label: string; inject: () => unknown }>()
  let cleanup: (() => void) | undefined
  const ctx = {
    uiSession: { adapter: { current } }, sessions: { list },
    slots: {
      inject: (_name: string, callback: () => () => void) => { cleanup = callback() },
      register: (options: { name: string; id: string; label: string; inject: () => unknown }) => {
        expect(options.name).toBe('conversation.view')
        expect(registered.has(options.id)).toBe(false)
        registered.set(options.id, options)
        return () => { registered.delete(options.id) }
      },
    },
  } as unknown as Context
  const edit = vi.fn()
  installPromptView(ctx, edit)
  return { current, list, registered, edit, dispose: () => cleanup?.() }
}

describe('提示词标签的会话隔离', () => {
  it('只随当前 QQ 会话登记，标准会话及无会话时完全移除，切回可恢复', () => {
    const f = fixture()
    f.list.set({ byId: { qq: { projectionValues: { agentPreset: 'qqbot' } }, standard: { projectionValues: { agentPreset: 'standard' } } } })
    expect(f.registered.size).toBe(0)
    f.current.set({ key: 'standard' })
    expect(f.registered.size).toBe(0)
    f.current.set({ key: 'qq' })
    expect(f.registered.get('qqbot-prompt-viewer')?.label).toBe('提示词')
    expect(f.registered.get('qqbot-prompt-viewer')?.inject()).toEqual({ openEditor: f.edit })
    f.current.set({ key: 'standard' })
    expect(f.registered.size).toBe(0)
    f.current.set({ key: 'qq' })
    expect(f.registered.size).toBe(1)
    f.current.set({ key: undefined })
    expect(f.registered.size).toBe(0)
    f.dispose()
  })

  it('投影晚到时补登记，两个 QQ 会话间不重复，卸载后不再响应', () => {
    const f = fixture()
    f.current.set({ key: 'qq' })
    expect(f.registered.size).toBe(0)
    f.list.set({ byId: { qq: { projectionValues: { agentPreset: 'qqbot' } }, other: { projectionValues: { agentPreset: 'qqbot' } } } })
    expect(f.registered.size).toBe(1)
    const entry = f.registered.get('qqbot-prompt-viewer')
    f.current.set({ key: 'other' })
    expect(f.registered.get('qqbot-prompt-viewer')).toBe(entry)
    f.dispose()
    expect(f.registered.size).toBe(0)
    expect(f.current.listeners.size + f.list.listeners.size).toBe(0)
    f.current.set({ key: 'qq' })
    expect(f.registered.size).toBe(0)
  })
})
