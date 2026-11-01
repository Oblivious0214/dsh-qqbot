import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { lastTurnOf } from '../src/agent-turn.ts'
import { apply as applyMemory } from '../src/memory-agent.ts'

const session = (events: unknown[] = []) => ({ snapshotEvents: () => events }) as Parameters<typeof lastTurnOf>[1]

describe('宿主轮次读取兼容', () => {
  it('优先沿用宿主投影，保留零值、接收对象和读取异常', () => {
    const snapshotEvents = vi.fn(() => [])
    const current = { snapshotEvents } as unknown as Parameters<typeof lastTurnOf>[1]
    const agents = { turn: 0, turnBoundaryOf() { return { lastTurn: this.turn } as ReturnType<NonNullable<Parameters<typeof lastTurnOf>[0]['turnBoundaryOf']>> } }
    expect(lastTurnOf(agents, current)).toBe(0)
    agents.turn = 13
    expect(lastTurnOf(agents, current)).toBe(13)
    expect(snapshotEvents).not.toHaveBeenCalled()
    expect(() => lastTurnOf({ turnBoundaryOf: () => { throw new Error('读取失败') } }, current)).toThrow('读取失败')
    expect(snapshotEvents).not.toHaveBeenCalled()
  })

  it('空白或只有设置的会话为零，实时读取之后新增的轮次', () => {
    const events = [{ type: 'model/selection', data: {} }]
    const older = session(events)
    expect(lastTurnOf({}, older)).toBe(0)
    events.push({ type: 'turn/start', data: { turn: 1 } })
    expect(lastTurnOf({}, older)).toBe(1)
  })

  it('取消、压缩和分叉后仍读完整事件中的最新 turn/start，不用消息条数估算', () => {
    const older = session([
      { type: 'turn/start', data: { turn: 4 } },
      { type: 'turn/end', data: { turn: 4, reason: { kind: 'cancelled' } } },
      { type: 'compaction/summary', data: {} },
      { type: 'turn/start', data: { turn: 17 } },
      { type: 'step/start', data: { turn: 17 } },
      { type: 'turn/end', data: { turn: 17, reason: { kind: 'forked' } } },
    ])
    expect(lastTurnOf({}, older)).toBe(17)
  })

  it('旧快照读取失败或也缺接口时抛错，不误认为空白对话', () => {
    expect(() => lastTurnOf({}, { snapshotEvents: () => { throw new Error('快照失败') } } as unknown as Parameters<typeof lastTurnOf>[1])).toThrow('快照失败')
    expect(() => lastTurnOf({}, {} as Parameters<typeof lastTurnOf>[1])).toThrow('无法读取对话轮次')
  })

  it('缺少宿主轮次接口时记忆注册和后续轮次读取正常，不调用模型', () => {
    const events = [{ type: 'turn/start', data: { turn: 10 } }]
    const agent = { id: 'memory-older', session: session(events) }
    const callbacks = new Map<string, (...args: any[]) => any>()
    let registered!: { latestTurn: () => number }
    applyMemory({ agents: {}, llm: {}, qqbot: {
      memory: { register: (value: any) => { registered = value; return vi.fn() } },
      content: {}, maintenance: { register: () => vi.fn() },
    }, effect: (fn: () => unknown) => fn(), on: (name: string, fn: (...args: any[]) => any) => { callbacks.set(name, fn); return vi.fn() },
    } as unknown as Context)
    callbacks.get('agent/created')!({ agent, source: 'resume' })
    expect(registered.latestTurn()).toBe(10)
    events.push({ type: 'turn/start', data: { turn: 11 } })
    expect(registered.latestTurn()).toBe(11)
  })
})
