/**
 * `/role` 命令。由 dsh-qqbot/prompt 在 qqbot 预设内加载，命令因此只在 qqbot 会话里出现。
 * 命令输入和输出都不进模型请求；切换后下一轮组装时角色正文和 `qqbot:runtime` 的 role 行随之更新。
 * 命令语法沿用 dsh-persona-switcher 的 `/role [<id>|list|none]`（MIT，yupaoa）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { NO_ROLE } from './bindings.ts'
import type { QqbotData } from './content.ts'
import type {} from './index.ts'
import type { QqbotSession } from './registry.ts'
import type { Role } from './roles.ts'

export const name = 'qqbot-role-command'
export const inject = ['commands', 'qqbot']

const USAGE = '用法：/role <id> 切换 · /role none 不用角色 · /role list 列出角色 · /role default <id|none> 设置新会话默认角色'

function label(role: Role): string {
  return role.name === role.id ? role.id : `${role.id}（${role.name}）`
}

function roster(data: QqbotData, current: string | undefined): string {
  const roles = data.roles.list()
  if (roles.length === 0) return `角色库是空的：把角色卡放进 ${data.roles.dir}，每个角色一个目录 <id>/ROLE.md。`
  return roles
    .map(role => `${role.id === current ? '*' : ' '} ${role.id}${role.name === role.id ? '' : `  ${role.name}`}${role.description === '' ? '' : ` — ${role.description}`}`)
    .join('\n')
}

/** 当前会话的状态：角色、破限预设、新会话默认角色和角色列表。 */
export function overview(data: QqbotData, session: QqbotSession): string {
  const choice = data.choiceFor(session)
  const role = data.roleFor(session)
  const current = choice === NO_ROLE ? '无' : role === undefined ? `${choice}（已不在角色库，按无角色运行）` : label(role)
  const preset = data.jailbreakFor(session)
  const fallback = data.bindings.defaultRole
  return [
    `当前角色：${current}`,
    `破限预设：${preset.name}（${preset.id}）`,
    `新会话默认角色：${fallback === undefined ? '无' : fallback}`,
    '',
    roster(data, role?.id),
    '',
    USAGE,
  ].join('\n')
}

/** 执行一次 `/role`。纯逻辑，便于测试；写盘失败时抛出，由调用方转成错误结果。 */
export function runRole(data: QqbotData, session: QqbotSession, rawInput: string): CommandResult {
  // 每次执行都重新扫描，用户在文件里改过的角色卡由此生效。
  data.roles.reload()
  const [verb, argument, extra] = rawInput.trim().split(/\s+/).filter(word => word !== '')
  if (verb === undefined) return { kind: 'success', text: overview(data, session) }
  if (verb === 'list' && argument === undefined) return { kind: 'success', text: roster(data, data.roleIdFor(session)) }

  if ((verb === 'none' || verb === 'off') && argument === undefined) {
    const before = data.roleIdFor(session)
    data.bindings.set(session.id, NO_ROLE)
    const head = before === undefined ? '这个会话本来就没有角色。' : `已取消角色 ${before}，下一条消息起不带角色。`
    return { kind: 'success', text: `${head}\n\n${overview(data, session)}` }
  }

  if (verb === 'default' && argument !== undefined && extra === undefined) {
    if (argument === 'none' || argument === 'off') {
      data.bindings.setDefaultRole(undefined)
      return { kind: 'success', text: '新会话不再默认带角色。已有会话不变。' }
    }
    const role = data.roles.get(argument)
    if (role === undefined) return { kind: 'error', text: `没有 id 为 "${argument}" 的角色。\n\n${roster(data, data.roleIdFor(session))}` }
    data.bindings.setDefaultRole(role.id)
    return { kind: 'success', text: `新 QQ 会话默认使用 ${label(role)}。已有会话不变。` }
  }

  if (argument !== undefined) return { kind: 'error', text: USAGE }
  const role = data.roles.get(verb)
  if (role === undefined) return { kind: 'error', text: `没有 id 为 "${verb}" 的角色。\n\n${roster(data, data.roleIdFor(session))}` }
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
    description: '切换这个 QQ 会话的角色',
    input: { hint: '[<id>|list|none|default <id>]' },
    handler: ({ agent, rawInput }) => {
      try {
        return runRole(data, { id: agent.id }, rawInput)
      } catch (error) {
        return { kind: 'error', text: `角色没有切换：${(error as Error).message}` }
      }
    },
  }), 'qqbot: /role command')
}
