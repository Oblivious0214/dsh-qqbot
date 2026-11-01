import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

type TurnReader = Partial<Pick<Context['agents'], 'turnBoundaryOf'>>
type TurnSession = Agent['session']

/** 新宿主使用轮次投影；缺少该接口的宿主从保留的完整事件快照读取同一轮次。 */
export function lastTurnOf(agents: TurnReader, session: TurnSession): number {
  if (typeof agents.turnBoundaryOf === 'function') return agents.turnBoundaryOf(session).lastTurn
  if (typeof session.snapshotEvents !== 'function') throw new Error('当前 DSH 无法读取对话轮次，请更新 DSH。')
  // 仅兼容分支使用旧快照接口；压缩不删除 turn/start，分叉继承的轮次也包含在内。
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'turn/start') return event.data.turn
  }
  return 0
}
