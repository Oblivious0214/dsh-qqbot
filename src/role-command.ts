/**
 * `/role` 命令。由 dsh-qqbot/prompt 在 qqbot 预设内加载，命令因此只在 qqbot 会话里出现。
 * 命令输入和输出都不进模型请求；切换后下一轮组装时角色正文和 `qqbot:runtime` 的 role 行随之更新。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { NO_ROLE } from './bindings.ts'
import type { QqbotData } from './content.ts'
import type {} from './index.ts'
import type { QqbotSession } from './registry.ts'
import type { Role } from './roles.ts'

export const name = 'qqbot-role-command'
export const inject = ['commands', 'qqbot', 'agents']

const USAGE = '用法：/role <角色名称> 切换角色 · /role none 不用角色 · /role list 列出角色 · /role default <角色名称|none> 设置新会话默认角色'

/** 角色在命令输出里只显示名称；id 是内部键，用户看不到。 */
function label(role: Role): string {
  return role.name
}

function roster(data: QqbotData, current: string | undefined): string {
  const roles = data.roles.list()
  if (roles.length === 0) return '角色库是空的：到设置 → QQ Bot 里新建角色。'
  return roles
    .map(role => `${role.id === current ? '*' : ' '} ${role.name}`)
    .join('\n')
}

/** 当前会话的状态：角色、破限预设、新会话默认角色和角色列表。 */
export function overview(data: QqbotData, session: QqbotSession): string {
  const choice = data.choiceFor(session)
  const role = data.roleFor(session)
  const current = choice === NO_ROLE ? '无' : role === undefined ? '原来的角色已不在角色库，按无角色运行' : label(role)
  const preset = data.jailbreakFor(session)
  const fallbackId = data.bindings.defaultRole
  const fallback = fallbackId === undefined ? '无' : data.roles.get(fallbackId)?.name ?? '已不在角色库'
  return [
    `当前角色：${current}`,
    `通用提示词：${preset.name}`,
    `新会话默认角色：${fallback}`,
    '',
    roster(data, role?.id),
    '',
    USAGE,
  ].join('\n')
}

/** 执行一次 `/role`。纯逻辑，便于测试；写盘失败时抛出，由调用方转成错误结果。 */
export function runRole(data: QqbotData, session: QqbotSession, rawInput: string, busy = false): CommandResult {
  // 每次执行都重新扫描，用户在文件里改过的角色卡由此生效。
  data.roles.reload()
  // 名称里可以有空格：除了关键字，整段输入就是角色名称。
  const input = rawInput.trim()
  const unknown = (name: string): CommandResult => ({ kind: 'error', text: `没有叫"${name}"的角色。\n\n${roster(data, data.roleIdFor(session))}\n\n${USAGE}` })
  if (input === '') return { kind: 'success', text: overview(data, session) }
  if (input === 'list') return { kind: 'success', text: roster(data, data.roleIdFor(session)) }

  if (input === 'none' || input === 'off') {
    if (busy) return { kind: 'error', text: '请等当前回复和排队消息处理完后再切换角色。' }
    const before = data.roleFor(session)
    data.bindings.set(session.id, NO_ROLE)
    const head = before === undefined ? '这个会话本来就没有角色。' : `已取消角色 ${label(before)}，下一条消息起不带角色。`
    return { kind: 'success', text: `${head}\n\n${overview(data, session)}` }
  }

  const fallback = /^default\s+(.+)$/.exec(input)?.[1]?.trim()
  if (fallback !== undefined) {
    if (fallback === 'none' || fallback === 'off') {
      data.bindings.setDefaultRole(undefined)
      return { kind: 'success', text: '新会话不再默认带角色。已有会话不变。' }
    }
    const role = data.roles.find(fallback)
    if (role === undefined) return unknown(fallback)
    data.bindings.setDefaultRole(role.id)
    return { kind: 'success', text: `新 QQ 会话默认使用 ${label(role)}。已有会话不变。` }
  }

  const role = data.roles.find(input)
  if (role === undefined) return unknown(input)
  if (busy) return { kind: 'error', text: '请等当前回复和排队消息处理完后再切换角色。' }
  const before = data.roleIdFor(session)
  data.bindings.set(session.id, role.id)
  const head = before === role.id ? `这个会话已经是 ${label(role)}。` : `已切换到 ${label(role)}，下一条消息起生效。`
  return { kind: 'success', text: `${head}\n\n${overview(data, session)}` }
}

export function apply(ctx: Context): void {
  const data = ctx.qqbot.content
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('dsh-qqbot/role'),
    name: 'role',
    description: '查看或切换角色、设置新会话默认角色',
    input: { hint: '[<角色名称>|list|none|default <角色名称>]' },
    handler: ({ agent, rawInput }) => {
      try {
        ctx.qqbot.maintenance.assertAvailable()
        const busy = agent.status !== 'idle'
          || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
        return runRole(data, { id: agent.id }, rawInput, busy)
      } catch (error) {
        return { kind: 'error', text: `角色没有切换：${(error as Error).message}` }
      }
    },
  }), 'qqbot: /role command')
}
