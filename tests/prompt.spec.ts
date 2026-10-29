import { describe, expect, it } from 'vitest'
import { apply as applyHost, type QqbotService } from '../src/index.ts'
import { apply as applyPrompt, assembleParts } from '../src/prompt.ts'
import { SECTION_NAME } from '../src/order.ts'
import { QqbotRegistryStore } from '../src/registry.ts'

type Text = string | ((context: { agent?: { id: string } }) => string)
interface Entry { name: string; order: number; text: Text; required?: boolean; complete?: boolean }

/** 只模拟本插件用到的 ctx 部分：provide、effect、systemPrompt.section/context。 */
function fakeContext() {
  const sections = new Map<string, Entry>()
  const contexts = new Map<string, Entry>()
  const effects: (() => void)[] = []
  const add = (map: Map<string, Entry>) => (entry: Entry) => {
    if (map.has(entry.name)) throw new Error(`duplicate ${entry.name}`)
    map.set(entry.name, entry)
    // 和 DSH 一样，注册随插件生命周期释放。
    const dispose = () => { map.delete(entry.name) }
    effects.push(dispose)
    return dispose
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
    sectionEntries: sections,
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
  const prompt = (fake: ReturnType<typeof setup>, sessionId?: string) => fake.sections(sessionId).map(s => s.text).join('')

  it('registers one complete section', () => {
    const fake = setup()
    expect([...fake.sectionEntries.keys()]).toEqual([SECTION_NAME.PROMPT])
    expect(fake.sectionEntries.get(SECTION_NAME.PROMPT)?.complete).toBe(true)
  })

  it('joins fixed parts in table order', () => {
    const fake = setup()
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, { id: 's1' }).map(p => p.name))
      .toEqual(['qqbot:jb-head', 'qqbot:memory-hint'])
    expect(prompt(fake, 's1').startsWith('所有角色均为成年人。\n\n对话被压缩成摘要时')).toBe(true)
  })

  it('diagnostic assembly without an agent has no per-session text', () => {
    const fake = setup()
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, undefined).map(p => p.name)).toEqual(['qqbot:memory-hint'])
    expect(prompt(fake)).not.toContain('成年人')
  })

  it('places extensions by name between persona and memory hint, per session, following registry changes', () => {
    const fake = setup()
    const dispose = fake.qqbot.extension({ name: 'toy', text: session => session.id === 's1' ? 'TOY' : '' })
    fake.qqbot.extension({ name: 'alpha', text: 'A' })
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, { id: 's1' }).map(p => p.name))
      .toEqual(['qqbot:jb-head', 'qqbot:ext:alpha', 'qqbot:ext:toy', 'qqbot:memory-hint'])
    expect(prompt(fake, 's1')).toContain('A\n\nTOY\n\n')
    expect(prompt(fake, 's2')).not.toContain('TOY')
    dispose()
    expect(prompt(fake, 's1')).not.toContain('TOY')
  })

  it('runtime context is required, per session and skips empty entries', () => {
    const { qqbot, contexts, contextEntries } = setup()
    qqbot.runtime('toy', session => session.id === 's1' ? 'connected' : '')
    qqbot.runtime('role', 'r1')
    expect(contexts('s1')).toEqual([{ name: 'qqbot:runtime', text: 'role: r1\ntoy: connected' }])
    expect(contexts('s2')[0]?.text).toBe('role: r1')
    expect(contextEntries.get('qqbot:runtime')?.required).toBe(true)
  })

  it('disposing the prompt plugin removes its section and context', () => {
    const fake = setup()
    fake.dispose()
    expect(fake.sectionEntries.size).toBe(0)
    expect(fake.contextEntries.size).toBe(0)
  })
})
