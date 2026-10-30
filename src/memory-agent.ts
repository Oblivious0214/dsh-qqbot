/**
 * qqbot 预设内的角色记忆插件，由 dsh-qqbot/prompt 加载，每个 qqbot 会话一份，标准会话没有。
 * 把本会话登记给 host 层的 `ctx.qqbot.memory`，并负责两种触发：
 * - 空闲：AI 回复完 IDLE_MS 内没有新消息；
 * - 开新会话：新建时让同一角色其他还开着的会话先整理。
 * 压缩触发在 dsh-qqbot/compaction，手动触发在角色编辑接口。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from './index.ts'
import { captureConsolidation, consolidateMemory } from './memory-consolidate.ts'
import { IDLE_MS } from './memory-coordinator.ts'

export const name = 'qqbot-memory'
export const inject = ['qqbot', 'llm', 'agents']

export function apply(ctx: Context): void {
  const { memory, content } = ctx.qqbot
  // 插件卸载（会话关闭、关掉 dsh-qqbot）时取消进行中的整理和计时。
  const abort = new AbortController()
  ctx.effect(() => () => { abort.abort() }, 'qqbot: memory abort')
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  ctx.effect(() => clearTimer, 'qqbot: memory idle timer')
  let lastActive = Date.now()

  const report = (outcome: Awaited<ReturnType<typeof memory.consolidate>>) => {
    if (outcome.kind === 'failed' && !abort.signal.aborted) ctx.logger.warn(`qqbot: 记忆整理失败：${outcome.error}`)
  }

  ctx.on('agent/created', ({ agent, source }) => {
    ctx.effect(() => memory.register({
      id: agent.id,
      latestTurn: () => ctx.agents.turnBoundaryOf(agent.session).lastTurn,
      lastActive: () => lastActive,
      capture: () => captureConsolidation(agent),
      run: (input, roleName, previous) => consolidateMemory(ctx.llm, input, roleName, previous, abort.signal),
    }), 'qqbot: memory session')
    // 新会话（含清空后重开）：先让同一角色还开着的旧会话整理。不等待，赶得上第一次组装就进快照。
    if (source === 'startup' || source === 'clear') {
      const role = content.roleFor({ id: agent.id })
      if (role !== undefined) memory.consolidateOthers(agent.id, role.id)
    }
    return undefined
  })

  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
    lastActive = Date.now()
    clearTimer()
    if (status !== 'idle') return
    timer = setTimeout(() => {
      timer = undefined
      void memory.consolidate(agent.id).then(report)
    }, IDLE_MS)
    // 计时器不让 DSH 进程因为它而不能退出。
    timer.unref?.()
  })
}
