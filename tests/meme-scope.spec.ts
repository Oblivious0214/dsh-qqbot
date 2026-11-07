import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemeSource } from '../src/meme-source.ts'
import type { MemeSettings } from '../src/meme-source.ts'
import { findMeme, memeMarker, projectMemes, searchMemes, type ScopedMeme } from '../src/meme-scope.ts'
import { memeRoleAt } from '../src/meme-api.ts'
import * as memeApi from '../src/meme-api.ts'
import * as memeAgent from '../src/meme-agent.ts'
import { scopedMemeTool } from '../src/meme-agent.ts'
import { hostFixture, rc5Prompt } from './role-dynamics/host-fixture.ts'

const row = (pack: string, path = 'memes/happy/same.png', caption = '开心'): ScopedMeme => ({ pack, path, caption, tag: 'happy', keywords: '微笑', url: `/dsh-memes/${pack}/${path}` })
const packs = ['cat', 'fish'].map(id => ({ id, name: id }))

function sourceFixture(options: { settings?: MemeSettings; after?: () => void; wrongPack?: boolean; badUrl?: boolean } = {}) {
  let settings = options.settings ?? { enabledPacks: ['cat', 'fish'] }
  const requested: string[] = []
  const request: typeof fetch = vi.fn(async (input, init) => {
    expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined()
    const url = new URL(String(input)); requested.push(url.search)
    expect(url.origin).toBe('http://localhost:1234')
    expect(url.searchParams.get('packId')).not.toBe('all')
    const pack = url.searchParams.get('packId')
    const found = row(pack ?? 'fish')
    if (options.badUrl) (found as { url: string }).url = '/dsh-memes/fish/memes/happy/wrong.png'
    if (pack) options.after?.()
    return Response.json({ ok: true, packs, packId: options.wrongPack ? 'fish' : pack ?? 'fish',
      memes: pack ? [found] : [], tags: ['happy'] })
  })
  return { source: new MemeSource(() => 'http://localhost:1234', () => settings, request), requested,
    settings: (next: MemeSettings) => { settings = next } }
}
const signal = () => new AbortController().signal

describe('role-scoped catalogue', () => {
  it('two simultaneous roles read only their own selected, globally enabled pack', async () => {
    const f = sourceFixture()
    const [cat, fish] = await Promise.all(packs.map(pack => f.source.read([pack], signal())))
    expect(cat!.memes.map(m => m.pack)).toEqual(['cat'])
    expect(fish!.memes.map(m => m.pack)).toEqual(['fish'])
    expect(f.requested.filter(q => q.includes('packId='))).toEqual(['?packId=cat', '?packId=fish'])
  })
  it('empty selection, disabled packs and text mode never query images or use the active default', async () => {
    const f = sourceFixture({ settings: { enabledPacks: ['fish'] } })
    expect((await f.source.read([], signal())).memes).toEqual([])
    expect((await f.source.read([packs[0]!], signal())).memes).toEqual([])
    f.settings({ sendMode: 'text' })
    expect((await f.source.read(packs, signal())).memes).toEqual([])
    expect(f.requested).toEqual([])
  })
  it('legacy global settings use only the API active pack, still intersected with the role', async () => {
    const f = sourceFixture({ settings: {} })
    expect((await f.source.read(packs, signal())).memes.map(m => m.pack)).toEqual(['fish'])
    expect(f.requested).not.toContain('?packId=cat')
  })
  it('empty global enabled list is not interpreted as missing configuration', async () => {
    const f = sourceFixture({ settings: { enabledPacks: [] } })
    expect((await f.source.read(packs, signal())).memes).toEqual([])
    expect(f.requested).toEqual([])
  })
  it('a pack disabled while fetching is excluded from the result', async () => {
    const f = sourceFixture({ after: () => f.settings({ enabledPacks: ['fish'] }) })
    expect((await f.source.read([packs[0]!], signal())).memes).toEqual([])
  })
  it('rejects API fallback to a different pack and excludes wrong image URLs', async () => {
    await expect(sourceFixture({ wrongPack: true }).source.read([packs[0]!], signal())).rejects.toThrow('图库已变化')
    expect((await sourceFixture({ badUrl: true }).source.read([packs[0]!], signal())).memes).toEqual([])
  })
  it('propagates API errors and cancellation instead of querying an unrestricted pool', async () => {
    const source = new MemeSource(() => 'http://localhost', () => ({ enabledPacks: ['cat'] }), async () => new Response('', { status: 403 }))
    await expect(source.read([packs[0]!], signal())).rejects.toThrow('读取表情图库失败')
    const f = sourceFixture(), abort = new AbortController(); abort.abort()
    await expect(f.source.read([packs[0]!], abort.signal)).rejects.toThrow()
  })
})

