import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import { buildPromptView } from '../src/viewer.ts'
import { PROMPT_VIEW_PATH, type PromptView } from '../src/view-types.ts'
import { createDefaultContent } from '../src/content.ts'
import { QqbotRegistryStore } from '../src/registry.ts'
import { DEFAULT_JAILBREAK } from '../src/presets.ts'

const session = { id: 's1' }

function input(store = new QqbotRegistryStore(), overrides: Partial<Parameters<typeof buildPromptView>[0]> = {}) {
  return {
    session, content: createDefaultContent(), store, lastPrompt: undefined, workingDirectory: undefined, tools: [],
    features: { meme: false }, ...overrides,
  }
}

describe('buildPromptView', () => {
  it('gives each part its offset in the joined prompt', () => {
    const store = new QqbotRegistryStore()
    store.extension({ name: 'toy', text: 'TOY' }, 'dsh-toy-buttplug')
    const view = buildPromptView(input(store))
    const joined = view.system.parts.map(p => p.text).join('\n\n')
    expect(view.system.length).toBe(joined.length)
    for (const part of view.system.parts) expect(joined.slice(part.start, part.start + part.text.length)).toBe(part.text)
    expect(view.system.parts.map(p => [p.name, p.owner, p.source])).toEqual([
      ['qqbot:jb-head', 'qqbot', undefined],
      ['qqbot:format-segment', 'qqbot', undefined],
      ['qqbot:format-voice', 'qqbot', undefined],
      ['qqbot:ext:toy', 'extension', 'dsh-toy-buttplug'],
    ])
  })

  it('shows the meme rule only when send_meme is registered for the session', () => {
    const names = (meme: boolean) => buildPromptView(input(undefined, { features: { meme } })).system.parts.map(p => p.name)
    expect(names(false)).not.toContain('qqbot:format-meme')
    expect(names(true)).toEqual(['qqbot:jb-head', 'qqbot:format-segment', 'qqbot:format-meme', 'qqbot:format-voice'])
  })

  it('compares with the last real assembly', () => {
    const current = buildPromptView(input())
    const joined = current.system.parts.map(p => p.text).join('\n\n')
    expect(current.lastSent).toEqual({ state: 'none' })
    expect(buildPromptView(input(undefined, { lastPrompt: joined })).lastSent).toEqual({ state: 'same' })
    const store = new QqbotRegistryStore()
    store.extension({ name: 'toy', text: 'TOY' })
    // 外部段落接在原来的末尾之后，变化从上一轮的结尾开始。
    const changed = buildPromptView(input(store, { lastPrompt: joined }))
    expect(changed.lastSent).toEqual({ state: 'changed', firstDiff: joined.length, previousLength: joined.length })
  })

  it('lists working directory and each runtime registration with its source', () => {
    const store = new QqbotRegistryStore()
    store.runtime('toy', s => s.id === 's1' ? 'device=disconnected' : '', 'dsh-toy-buttplug')
    store.runtime('empty', '')
    const view = buildPromptView(input(store, { workingDirectory: 'C:\\w' }))
    expect(view.contexts).toEqual([
      { name: 'working-directory:current', text: 'Current working directory: "C:\\\\w".', source: 'DSH' },
      { name: 'qqbot:runtime · toy', text: 'toy: device=disconnected', source: 'dsh-toy-buttplug' },
    ])
  })
})

describe('prompt view route', () => {
  type Route = { path: string; fetch: (request: Request) => Promise<Response> }

  async function mount(presets: Record<string, string>, tools?: string[]) {
    const root = new Context()
    if (tools !== undefined) root.provide('tools', { get: (name: string) => tools.includes(name) ? {} : undefined })
    const routes = new Map<string, Route>()
    const agents = new Map(Object.keys(presets).map(id => [id, {
      id,
      session: { id, requestHeader: () => ({ tools: [{ name: 'working_directory', description: 'd', parameters: {} }] }) },
    }]))
    root.provide('connection', { fetch: { register: (route: Route) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } })
    root.provide('agents', { get: (id: string) => agents.get(id) })
    root.provide('agentPresets', { presetForSession: (s: { id: string }) => presets[s.id] ?? null })
    const fiber = await root.plugin(host)
    const get = async (query: string) => {
      const response = await routes.get(PROMPT_VIEW_PATH)!.fetch(new Request(`http://127.0.0.1${PROMPT_VIEW_PATH}${query}`))
      return { status: response.status, body: await response.json() as PromptView & { error?: string } }
    }
    return { root, routes, get, agents, fiber }
  }

  it('answers only for live qqbot sessions', async () => {
    const { get } = await mount({ q: 'qqbot', s: 'standard' })
    expect((await get('')).status).toBe(400)
    expect((await get('?session=missing')).body.error).toBe('not-loaded')
    expect((await get('?session=s')).status).toBe(404)
    const ok = await get('?session=q')
    expect(ok.status).toBe(200)
    expect(ok.body.tools.map(t => t.name)).toEqual(['working_directory'])
    expect(ok.body.system.parts[0]?.text).toBe(DEFAULT_JAILBREAK.head)
  })

  it('predicts the meme rule from the registered tools', async () => {
    const names = async (tools?: string[]) => (await (await mount({ q: 'qqbot' }, tools)).get('?session=q')).body.system.parts.map(p => p.name)
    expect(await names()).not.toContain('qqbot:format-meme')
    expect(await names(['send_meme'])).toContain('qqbot:format-meme')
  })

  it('removes the route with the plugin', async () => {
    const { routes, fiber } = await mount({})
    expect(routes.has(PROMPT_VIEW_PATH)).toBe(true)
    await fiber.dispose()
    expect(routes.size).toBe(0)
  })
})
