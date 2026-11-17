import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { QuickReplyState } from '../../src/client/auto-reply/quick-state.ts'

const hooks = vi.hoisted(() => ({ effects: [] as (() => void)[] }))
// Exercise the row without mounting the separate composer monitor.
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void) => { hooks.effects.push(effect) },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
}))
import { ReplyOptions } from '../../src/client/auto-reply/reply-options.tsx'

function row(quick: QuickReplyState, latest = true) {
  return ReplyOptions({
    quick, sessionId: 's', turn: 2, step: 1, replies: ['继续聊聊', '换个话题', '稍后再说'],
    useInput: (select: any) => select({ draft: '', attachmentIds: [], phase: 'plain' }),
    useSession: (select: any) => select({ running: false, removed: false, openState: 'open', pendingSubmissions: [] }),
    useChat: (select: any) => select({ legacy: { partial: null, nodes: [{ kind: 'assistant', turn: latest ? 2 : 3, step: 1 }] } }),
    inputActions: { setDraft: vi.fn(), persistDraft: vi.fn(), submit: vi.fn() },
  } as any)
}

beforeEach(() => { hooks.effects.length = 0 })
describe('快捷选项消息独立挂载', () => {
  it('没有输入栏监视器时也读取设置，并显示最新回复的三个按钮', async () => {
    const request = vi.fn(async () => ({ enabled: true }))
    const quick = new QuickReplyState(request)
    expect(row(quick)).toBeNull()
    hooks.effects.splice(0).forEach(effect => effect())
    await quick.refresh('s')
    expect(request).toHaveBeenCalledTimes(1)
    const view = row(quick) as ReactElement<any>
    expect(view.props['aria-label']).toBe('回复建议')
    expect(view.props.children.props.children).toHaveLength(3)
    quick.dispose()
  })
  it('读取到关闭设置后仍隐藏，旧回复不发起读取', async () => {
    const request = vi.fn(async () => ({ enabled: false }))
    const quick = new QuickReplyState(request)
    row(quick, false)
    hooks.effects.splice(0).forEach(effect => effect())
    expect(request).not.toHaveBeenCalled()
    row(quick)
    hooks.effects.splice(0).forEach(effect => effect())
    await quick.refresh('s')
    expect(row(quick)).toBeNull()
    quick.dispose()
  })
})
