import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import * as prompt from '../src/prompt.ts'
import { assembleParts } from '../src/prompt.ts'
import { SECTION_NAME } from '../src/order.ts'
import { QqbotRegistryStore } from '../src/registry.ts'

type AssembleInput = { agent?: { id: string } }
type Text = string | ((context: AssembleInput) => string)
interface Entry { name: string; order: number; text: Text; required?: boolean; complete?: boolean }

/** 只模拟本插件用到的 systemPrompt.section/context。是 Service，注册随调用方插件释放，和 DSH 一样。 */
class FakeSystemPrompt extends Service {
  readonly sections = new Map<string, Entry>()
  readonly contexts = new Map<string, Entry>()
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  section(entry: Entry) { return this.add(this.sections, entry) }
  context(entry: Entry) { return this.add(this.contexts, entry) }
  private add(map: Map<string, Entry>, entry: Entry) {
    return this.ctx.effect(() => {
      if (map.has(entry.name)) throw new Error(`duplicate ${entry.name}`)
      map.set(entry.name, entry)
      return () => { map.delete(entry.name) }
    })
  }
}

/** 按 DSH 的规则排序、求值、去掉空段。agent 对象可以传入，模拟同一个 agent 的多次组装。 */
function render(map: Map<string, Entry>, input: AssembleInput = {}) {
  return [...map.values()]
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
    .map(entry => ({ name: entry.name, text: typeof entry.text === 'function' ? entry.text(input) : entry.text }))
    .filter(entry => entry.text !== '')
}

/** host 层 qqbot + 预设内提示词插件；viewer 依赖的服务不提供，它不会加载。 */
async function setup() {
  const root = new Context()
  await root.plugin(FakeSystemPrompt)
  await root.plugin(host)
  const promptFiber = await root.plugin(prompt)
  const systemPrompt = root.get('systemPrompt') as unknown as FakeSystemPrompt
  return {
    root,
    qqbot: root.qqbot,
    systemPrompt,
    sections: (input?: AssembleInput) => render(systemPrompt.sections, input),
    contexts: (input?: AssembleInput) => render(systemPrompt.contexts, input),
    disposePrompt: () => promptFiber.dispose(),
  }
}

/** 以插件身份登记，验证来源记录。 */
async function asPlugin(root: Context, name: string, run: (ctx: Context) => void) {
  await root.plugin({ name, inject: ['qqbot'], apply: (ctx: Context) => { ctx.inject(['qqbot'], run) } })
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

  it('records the registering plugin as source', async () => {
    const fake = await setup()
    await asPlugin(fake.root, 'dsh-toy-sample', (ctx) => {
      ctx.qqbot.extension({ name: 'toy', text: 'T' })
      ctx.qqbot.runtime('toy', 'R')
    })
    const snapshot = fake.qqbot.store.snapshot()
    expect(snapshot.extensions[0]?.source).toBe('dsh-toy-sample')
    expect(snapshot.runtime[0]?.source).toBe('dsh-toy-sample')
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, { id: 's1' }).find(p => p.name === 'qqbot:ext:toy')?.source)
      .toBe('dsh-toy-sample')
  })
})

describe('prompt plugin', () => {
  const text = (fake: Awaited<ReturnType<typeof setup>>, id?: string) =>
    fake.sections(id === undefined ? {} : { agent: { id } }).map(s => s.text).join('')

  it('registers one complete section', async () => {
    const fake = await setup()
    expect([...fake.systemPrompt.sections.keys()]).toEqual([SECTION_NAME.PROMPT])
    expect(fake.systemPrompt.sections.get(SECTION_NAME.PROMPT)?.complete).toBe(true)
  })

  it('joins fixed parts in table order', async () => {
    const fake = await setup()
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, { id: 's1' }).map(p => p.name))
      .toEqual(['qqbot:jb-head', 'qqbot:memory-hint'])
    expect(text(fake, 's1').startsWith('所有角色均为成年人。\n\n对话被压缩成摘要时')).toBe(true)
  })

  it('diagnostic assembly without an agent has no per-session text', async () => {
    const fake = await setup()
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, undefined).map(p => p.name)).toEqual(['qqbot:memory-hint'])
    expect(text(fake)).not.toContain('成年人')
  })

  it('places extensions by name between persona and memory hint, per session, following registry changes', async () => {
    const fake = await setup()
    const dispose = fake.qqbot.extension({ name: 'toy', text: session => session.id === 's1' ? 'TOY' : '' })
    fake.qqbot.extension({ name: 'alpha', text: 'A' })
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, { id: 's1' }).map(p => p.name))
      .toEqual(['qqbot:jb-head', 'qqbot:ext:alpha', 'qqbot:ext:toy', 'qqbot:memory-hint'])
    expect(text(fake, 's1')).toContain('A\n\nTOY\n\n')
    expect(text(fake, 's2')).not.toContain('TOY')
    dispose()
    expect(text(fake, 's1')).not.toContain('TOY')
  })

  it('records the last real assembly per agent, not diagnostic ones', async () => {
    const fake = await setup()
    const agent = { id: 's1' }
    fake.sections({})
    expect(fake.qqbot.lastPrompt.get(agent)).toBeUndefined()
    const [section] = fake.sections({ agent })
    expect(fake.qqbot.lastPrompt.get(agent)).toBe(section?.text)
  })

  it('runtime context is required, per session and skips empty entries', async () => {
    const fake = await setup()
    fake.qqbot.runtime('toy', session => session.id === 's1' ? 'connected' : '')
    fake.qqbot.runtime('role', 'r1')
    expect(fake.contexts({ agent: { id: 's1' } })).toEqual([{ name: 'qqbot:runtime', text: 'role: r1\ntoy: connected' }])
    expect(fake.contexts({ agent: { id: 's2' } })[0]?.text).toBe('role: r1')
    expect(fake.systemPrompt.contexts.get('qqbot:runtime')?.required).toBe(true)
  })

  it('disposing the prompt plugin removes its section and context', async () => {
    const fake = await setup()
    await fake.disposePrompt()
    expect(fake.systemPrompt.sections.size).toBe(0)
    expect(fake.systemPrompt.contexts.size).toBe(0)
  })
})
