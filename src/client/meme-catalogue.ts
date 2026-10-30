/** dsh-meme 0.1.64 的只读目录接口；使用不存在的 tag 避免传输整个图库。 */
import type { MemePackChoice } from '../library-types.ts'

interface CataloguePage {
  readonly packs: readonly MemePackChoice[]
  readonly tags: readonly string[]
  readonly packId: string
}
export interface MemeCatalogue {
  readonly packs: readonly MemePackChoice[]
  readonly tagsByPack: ReadonlyMap<string, readonly string[]>
}

export async function readMemeCatalogue(signal: AbortSignal, request: typeof fetch = fetch): Promise<MemeCatalogue> {
  const page = async (pack?: string): Promise<CataloguePage> => {
    const query = new URLSearchParams({ tag: '__qqbot_catalogue_only__' })
    if (pack !== undefined) query.set('packId', pack)
    const response = await request(`dsh-memes-api?${query}`, { method: 'GET', cache: 'no-store', signal })
    const data = await response.json().catch(() => undefined) as (Partial<CataloguePage> & { ok?: boolean }) | undefined
    if (!response.ok || data?.ok !== true || !Array.isArray(data.packs) || !Array.isArray(data.tags)
      || typeof data.packId !== 'string' || data.tags.some(tag => typeof tag !== 'string')
      || data.packs.some(p => p === null || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.name !== 'string')) {
      throw new Error('读取图库失败，请检查 dsh-meme 是否启用及允许当前访问方式。')
    }
    return { packId: data.packId, packs: data.packs.map(p => ({ id: p.id, name: p.name })), tags: data.tags }
  }
  const first = await page()
  const tagsByPack = new Map<string, readonly string[]>([[first.packId, first.tags]])
  const remaining = first.packs.filter(p => p.id !== first.packId)
  // 大图库集合也不一次发起几十个请求。任一失败由界面重试，绝不清空已有选择。
  for (let i = 0; i < remaining.length; i += 4) {
    const pages = await Promise.all(remaining.slice(i, i + 4).map(async p => ({ id: p.id, value: await page(p.id) })))
    for (const { id, value } of pages) tagsByPack.set(id, value.tags)
  }
  return { packs: first.packs, tagsByPack }
}
