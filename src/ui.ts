/**
 * QQ 界面设置和图片：设置存 `<数据目录>/ui.json`，角色头像存 `images/avatars/<角色 id>.<扩展名>`，
 * 聊天背景存 `images/background.<扩展名>`。只影响浏览器端显示，不进提示词。
 * 接口：UI_PATH 读写设置和图片，IMAGE_PATH 读图片。都走 DSH 的认证，只有 owner 能访问。
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { QqbotData } from './content.ts'
import type {} from './index.ts'
import { ROLE_ID_PATTERN } from './roles.ts'
import { isRecord, readJson, renameWithRetry, writeJson, type Warn } from './storage.ts'
import {
  BACKGROUND_FITS, DEFAULT_UI_SETTINGS, IMAGE_BYTE_LIMIT, IMAGE_PATH, INTERVAL_METHODS, PALETTES, UI_LIMITS, UI_PATH,
  type UiError, type UiRole, type UiSettings, type UiView,
} from './ui-types.ts'

export const name = 'qqbot-ui'

const IMAGE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const
type ImageType = keyof typeof IMAGE_TYPES

/** 请求格式不对，和"操作本身失败"区分开。 */
export class BadRequest extends Error {}

function numberIn(value: unknown, label: string, range: { readonly min: number; readonly max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
    throw new BadRequest(`${label}必须在 ${range.min}–${range.max} 之间`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, label: string, options: readonly T[]): T {
  const found = options.find(option => option === value)
  if (found === undefined) throw new BadRequest(`${label}无效`)
  return found
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequest(`${label}必须是开或关`)
  return value
}

/** 校验编辑器提交的整份设置；不合规时抛出可以直接展示给用户的错误。 */
export function validateUiSettings(value: unknown): UiSettings {
  if (!isRecord(value)) throw new BadRequest('界面设置格式无效')
  return {
    palette: oneOf(value['palette'], '色板', PALETTES),
    bubbleTail: bool(value['bubbleTail'], '气泡尾巴'),
    avatars: bool(value['avatars'], '头像'),
    chatMaxWidth: Math.round(numberIn(value['chatMaxWidth'], '聊天宽度', UI_LIMITS.chatMaxWidth)),
    immersive: bool(value['immersive'], '沉浸模式'),
    backgroundFit: oneOf(value['backgroundFit'], '背景显示方式', BACKGROUND_FITS),
    intervalMethod: oneOf(value['intervalMethod'], '间隔方式', INTERVAL_METHODS),
    intervalMin: numberIn(value['intervalMin'], '最短间隔', UI_LIMITS.interval),
    intervalMax: numberIn(value['intervalMax'], '最长间隔', UI_LIMITS.interval),
    logBase: numberIn(value['logBase'], '对数底数', UI_LIMITS.logBase),
  }
}

/** 读文件时逐字段兜底：手改坏了一项，其他项照常生效。 */
function looseSettings(value: unknown): UiSettings {
  if (!isRecord(value)) return DEFAULT_UI_SETTINGS
  const result: Record<string, unknown> = { ...DEFAULT_UI_SETTINGS }
  for (const key of Object.keys(DEFAULT_UI_SETTINGS) as (keyof UiSettings)[]) {
    if (!(key in value)) continue
    try {
      result[key] = validateUiSettings({ ...DEFAULT_UI_SETTINGS, [key]: value[key] })[key]
    } catch { /* 用默认值 */ }
  }
  return result as unknown as UiSettings
}

/** 解码浏览器传来的 data URL，按文件头确认真是 PNG/JPEG/WebP，不信任声明的类型。 */
export function decodeImage(data: unknown, limit: number): { type: ImageType; bytes: Buffer } {
  if (typeof data !== 'string') throw new BadRequest('缺少图片')
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data)
  if (match === null) throw new BadRequest('只支持 PNG、JPEG、WebP 图片')
  const bytes = Buffer.from(match[2]!, 'base64')
  if (bytes.length > limit) throw new BadRequest(`图片太大，最多 ${Math.round(limit / 1024)} KB`)
  const type = sniff(bytes)
  if (type === undefined || type !== match[1]) throw new BadRequest('图片内容和格式不符')
  return { type, bytes }
}

function sniff(bytes: Buffer): ImageType | undefined {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return undefined
}

/** 一张图片：同一个名字只留一种扩展名。 */
class ImageSlot {
  constructor(private readonly dir: string, private readonly stem: string) {}

  find(): { file: string; type: ImageType; version: number } | undefined {
    for (const type of Object.keys(IMAGE_TYPES) as ImageType[]) {
      const file = join(this.dir, `${this.stem}.${type}`)
      try {
        return { file, type, version: Math.floor(statSync(file).mtimeMs) }
      } catch { /* 下一种 */ }
    }
    return undefined
  }

  write(type: ImageType, bytes: Buffer): void {
    mkdirSync(this.dir, { recursive: true })
    const target = join(this.dir, `${this.stem}.${type}`)
    // 和 storage.ts 的 writeText 一样先写临时文件再改名；writeText 只写文本，图片在这里单独写。
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, bytes)
      renameWithRetry(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    for (const other of Object.keys(IMAGE_TYPES) as ImageType[]) {
      if (other !== type) rmSync(join(this.dir, `${this.stem}.${other}`), { force: true })
    }
  }

  remove(): void {
    for (const type of Object.keys(IMAGE_TYPES) as ImageType[]) rmSync(join(this.dir, `${this.stem}.${type}`), { force: true })
  }
}

export class UiStore {
  private settingsCache: UiSettings | undefined

  constructor(readonly dir: string, private readonly warn: Warn) {}

  private get file(): string { return join(this.dir, 'ui.json') }
  private get imageDir(): string { return join(this.dir, 'images') }
  private get avatarDir(): string { return join(this.imageDir, 'avatars') }

  get settings(): UiSettings {
    this.settingsCache ??= looseSettings(readJson(this.file, this.warn))
    return this.settingsCache
  }

  saveSettings(value: unknown): void {
    const settings = validateUiSettings(value)
    writeJson(this.file, { version: 1, ...settings })
    this.settingsCache = settings
  }

  background(): ImageSlot { return new ImageSlot(this.imageDir, 'background') }

  avatar(role: string): ImageSlot {
    if (!ROLE_ID_PATTERN.test(role)) throw new BadRequest('角色 id 无效')
    return new ImageSlot(this.avatarDir, role)
  }

  /** 角色 id → 头像版本。文件名不合规的跳过。 */
  avatarVersions(): Record<string, number> {
    let names: string[]
    try { names = readdirSync(this.avatarDir) } catch { return {} }
    const result: Record<string, number> = {}
    for (const file of names) {
      const match = /^([a-z0-9][a-z0-9-]{0,63})\.(png|jpeg|webp)$/.exec(file)
      if (match === null || match[1]! in result) continue
      const found = new ImageSlot(this.avatarDir, match[1]!).find()
      if (found !== undefined) result[match[1]!] = found.version
    }
    return result
  }

  /** 删除角色时把头像一起移到回收站，放回角色时可以一起放回。 */
  trashAvatar(role: string, trashDir: string, stamp: string): void {
    const found = this.avatar(role).find()
    if (found === undefined) return
    mkdirSync(trashDir, { recursive: true })
    renameWithRetry(found.file, join(trashDir, `${stamp}-${role}.avatar.${found.type}`))
  }
}

export function uiView(data: QqbotData, ui: UiStore, sessionId: string | undefined): UiView {
  const background = ui.background().find()?.version
  let session: UiView['session']
  if (sessionId !== undefined) {
    data.roles.reload()
    // 名称按角色库现读，角色改名后旧消息也显示新名字的首字。
    const show = (id: string | null | undefined): UiRole => {
      const role = id == null ? undefined : data.roles.get(id)
      return role === undefined ? null : { id: role.id, name: role.name }
    }
    session = {
      role: show(data.roleIdFor({ id: sessionId })),
      turns: data.bindings.turnsOf(sessionId).map(item => ({ turn: item.turn, role: show(item.role) })),
    }
  }
  return {
    settings: ui.settings,
    ...background === undefined ? {} : { background },
    avatars: ui.avatarVersions(),
    ...session === undefined ? {} : { session },
  }
}

/** 执行一个操作。格式错误抛 BadRequest，操作失败（找不到、写不了盘）抛 Error。 */
export function applyUiAction(data: QqbotData, ui: UiStore, body: unknown): void {
  if (!isRecord(body)) throw new BadRequest('请求格式无效')
  const role = () => {
    const id = body['role']
    if (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id)) throw new BadRequest('角色 id 无效')
    data.roles.reload()
    if (data.roles.get(id) === undefined) throw new Error(`没有 id 为 "${id}" 的角色`)
    return id
  }
  switch (body['action']) {
    case 'settings.save':
      ui.saveSettings(body['settings'])
      return
    case 'avatar.set': {
      const id = role()
      const image = decodeImage(body['data'], IMAGE_BYTE_LIMIT.avatar)
      ui.avatar(id).write(image.type, image.bytes)
      return
    }
    case 'avatar.remove':
      ui.avatar(role()).remove()
      return
    case 'background.set': {
      const image = decodeImage(body['data'], IMAGE_BYTE_LIMIT.background)
      ui.background().write(image.type, image.bytes)
      return
    }
    case 'background.remove':
      ui.background().remove()
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

function fail(status: number, error: UiError['error'], message: string): Response {
  return json(status, { error, message } satisfies UiError)
}

function sessionParam(request: Request): string | undefined {
  const id = new URL(request.url).searchParams.get('session')
  return id === null || id === '' || id.length > 512 ? undefined : id
}

/** 读图片。地址里带版本号，换图后地址就变了，所以可以让浏览器长期缓存。 */
export function imageResponse(ui: UiStore, request: Request): Response {
  const params = new URL(request.url).searchParams
  let found
  try {
    const kind = params.get('kind')
    if (kind === 'background') found = ui.background().find()
    else if (kind === 'avatar') found = ui.avatar(params.get('role') ?? '').find()
    else return fail(400, 'bad-request', '图片类型无效')
  } catch (error) {
    return fail(400, 'bad-request', error instanceof Error ? error.message : String(error))
  }
  if (found === undefined) return fail(404, 'not-found', '没有这张图片')
  let bytes: Buffer
  try { bytes = readFileSync(found.file) } catch { return fail(404, 'not-found', '没有这张图片') }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': IMAGE_TYPES[found.type],
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  })
}

export const inject = ['qqbot', 'connection']

export function apply(ctx: Context): void {
  const { content: data, ui } = ctx.qqbot
  ctx.effect(() => ctx.connection.fetch.register({
    path: UI_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'POST') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return fail(400, 'bad-request', '请求不是有效的 JSON')
        }
        try {
          applyUiAction(data, ui, body)
        } catch (error) {
          if (error instanceof BadRequest) return fail(400, 'bad-request', error.message)
          return fail(409, 'failed', error instanceof Error ? error.message : String(error))
        }
      }
      return json(200, uiView(data, ui, sessionParam(request)))
    },
  }), 'qqbot: ui route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: IMAGE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => Promise.resolve(imageResponse(ui, request)),
  }), 'qqbot: image route')
}