describe('scoped final display', () => {
  it('same captions in different packs retain candidate identity', () => {
    const cat = row('cat'), fish = row('fish')
    expect(findMeme('开心', [cat])).toBe(cat)
    expect(findMeme('开心', [fish])).toBe(fish)
    const marker = memeMarker(cat)
    expect(projectMemes(marker, [cat, fish])).toContain(cat.url)
    expect(projectMemes(marker, [fish])).toBe('表情暂不可用')
    expect(projectMemes(marker, [])).toBe('表情暂不可用')
    expect(projectMemes(marker, [cat])).not.toContain('[表情:')
  })
  it('legacy markers and explicit URLs cannot bypass the role catalogue', () => {
    const cat = row('cat'), fish = row('fish')
    expect(projectMemes('[表情: 开心](https://outside/wrong.png)', [cat])).toContain(cat.url)
    expect(projectMemes('[表情: 其他]', [cat])).toBe('其他')
    expect(projectMemes(`![开心](${fish.url})`, [cat])).toBe('开心')
    expect(projectMemes('![普通图片](https://example.com/photo.png)', [])).toContain('https://example.com/photo.png')
    expect(projectMemes('`[表情: 开心]`', [cat])).toBe('`[表情: 开心]`')
  })
  it('escapes Markdown in descriptions and preserves URL identity with punctuation', () => {
    const image = row('cat', 'memes/happy/a(1).png', '开心 [图片](https://outside)')
    expect(projectMemes(memeMarker(image), [image])).toContain(`](<${image.url}>)`)
    expect(projectMemes(memeMarker(image), [image])).toContain('\\[图片\\]')
  })
  it('search stays in scope, exposes real tags, and does not substitute an unrelated image', () => {
    const cat = row('cat')
    expect(searchMemes([cat], 'nsfw')).toEqual([])
    expect(searchMemes([cat], '', 'missing')).toEqual([])
    expect(searchMemes([cat], 'happy', '微笑', 99)).toEqual([cat])
  })
})

