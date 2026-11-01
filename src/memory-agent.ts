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
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from './index.ts'
import { captureConsolidation, consolidateMemory } from './memory-consolidate.ts'
import { IDLE_MS } from './memory-coordinator.ts'
import { lastTurnOf } from './agent-turn.ts'

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
  ctx.effect(() => ctx.qqbot.maintenance.register({ prepare: clearTimer }), 'qqbot: reset memory timer')
  let lastActive = Date.now()

  const report = (outcome: Awaited<ReturnType<typeof memory.consolidate>>) => {
    if (outcome.kind === 'failed' && !abort.signal.aborted) ctx.logger.warn(`qqbot: 记忆整理失败：${outcome.error}`)
  }

  ctx.on('agent/created', ({ agent, source }) => {
    ctx.effect(() => memory.register({
      id: agent.id,
      latestTurn: () => lastTurnOf(ctx.agents, agent.session),
      lastActive: () => lastActive,
      capture: () => captureConsolidation(agent),
      run: (input, roleName, previous, cleanup) => consolidateMemory(ctx.llm, input, roleName, previous, cleanup === undefined ? abort.signal : AbortSignal.any([abort.signal, cleanup])),
    }), 'qqbot: memory session')
    // 压缩提交时历史开头本来就要重算：顺带把本会话的记忆快照换成新版，长对话也能用上整理出的记忆。
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'compaction/summary') return
      const role = content.memoryState(agent.id)?.role
      if (role === undefined) return
      try {
        content.applyMemory(agent.id, role)
      } catch (error) {
        // 写不了盘时本会话继续用旧快照，下次压缩再试。
        ctx.logger.warn(`qqbot: 压缩后没能更新记忆快照：${String(error)}`)
      }
    }), 'qqbot: memory after compaction')
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
