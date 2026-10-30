/**
 * 角色和破限预设编辑接口：GET `/api/qqbot/library` 读全部，POST 提交一个操作。
 * 改动写进 `<DSH_HOME>/qqbot/`，下一轮组装时生效；所有会话都按 id 现读，不需要通知。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { QqbotData } from './content.ts'
import type {} from './index.ts'
import { LIBRARY_PATH, type LibraryError, type LibraryView } from './library-types.ts'
import { isRecord } from './storage.ts'
import type { UiStore } from './ui.ts'

export const name = 'qqbot-library'

/** 编辑界面需要的全部数据。顺带重新扫描角色库，用户直接改过的文件由此生效。 */
export function libraryView(data: QqbotData, saved?: string): LibraryView {
  data.roles.reload()
  const defaultRole = data.bindings.defaultRole
  return {
    rolesDir: data.roles.dir,
    roles: data.roles.list().map((role) => {
      const preset = data.presets.roleChoice(role.id)
      return {
        id: role.id, name: role.name, description: role.description, persona: role.persona,
        ...role.memeFrequency === undefined ? {} : { memeFrequency: role.memeFrequency },
        ...role.proactivity === undefined ? {} : { proactivity: role.proactivity },
        ...role.motionActions === undefined ? {} : { motionActions: role.motionActions },
        ...role.motionRanges === undefined ? {} : { motionRanges: role.motionRanges },
        ...role.voice === undefined ? {} : { voice: role.voice },
        ...preset === undefined ? {} : { preset },
      }
    }),
    ...defaultRole === undefined ? {} : { defaultRole },
    presets: data.presets.list(),
    defaultPreset: data.presets.defaultId,
    ...saved === undefined ? {} : { saved },
  }
}

/** 请求格式不对，和"操作本身失败"区分开。 */
export class BadRequest extends Error {}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value === '') throw new BadRequest(`缺少 ${key}`)
  return value
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new BadRequest(`${key} 必须是文本`)
  return value
}

function flag(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw new BadRequest(`缺少 ${key}`)
  return value
}

function requireRole(data: QqbotData, id: string): void {
  data.roles.reload()
  if (data.roles.get(id) === undefined) throw new Error('这个角色已经不在角色库里，可能已在文件里删除')
}

/**
 * 执行一个操作。格式错误抛 BadRequest，操作失败（重名、找不到、写不了盘）抛 Error。
 * 保存角色或预设时返回保存的 id。
 */
export function applyLibraryAction(data: QqbotData, body: unknown, ui?: UiStore): string | undefined {
  if (!isRecord(body)) throw new BadRequest('请求格式无效')
  switch (body['action']) {
    case 'role.save':
      return data.roles.save(body['role'], flag(body, 'create')).id
    case 'role.remove':
      // 会话绑定、默认角色和预设选择都留着：角色卡放回来就恢复。没有角色的会话按无角色运行。
      // 头像跟着移到回收站：之后新建同 id 的角色不会继承旧头像。
      data.roles.remove(text(body, 'id'), (trash, stamp) => { ui?.trashAvatar(text(body, 'id'), trash, stamp) })
      return
    case 'role.default': {
      const id = optionalText(body, 'id')
      if (id !== undefined) requireRole(data, id)
      data.bindings.setDefaultRole(id)
      return
    }
    case 'role.preset': {
      const id = text(body, 'id')
      requireRole(data, id)
      data.presets.assign(id, optionalText(body, 'preset'))
      return
    }
    case 'preset.save': {
      return data.presets.save(body['preset'], flag(body, 'create')).id
    }
    case 'preset.remove':
      data.presets.remove(text(body, 'id'))
      return
    case 'preset.default':
      data.presets.setDefault(text(body, 'id'))
      return
    default:
      throw new BadRequest('不认识的操作')
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(status: number, error: LibraryError['error'], message: string): Response {
  return json(status, { error, message } satisfies LibraryError)
}

export const inject = ['qqbot', 'connection']

export function apply(ctx: Context): void {
  const data = ctx.qqbot.content
  ctx.effect(() => ctx.connection.fetch.register({
    path: LIBRARY_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let saved: string | undefined
      if (request.method === 'POST') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return fail(400, 'bad-request', '请求不是有效的 JSON')
        }
        try {
          saved = applyLibraryAction(data, body, ctx.qqbot.ui)
        } catch (error) {
          if (error instanceof BadRequest) return fail(400, 'bad-request', error.message)
          return fail(409, 'failed', error instanceof Error ? error.message : String(error))
        }
      }
      return json(200, libraryView(data, saved))
    },
  }), 'qqbot: library route')
}
