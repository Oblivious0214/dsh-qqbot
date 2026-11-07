/** dsh-meme 只读适配：全局开关读配置，图片清单读其 GET API，不改第三方源码或设置。 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from './json-record.ts'
import type { MemePackChoice } from './library-types.ts'
import type { MemeScopeView, ScopedMeme } from './meme-scope.ts'

export interface MemeSettings { readonly enabledPacks?: readonly string[]; readonly sendMode?: string }
export function readMemeSettings(): MemeSettings {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(process.env['DSH_MEME_HOME'] || homedir(), '.dsh', 'dsh-expression.json'), 'utf8').replace(/^\uFEFF/, '')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('读取表情包设置失败') }
  if (!isRecord(raw) || (raw['enabledPacks'] !== undefined && (!Array.isArray(raw['enabledPacks']) || raw['enabledPacks'].some(id => typeof id !== 'string')))) throw new Error('表情包设置格式无效')
  return { ...(raw['enabledPacks'] === undefined ? {} : { enabledPacks: raw['enabledPacks'] as string[] }),
    ...(typeof raw['sendMode'] === 'string' ? { sendMode: raw['sendMode'] } : {}) }
}

export class MemeSource {
  constructor(private readonly origin: () => string, private readonly settings = readMemeSettings, private readonly request: typeof fetch = fetch) {}

  async read(selected: readonly MemePackChoice[], signal: AbortSignal): Promise<MemeScopeView> {
    if (!selected.length) return { memes: [], message: '请在角色的表情包设置中选择可用图库。' }
    const before = this.settings()
    if (before.sendMode === 'text') return { memes: [], message: '表情包当前使用纯文字模式。' }
    if (before.enabledPacks && !selected.some(pack => before.enabledPacks!.includes(pack.id))) return { memes: [], message: '角色所选图库尚未在表情包设置中启用。' }
    const origin = this.origin()
    const get = async (params: URLSearchParams): Promise<Record<string, unknown>> => {
      const response = await this.request(new URL(`/dsh-memes-api?${params}`, origin), { method: 'GET', redirect: 'error', signal })
      if (!response.ok) throw new Error('读取表情图库失败')
      const body: unknown = await response.json()
      if (!isRecord(body) || body['ok'] !== true || !Array.isArray(body['packs']) || typeof body['packId'] !== 'string') throw new Error('表情图库接口不兼容')
      return body
    }
    const catalogue = await get(new URLSearchParams({ tag: '__qqbot_catalogue_only__' }))
    const available = new Set((catalogue['packs'] as unknown[]).filter(isRecord).map(pack => pack['id']))
    const enabled = new Set(before.enabledPacks ?? [catalogue['packId'] as string])
    const allowed = selected.filter(pack => enabled.has(pack.id) && available.has(pack.id))
    const rows: ScopedMeme[] = []
    for (let i = 0; i < allowed.length; i += 4) {
      const pages = await Promise.all(allowed.slice(i, i + 4).map(async pack => {
        const page = await get(new URLSearchParams({ packId: pack.id }))
        // dsh-meme 对不存在的 id 可能回退到活动图库，必须复核返回身份。
        if (page['packId'] !== pack.id || !Array.isArray(page['memes'])) throw new Error('所选表情图库已变化')
        return { pack, entries: page['memes'] as unknown[] }
      }))
      for (const { pack, entries } of pages) for (const row of entries) {
        if (!isRecord(row) || typeof row['path'] !== 'string' || typeof row['url'] !== 'string') continue
        const path = row['path']
        if (!path || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f]/.test(path)) continue
        const url = `/dsh-memes/${encodeURIComponent(pack.id)}/${path.split('/').map(encodeURIComponent).join('/')}`
        // 接口给的 URL 必须准确指向这一库这一张图片，不能借外部 URL 或活动库别名绕过范围。
        if (row['url'] !== url) continue
        rows.push({ pack: pack.id, path, url, caption: String(row['caption'] || row['file_name'] || '表情').slice(0, 200),
          tag: String(row['tag'] || ''), keywords: String(row['keywords'] || '') })
      }
    }
    signal.throwIfAborted()
    // 读取期间全局被关掉的图库也立即退出候选。
    const after = this.settings()
    const stillEnabled = new Set(after.enabledPacks ?? [catalogue['packId'] as string])
    return { origin, memes: after.sendMode === 'text' ? [] : rows.filter(row => stillEnabled.has(row.pack)) }
  }
}
