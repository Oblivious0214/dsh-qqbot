/**
 * 角色和破限预设编辑接口：GET `/api/qqbot/library` 读全部，POST 提交一个操作。
 * 改动写进 `<DSH_HOME>/qqbot/`，下一轮组装时生效；所有会话都按 id 现读，不需要通知。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { QqbotData } from './content.ts'
import type {} from './index.ts'
import { MEME_TOOL } from './format.ts'
import { LIBRARY_PATH, type LibraryError, type LibraryView } from './library-types.ts'
import { outcomeMessage } from './memory-coordinator.ts'
import { normalizeMemory } from './memory-format.ts'
import { isRecord } from './storage.ts'
import type { UiStore } from './ui.ts'
import { CONFIG_MAX_BYTES, CONFIG_PATH } from './config-types.ts'
import { importConfiguration, previewConfiguration } from './config-import.ts'

export const name = 'qqbot-library'

/** 编辑界面需要的全部数据。顺带重新扫描角色库，用户直接改过的文件由此生效。 */
export function libraryView(data: QqbotData, saved?: string, features: LibraryView['features'] = { meme: false, toy: false }): LibraryView {
  data.roles.reload()
  const defaultRole = data.bindings.defaultRole
  return {
    features,
    rolesDir: data.roles.dir,
    roles: data.roles.list().map((role) => {
      const preset = data.presets.roleChoice(role.id)
      return {
        id: role.id, name: role.name, description: role.description, persona: role.persona,
        ...role.memeFrequency === undefined ? {} : { memeFrequency: role.memeFrequency },
        ...role.memePacks === undefined ? {} : { memePacks: role.memePacks },
        ...role.memeTags === undefined ? {} : { memeTags: role.memeTags },
        ...role.memePrompt === undefined ? {} : { memePrompt: role.memePrompt },
        ...role.proactivity === undefined ? {} : { proactivity: role.proactivity },
        ...role.proactivityTexts === undefined ? {} : { proactivityTexts: role.proactivityTexts },
        ...role.motionActions === undefined ? {} : { motionActions: role.motionActions },
        ...role.motionRanges === undefined ? {} : { motionRanges: role.motionRanges },
        ...role.voice === undefined ? {} : { voice: role.voice },
        ...preset === undefined ? {} : { preset },
        memory: data.memories.text(role.id),
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
    case 'role.save': {
      const draft = body['role']
      const preset = isRecord(draft) ? draft['preset'] : undefined
      const memory = isRecord(draft) ? draft['memory'] : undefined
      // 写角色前先校验预设和记忆，失败不能创建半个角色；旧调用未传时保留原绑定和原记忆。
      if (preset !== undefined && (typeof preset !== 'string' || data.presets.get(preset) === undefined)) {
        throw new Error('所选破限预设已不存在，请重新选择')
      }
      if (memory !== undefined && typeof memory !== 'string') throw new BadRequest('memory 必须是文本')
      if (typeof memory === 'string') normalizeMemory(memory)
      const saved = data.roles.save(draft, flag(body, 'create')).id
      if (typeof preset === 'string') data.presets.assign(saved, preset)
      if (typeof memory === 'string') data.memories.save(saved, memory)
      return saved
    }
    case 'role.remove':
      // 会话绑定、默认角色和预设选择都留着：角色卡放回来就恢复。没有角色的会话按无角色运行。
      // 头像跟着移到回收站：之后新建同 id 的角色不会继承旧头像。
      // 记忆也一起移走，否则同 id 的新角色会继承它。
      data.roles.remove(text(body, 'id'), (trash, stamp) => {
        ui?.trashAvatar(text(body, 'id'), trash, stamp)
        data.memories.trash(text(body, 'id'), trash, stamp)
      })
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
    path: CONFIG_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      const raw = await request.text()
      if (Buffer.byteLength(raw) > CONFIG_MAX_BYTES + 4096) return fail(413, 'bad-request', '配置文件不能超过 10 MB')
      let body: unknown
      try { body = JSON.parse(raw) } catch { return fail(400, 'bad-request', '配置文件不是有效的 JSON') }
      if (!isRecord(body) || !['preview', 'import'].includes(String(body['action']))) return fail(400, 'bad-request', '配置导入请求无效')
      try {
        if (body['action'] === 'preview') return json(200, { preview: previewConfiguration(data, body['config'], body['options']) })
        const imported = importConfiguration(data, body['config'], body['options'], body['revision'])
        return json(200, { imported, library: libraryView(data, undefined, {
          meme: ctx.get('tools')?.get(MEME_TOOL) !== undefined,
          toy: ctx.qqbot.store.snapshot().extensions.some(entry => entry.name === 'toy'),
        }) })
      } catch (error) {
        return fail(error instanceof TypeError ? 400 : 409, error instanceof TypeError ? 'bad-request' : 'failed', error instanceof Error ? error.message : String(error))
      }
    },
  }), 'qqbot: config import route')
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
          // 整理要等模型回复，单独异步处理；其他操作都是同步写盘。
          if (isRecord(body) && body['action'] === 'role.memory.consolidate') {
            const id = text(body, 'id')
            requireRole(data, id)
            const problem = outcomeMessage(await ctx.qqbot.memory.consolidateRole(id))
            if (problem !== undefined) throw new Error(problem)
          } else {
            saved = applyLibraryAction(data, body, ctx.qqbot.ui)
          }
        } catch (error) {
          if (error instanceof BadRequest) return fail(400, 'bad-request', error.message)
          return fail(409, 'failed', error instanceof Error ? error.message : String(error))
        }
      }
      // 按真实登记判断启用状态，不读安装目录或用户的插件配置。
      return json(200, libraryView(data, saved, {
        meme: ctx.get('tools')?.get(MEME_TOOL) !== undefined,
        toy: ctx.qqbot.store.snapshot().extensions.some(entry => entry.name === 'toy'),
      }))
    },
  }), 'qqbot: library route')
}
