import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionBindings, NO_ROLE } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { libraryView } from '../src/library.ts'
import { JailbreakStore } from '../src/presets.ts'
import { assembleParts } from '../src/prompt.ts'
import { QqbotRegistryStore } from '../src/registry.ts'
import { parseRole, RoleLibrary } from '../src/roles.ts'
import { readMemeCatalogue } from '../src/client/meme-catalogue.ts'

const preferences = {
  memePacks: [{ id: 'cat', name: '猫“猫”\\图库' }], memeTags: ['happy', '喵'],
  memePrompt: '优先可爱的图。\n保留 "引号"、\\ 和 $&。', memeFrequency: 'low' as const,
}
const draft = { id: 'alice', name: '小猫', description: '', persona: '角色正文。' }
function data() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-meme-'))
  const warn = () => {}
  return new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn)
}

describe('role meme preferences', () => {
  it('round-trips multiline text, quotes and paths; saving other fields retains preferences', () => {
    const d = data()
    d.roles.save({ ...draft, ...preferences, voice: 'v-0000000a', motionActions: ['steady'] }, true)
    const file = join(d.roles.dir, draft.id, 'ROLE.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('\n---\n', '\ncustom: 保留\n---\n'))
    d.roles.reload()
    const role = libraryView(d).roles[0]!
    expect(role).toMatchObject(preferences)
    d.roles.save({ ...role, name: '改名', persona: '改正文。' }, false)
    expect(d.roles.get(draft.id)).toMatchObject({ ...preferences, voice: 'v-0000000a', motionActions: ['steady'] })
    expect(readFileSync(file, 'utf8')).toContain('custom: 保留')
    // 清空表情偏好不影响音色、设备偏好和其他手写字段。
    const { memePacks: _p, memeTags: _t, memePrompt: _s, memeFrequency: _f, ...rest } = role
    d.roles.save(rest, false)
    expect(readFileSync(file, 'utf8')).not.toMatch(/memePacks|memeTags|memePrompt|memeFrequency/)
    expect(d.roles.get(draft.id)).toMatchObject({ voice: 'v-0000000a', motionActions: ['steady'] })
  })

  it('keeps preferences per session and only emits them when send_meme is admitted', () => {
    const d = data()
    d.roles.save({ ...draft, ...preferences }, true)
    d.roles.save({ ...draft, id: 'bob', name: '另一个角色' }, true)
    d.bindings.set('s1', 'alice'); d.bindings.set('s2', 'bob'); d.bindings.set('s3', NO_ROLE)
    const store = new QqbotRegistryStore()
    const parts = (id: string, meme = true) => assembleParts(d, store, { id }, { meme })
    const text = (id: string, meme = true) => parts(id, meme).map(p => p.text).join('\n')
    const first = text('s1')
    expect(first).toContain('可用图库：')
    expect(first).toContain('没有合适的表情时继续文字回应')
    expect(first).toContain('偏好标签："happy"、"喵"')
    expect(first).toContain(preferences.memePrompt)
    expect(text('s1')).toBe(first)
    expect(text('s2')).toContain('当前角色未选图库')
    expect(text('s3')).toContain('当前角色未选图库')
    expect(text('s1', false)).not.toMatch(/send_meme|可用图库|偏好标签|表情补充要求/)
    const before = parts('s1')
    d.roles.save({ ...draft, ...preferences, memePrompt: '新偏好' }, false)
    expect(text('s1')).toContain('新偏好')
    expect(parts('s1').filter(p => p.order < 410)).toEqual(before.filter(p => p.order < 410))
    d.bindings.set('s1', 'bob')
    expect(text('s1')).not.toContain('新偏好')
  })

  it('rejects invalid submissions and tolerates individual malformed handwritten fields', () => {
    const d = data()
    for (const bad of [{ memePacks: 'cat' }, { memePacks: [{ id: 'x', name: '' }] }, { memeTags: [null] }, { memePrompt: 'x'.repeat(4001) }]) {
      expect(() => d.roles.save({ ...draft, ...bad }, true)).toThrow()
    }
    expect(d.roles.list()).toEqual([])
    expect(parseRole('---\nmemePacks: not-json\nmemeTags: ["happy"]\nmemePrompt: 4\n---\n正文', 'a'))
      .toMatchObject({ memeTags: ['happy'] })
    expect(d.roles.save({ ...draft, memePacks: [], memeTags: [], memePrompt: '   ' }, true)).toEqual({
      ...draft, dynamicsRevision: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    })
  })
})

describe('read-only meme catalogue', () => {
  it('collects actual tags across packs with GET and never requests the all-images endpoint', async () => {
    const requests: string[] = []
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://local/base/')
      requests.push(url.toString())
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(url.pathname).toBe('/base/dsh-memes-api')
      expect(url.searchParams.get('tag')).toBe('__qqbot_catalogue_only__')
      const packId = url.searchParams.get('packId') ?? 'cat'
      return Response.json({ ok: true, packs: [{ id: 'cat', name: '猫' }, { id: 'dog', name: '狗' }], packId, tags: packId === 'cat' ? ['喵', 'happy'] : ['汪'] })
    }
    const catalogue = await readMemeCatalogue(new AbortController().signal, request)
    expect(catalogue.packs.map(p => p.name)).toEqual(['猫', '狗'])
    expect(catalogue.tagsByPack.get('dog')).toEqual(['汪'])
    expect(requests).toHaveLength(2)
  })

  it('reports unavailable/invalid APIs and forwards cancellation', async () => {
    const signal = new AbortController().signal
    const invalid: typeof fetch = async (_input, init) => {
      expect(init?.signal).toBe(signal)
      return Response.json({ ok: true, packs: [{ id: 'cat' }], tags: [] })
    }
    await expect(readMemeCatalogue(signal, invalid)).rejects.toThrow('读取图库失败')
    await expect(readMemeCatalogue(signal, async () => new Response('{}', { status: 403 }))).rejects.toThrow('读取图库失败')
    await expect(readMemeCatalogue(signal, async () => new Response('<html>not found</html>', { status: 404 }))).rejects.toThrow('读取图库失败')
  })
})