describe('actual rc.5 scoped tools and prompt assembly', () => {
  async function fixture() {
    const f = await hostFixture()
    const execute = vi.fn(() => ({ message: 'GLOBAL' }))
    const global = { name: 'send_meme', description: 'global meme', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] }, execute }
    const remove = f.root.tools.register(global as never)
    const requests: string[][] = []
    const read = vi.spyOn(f.root.qqbot.memes, 'read').mockImplementation(async packs => {
      requests.push(packs.map(p => p.id)); return { memes: packs.map(p => row(p.id)) }
    })
    const data = f.root.qqbot.content
    const current = data.roles.get(f.role.id)!
    data.roles.save({ ...current, dynamicsBaseRevision: current.dynamicsRevision, memePacks: [packs[0]!] }, false)
    return { ...f, execute, remove, requests, read, global, data }
  }
  it('shadows only QQ agents, executes through real host pipeline, and follows role changes', async () => {
    const f = await fixture()
    try {
      const qq = await f.agent('meme-qq'), standard = await f.agent('meme-standard', undefined, undefined, false)
      const other = f.data.roles.save({ id: 'other-meme', name: '其他表情角色', description: '', persona: '测试角色', memePacks: [packs[1]!] }, true)
      const second = await f.agent('meme-second'); f.data.bindings.set(second.id, other.id)
      expect(f.root.tools.get('send_meme', standard.value)).toBe(f.global)
      expect(f.root.tools.get('send_meme', qq.value)).not.toBe(f.global)
      const call = (a: typeof qq) => f.root.tools.execute({ agent: a.value, callId: 'meme-call' as never, name: 'send_meme', arguments: { tag: 'happy' }, signal: signal() } as never)
      const [cat, fish] = await Promise.all([call(qq), call(second)])
      expect(cat.isError).toBeFalsy(); expect(fish.isError).toBeFalsy()
      expect(JSON.stringify(cat.content)).toContain('qqbot:cat:')
      expect(JSON.stringify(fish.content)).toContain('qqbot:fish:')
      expect(f.execute).not.toHaveBeenCalled()
      f.data.bindings.set(qq.id, other.id)
      expect(JSON.stringify((await call(qq)).content)).toContain('qqbot:fish:')
      f.data.bindings.set(qq.id, null)
      await call(qq); expect(f.requests.at(-1)).toEqual([])
      await f.promptFiber.dispose()
      expect(f.root.tools.get('send_meme', qq.value)).toBe(f.global)
    } finally { await f.dispose() }
  })
  it('includes native/ptc declarations and removes scoped tools when dsh-meme stops', async () => {
    const f = await fixture()
    try {
      const qq = await f.agent('meme-assembly')
      f.start(qq)
      const native = await f.assemble(qq)
      expect(native.tools.some((t: { name: string }) => t.name === 'send_meme')).toBe(true)
      expect(rc5Prompt.renderPrompt(native)).toContain('可用图库："cat"')
      qq.ctx.tools.presentAs('ptc')
      expect(rc5Prompt.renderPrompt(await f.assemble(qq))).toContain('tools.send_meme')
      f.remove()
      expect(f.root.tools.get('send_meme', qq.value)).toBeUndefined()
      expect(rc5Prompt.renderPrompt(await f.assemble(qq))).not.toContain('tools.send_meme')
      f.root.tools.register(f.global as never)
      expect(f.root.tools.get('send_meme', qq.value)).not.toBe(f.global)
    } finally { await f.dispose() }
  })
  it('uses historical turn roles and never assigns a later role to an unknown earlier turn', async () => {
    const f = await fixture()
    try {
      await f.agent('history')
      f.data.bindings.set('history', f.role.id)
      f.data.bindings.recordTurn('history', 3, f.role.id)
      f.data.bindings.recordTurn('history', 5, null)
      expect(memeRoleAt(f.data, 'history', 2)).toBeUndefined()
      expect(memeRoleAt(f.data, 'history', 3)?.id).toBe(f.role.id)
      expect(memeRoleAt(f.data, 'history', 5)).toBeUndefined()
    } finally { await f.dispose() }
  })
  it('discards a late result after a role change', async () => {
    const f = await fixture()
    try {
      const qq = await f.agent('meme-late')
      let finish!: () => void
      f.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); return { memes: [row('cat')] } })
      const tool = scopedMemeTool(f.root as Context, qq.value)
      const pending = tool.execute({}, { agent: qq.value, signal: signal() } as never)
      f.data.bindings.set(qq.id, null); finish()
      await expect(pending).rejects.toThrow('角色表情设置已变化')
    } finally { await f.dispose() }
  })
  it('serves the display API only for QQ sessions and rechecks selection after reading', async () => {
    const f = await fixture()
    try {
      await f.root.plugin(memeApi)
      const qq = await f.agent('meme-api'), standard = await f.agent('meme-api-standard', undefined, undefined, false)
      f.data.bindings.set(qq.id, f.role.id)
      const route = f.route('/api/qqbot/memes')
      const request = (session: string, turn = '1') => route.fetch(new Request(`http://local/api/qqbot/memes?session=${session}&turn=${turn}`))
      expect((await request(standard.id)).status).toBe(404)
      expect((await request(qq.id, '-1')).status).toBe(400)
      expect((await (await request(qq.id)).json()).memes[0].pack).toBe('cat')
      let finish!: () => void
      f.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); return { memes: [row('cat')] } })
      const pending = request(qq.id)
      // maintenance.route crosses an await before invoking the handler.
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      f.data.bindings.set(qq.id, null); finish()
      expect((await (await pending).json()).memes).toEqual([])
    } finally { await f.dispose() }
  })
  it('can restore scoped registration for an already loaded QQ agent', async () => {
    const f = await fixture()
    try {
      const qq = await f.agent('meme-reload'), standard = await f.agent('meme-reload-standard', undefined, undefined, false)
      await f.promptFiber.dispose()
      expect(f.root.tools.get('send_meme', qq.value)).toBe(f.global)
      const reloaded = await f.preset.ctx.plugin(memeAgent)
      expect(f.root.tools.get('send_meme', qq.value)).not.toBe(f.global)
      expect(f.root.tools.get('send_meme', standard.value)).toBe(f.global)
      await reloaded.dispose()
      expect(f.root.tools.get('send_meme', qq.value)).toBe(f.global)
    } finally { await f.dispose() }
  })
})
