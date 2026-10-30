import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { NO_ROLE } from '../src/bindings.ts'
import * as host from '../src/index.ts'
import * as prompt from '../src/prompt.ts'
import { assembleParts } from '../src/prompt.ts'
import { SEGMENT_RULE, VOICE_RULE } from '../src/format.ts'
import { SECTION_NAME } from '../src/order.ts'
import { QqbotRegistryStore } from '../src/registry.ts'
import { DEFAULT_VOICE_SETTINGS } from '../src/voice-types.ts'

type AssembleInput = { agent?: { id: string }; toolSet?: { view: (scope: unknown) => ReadonlyMap<string, unknown> } }
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
    expect(snapshot.runtime.find(item => item.name === 'toy')?.source).toBe('dsh-toy-sample')
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
      .toEqual(['qqbot:jb-head', 'qqbot:format-segment', 'qqbot:format-voice'])
    expect(text(fake, 's1')).toBe(`所有角色均为成年人。\n\n${SEGMENT_RULE}\n\n${VOICE_RULE}`)
  })

  it('diagnostic assembly without an agent has no per-session text', async () => {
    const fake = await setup()
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, undefined, { meme: true }).map(p => p.name))
      .toEqual(['qqbot:format-segment', 'qqbot:format-voice'])
    expect(text(fake)).not.toContain('成年人')
  })

  it('adds the meme rule only when the step admits send_meme', async () => {
    const fake = await setup()
    const toolSet = (names: string[]) => ({ view: () => new Map(names.map(name => [name, {}])) })
    const assemble = (names?: string[]) => fake.sections({ agent: { id: 's1' }, ...names === undefined ? {} : { toolSet: toolSet(names) } })[0]!.text
    expect(assemble()).not.toContain('send_meme')
    expect(assemble(['working_directory'])).not.toContain('send_meme')
    const withMeme = assemble(['send_meme'])
    expect(withMeme.indexOf(SEGMENT_RULE)).toBeLessThan(withMeme.indexOf('send_meme'))
    expect(withMeme).toContain('表情频率：适中')
  })

  it('places extensions by name after the format rules, per session, following registry changes', async () => {
    const fake = await setup()
    const dispose = fake.qqbot.extension({ name: 'toy', text: session => session.id === 's1' ? 'TOY' : '' })
    fake.qqbot.extension({ name: 'alpha', text: 'A' })
    expect(assembleParts(fake.qqbot.content, fake.qqbot.store, { id: 's1' }).map(p => p.name))
      .toEqual(['qqbot:jb-head', 'qqbot:format-segment', 'qqbot:format-voice', 'qqbot:ext:alpha', 'qqbot:ext:toy'])
    expect(text(fake, 's1').endsWith(`${VOICE_RULE}\n\nA\n\nTOY`)).toBe(true)
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
    fake.qqbot.runtime('mood', 'r1')
    const voice = `voice: ${fake.qqbot.voice.promptStatus(undefined)}`
    expect(fake.contexts({ agent: { id: 's1' } })).toEqual([{ name: 'qqbot:runtime', text: `mood: r1\ntoy: connected\n${voice}` }])
    expect(fake.contexts({ agent: { id: 's2' } })[0]?.text).toBe(`mood: r1\n${voice}`)
    expect(fake.systemPrompt.contexts.get('qqbot:runtime')?.required).toBe(true)
  })

  it('updates voice capability per session without changing the system prefix or reading credentials', async () => {
    const fake = await setup()
    const { content, voice } = fake.qqbot
    const previousSettings = voice.settings
    const engine = voice.saveEngine({ name: '语音状态测试服务', kind: 'openai', config: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test' } })
    const selected = voice.saveVoice({ name: '语音状态测试音色', engine: engine.id, params: { reference: 'test' } })
    content.roles.save({ id: 'voice-test-role', name: '语音状态测试角色', description: '', persona: '测试。', voice: selected.id }, true)
    content.roles.save({ id: 'voice-no-selection', name: '未选音色测试角色', description: '', persona: '测试。' }, true)
    content.bindings.set('voice-s1', 'voice-test-role')
    content.bindings.set('voice-s2', 'voice-no-selection')
    content.bindings.set('voice-s3', NO_ROLE)
    const runtime = (id: string) => fake.contexts({ agent: { id } })[0]!.text
    try {
      voice.saveSettings({ ...DEFAULT_VOICE_SETTINGS, enabled: false })
      const prefix = text(fake, 'voice-s1')
      expect(prefix).toContain(VOICE_RULE)
      expect(runtime('voice-s1')).toContain('voice: 已关闭')
      voice.saveSettings({ ...DEFAULT_VOICE_SETTINGS, enabled: true })
      expect(runtime('voice-s1')).toContain('voice: 已启用')
      expect(runtime('voice-s2')).toContain('voice: 未配置：当前角色未选择音色')
      expect(runtime('voice-s3')).toContain('voice: 未配置：当前角色未选择音色')
      expect(runtime('voice-s1')).not.toContain(engine.config.baseUrl)
      expect(runtime('voice-s1')).not.toContain(selected.id)
      expect(text(fake, 'voice-s1')).toBe(prefix)
      voice.saveSettings({ ...voice.settings, mode: 'all' })
      expect(runtime('voice-s1')).toContain('voice: 已启用（全部转语音）')
      expect(text(fake, 'voice-s1')).toBe(prefix)
      // 换到无音色角色时，系统说明保持一致，只有运行时状态变化。
      content.bindings.set('voice-s1', 'voice-no-selection')
      expect(runtime('voice-s1')).toContain('voice: 未配置')
      expect(text(fake, 'voice-s1')).toBe(prefix)
      content.bindings.set('voice-s1', 'voice-test-role')
      voice.removeVoice(selected.id)
      expect(runtime('voice-s1')).toContain('voice: 未配置：当前角色的音色或语音服务已失效')
      expect(text(fake, 'voice-s1')).toBe(prefix)
    } finally {
      voice.saveSettings(previousSettings)
      await fake.disposePrompt()
    }
  })

  it('records the role of each entered step, not rejected ones', async () => {
    const fake = await setup()
    const { content } = fake.qqbot
    content.roles.save({ id: 'turn-a', name: 'A', description: '', persona: 'A。' }, true)
    content.bindings.set('turns-1', 'turn-a')
    const step = (turn: number, kind: 'enter' | 'reject') => (fake.root as unknown as {
      waterfall: (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    }).waterfall('agent/pre-step', { agent: { id: 'turns-1' }, turn, step: 1 }, () => Promise.resolve({ kind }))
    await expect(step(1, 'enter')).resolves.toEqual({ kind: 'enter' })
    content.bindings.set('turns-1', NO_ROLE)
    await step(2, 'reject')
    expect(content.bindings.turnsOf('turns-1')).toEqual([{ turn: 1, role: 'turn-a' }])
    await step(2, 'enter')
    expect(content.bindings.turnsOf('turns-1')).toEqual([{ turn: 1, role: 'turn-a' }, { turn: 2, role: null }])
    // 插件关闭后不再记录。
    content.bindings.set('turns-1', 'turn-a')
    await fake.disposePrompt()
    await step(3, 'enter')
    expect(content.bindings.turnsOf('turns-1')).toHaveLength(2)
  })

  it('disposing the prompt plugin removes its section and context', async () => {
    const fake = await setup()
    await fake.disposePrompt()
    expect(fake.systemPrompt.sections.size).toBe(0)
    expect(fake.systemPrompt.contexts.size).toBe(0)
  })
})
