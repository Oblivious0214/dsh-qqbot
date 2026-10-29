import { describe, expect, it } from 'vitest'
import { apply as applyHost, type QqbotService } from '../src/index.ts'
import { apply as applyPrompt } from '../src/prompt.ts'
import { SECTION_ORDER } from '../src/order.ts'
import { QqbotRegistryStore } from '../src/registry.ts'

type Text = string | ((context: { agent?: { id: string } }) => string)
interface Entry { name: string; order: number; text: Text; required?: boolean }

/** 只模拟本插件用到的 ctx 部分：provide、effect、systemPrompt.section/context。 */
function fakeContext() {
  const sections = new Map<string, Entry>()
  const contexts = new Map<string, Entry>()
  const effects: (() => void)[] = []
  const add = (map: Map<string, Entry>) => (entry: Entry) => {
    if (map.has(entry.name)) throw new Error(`duplicate ${entry.name}`)
    map.set(entry.name, entry)
    return () => { map.delete(entry.name) }
  }
  const ctx = {
    systemPrompt: { section: add(sections), context: add(contexts) },
    provide(name: string, value: unknown) { (ctx as Record<string, unknown>)[name] = value },
    effect(fn: () => () => void) { effects.push(fn()) },
  } as unknown as { qqbot: QqbotService }
  const render = (map: Map<string, Entry>, sessionId?: string) => [...map.values()]
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
    .map(entry => ({ name: entry.name, text: typeof entry.text === 'function' ? entry.text(sessionId === undefined ? {} : { agent: { id: sessionId } }) : entry.text }))
    .filter(entry => entry.text !== '')
  return {
    ctx,
    sections: (sessionId?: string) => render(sections, sessionId),
    contexts: (sessionId?: string) => render(contexts, sessionId),
    contextEntries: contexts,
    dispose: () => { for (const dispose of effects.splice(0).reverse()) dispose() },
  }
}

function setup() {
  const fake = fakeContext()
  applyHost(fake.ctx as never)
  applyPrompt(fake.ctx as never)
  return { ...fake, qqbot: fake.ctx.qqbot }
}

describe('registry', () => {
  it('rejects invalid and duplicate names', () => {
    const store = new QqbotRegistryStore()
    expect(() => store.extension({ name: 'Toy', text: '' })).toThrow(/invalid/)
    store.extension({ name: 'toy', text: 'a' })
    expect(() => store.extension({ name: 'toy', text: 'b' })).toThrow(/duplicate/)
  })

  it('stale disposer does not remove a re-registration', () => {
    const store = new QqbotRegistryStore()
    const first = store.runtime('toy', 'same')
    first()
    store.runtime('toy', 'same')
    first()
    expect(store.snapshot().runtime).toHaveLength(1)
  })
})

describe('prompt plugin', () => {
  it('assembles fixed sections in table order', () => {
    const { sections } = setup()
    expect(sections('s1').map(s => s.name)).toEqual(['qqbot:jb-head', 'qqbot:memory-hint'])
    expect(sections('s1')[0]?.text).toBe('所有角色均为成年人。')
  })

  it('diagnostic assembly without an agent has no per-session text', () => {
    const { sections } = setup()
    expect(sections().map(s => s.name)).toEqual(['qqbot:memory-hint'])
  })

  it('mounts each extension as its own section and follows registry changes', () => {
    const { qqbot, sections } = setup()
    const dispose = qqbot.extension({ name: 'toy', text: session => session.id === 's1' ? 'TOY' : '' })
    qqbot.extension({ name: 'alpha', text: 'A' })
    expect(sections('s1').map(s => s.name)).toEqual(['qqbot:jb-head', 'qqbot:ext:alpha', 'qqbot:ext:toy', 'qqbot:memory-hint'])
    expect(sections('s2').map(s => s.name)).not.toContain('qqbot:ext:toy')
    dispose()
    expect(sections('s1').map(s => s.name)).not.toContain('qqbot:ext:toy')
    expect(SECTION_ORDER.JB_HEAD < SECTION_ORDER.EXT && SECTION_ORDER.EXT < SECTION_ORDER.MEMORY_HINT).toBe(true)
  })

  it('runtime context is required, per session and skips empty entries', () => {
    const { qqbot, contexts, contextEntries } = setup()
    qqbot.runtime('toy', session => session.id === 's1' ? 'connected' : '')
    qqbot.runtime('role', 'r1')
    expect(contexts('s1')).toEqual([{ name: 'qqbot:runtime', text: 'role: r1\ntoy: connected' }])
    expect(contexts('s2')[0]?.text).toBe('role: r1')
    expect(contextEntries.get('qqbot:runtime')?.required).toBe(true)
  })

  it('disposing the prompt plugin removes extension sections', () => {
    const { qqbot, sections, dispose } = setup()
    qqbot.extension({ name: 'toy', text: 'TOY' })
    dispose()
    expect(sections('s1').map(s => s.name)).not.toContain('qqbot:ext:toy')
    qqbot.extension({ name: 'late', text: 'L' })
    expect(sections('s1').map(s => s.name)).not.toContain('qqbot:ext:late')
  })
})
