import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { applyLibraryAction, libraryView } from '../src/library.ts'
import { consolidateMemory, consolidationInstruction, type ConsolidationInput } from '../src/memory-consolidate.ts'
import { MemoryCoordinator, MIN_NEW_TURNS, outcomeMessage, type LiveMemorySession } from '../src/memory-coordinator.ts'
import { MEMORY_LIMIT, MemoryFormatError, memoryRule, normalizeMemory } from '../src/memory-format.ts'
import { JailbreakStore } from '../src/presets.ts'
import { assembleParts } from '../src/prompt.ts'
import { QqbotRegistryStore } from '../src/registry.ts'
import { MemoryStore } from '../src/role-memory.ts'
import { RoleLibrary } from '../src/roles.ts'

const MEMORY = '## 称呼与身份\n- 叫他阿林\n\n## 偏好与禁忌\n- 不吃香菜'

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-qqbot-memory-'))
}

function data(dir = temp(), warnings: string[] = []) {
  const warn = (message: string) => { warnings.push(message) }
  mkdirSync(join(dir, 'roles', 'alice'), { recursive: true })
  writeFileSync(join(dir, 'roles', 'alice', 'ROLE.md'), '---\nid: alice\nname: 爱丽丝\n---\n爱丽丝的设定。\n')
  mkdirSync(join(dir, 'roles', 'bob'), { recursive: true })
  writeFileSync(join(dir, 'roles', 'bob', 'ROLE.md'), '---\nid: bob\nname: 小B\n---\nB 的设定。\n')
  return new QqbotData(
    new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn, MemoryStore.at(dir, warn),
  )
}

const memoryPart = (content: QqbotData, id: string) =>
  assembleParts(content, new QqbotRegistryStore(), { id }).find(part => part.name === 'qqbot:role-memory')?.text

describe('memory format', () => {
  it('normalizes to fixed section order and bullet style', () => {
    const messy = '# 偏好与禁忌\n* 不吃香菜\n\n## 关系\n刚认识，\n互相试探。\n## 称呼与身份\n1. 叫他阿林\n'
    expect(normalizeMemory(messy)).toBe('## 称呼与身份\n- 叫他阿林\n\n## 关系\n刚认识，互相试探。\n\n## 偏好与禁忌\n- 不吃香菜')
    // 同样的内容输出逐字节相同，快照才能共用缓存。
    expect(normalizeMemory(normalizeMemory(messy))).toBe(normalizeMemory(messy))
    expect(normalizeMemory('')).toBe('')
  })

  it('rejects unknown sections, overflowing quotas and text over the limit', () => {
    expect(() => normalizeMemory('## 杂项\n- x')).toThrow(MemoryFormatError)
    expect(() => normalizeMemory('前言\n## 关系\n朋友')).toThrow(MemoryFormatError)
    expect(() => normalizeMemory(`## 重要经历\n${Array.from({ length: 6 }, (_, i) => `- 事件${i}`).join('\n')}`)).toThrow('最多 5 条')
    expect(() => normalizeMemory(`## 关系\n${'很'.repeat(MEMORY_LIMIT)}`)).toThrow(`最多 ${MEMORY_LIMIT} 个字`)
  })

  it('is lenient with model output: code fences and preamble are dropped', () => {
    expect(normalizeMemory('好的，以下是记忆：\n```markdown\n## 关系\n朋友\n```', true)).toBe('## 关系\n朋友')
  })

  it('renders no section when there is no memory', () => {
    expect(memoryRule('')).toBe('')
    expect(memoryRule(MEMORY)).toContain(MEMORY)
  })
})

describe('memory store', () => {
  it('saves normalized text, bumps the revision only on change, and keeps role cards untouched', () => {
    const dir = temp()
    const content = data(dir)
    const card = readFileSync(join(dir, 'roles', 'alice', 'ROLE.md'), 'utf8')
    content.memories.save('alice', MEMORY)
    content.memories.save('alice', `${MEMORY}\n\n`)
    expect(content.memories.revision('alice')).toBe(1)
    expect(new MemoryStore(join(dir, 'memories'), () => {}).text('alice')).toBe(MEMORY)
    expect(readFileSync(join(dir, 'roles', 'alice', 'ROLE.md'), 'utf8')).toBe(card)
  })

  it('refuses a consolidation result when the memory changed meanwhile', () => {
    const store = new MemoryStore(undefined, () => {})
    const revision = store.revision('alice')
    store.save('alice', MEMORY)
    expect(store.commitConsolidation('alice', revision, 's1', 12, '## 关系\n朋友')).toBe(false)
    expect(store.text('alice')).toBe(MEMORY)
    expect(store.consolidatedTurn('alice', 's1')).toBeUndefined()
  })

  it('advances progress without changing text when the result was rejected', () => {
    const store = new MemoryStore(undefined, () => {})
    store.save('alice', MEMORY)
    expect(store.commitConsolidation('alice', 1, 's1', 12, undefined)).toBe(true)
    expect(store.text('alice')).toBe(MEMORY)
    expect(store.revision('alice')).toBe(1)
    expect(store.consolidatedTurn('alice', 's1')).toBe(12)
  })

  it('treats a hand-broken file as no memory and warns', () => {
    const dir = temp()
    mkdirSync(join(dir, 'memories'), { recursive: true })
    writeFileSync(join(dir, 'memories', 'alice.json'), JSON.stringify({ version: 1, text: '## 杂项\n- x', revision: 3, sessions: {} }))
    const warnings: string[] = []
    const store = MemoryStore.at(dir, m => { warnings.push(m) })
    expect(store.text('alice')).toBe('')
    expect(store.revision('alice')).toBe(3)
    expect(warnings).toHaveLength(1)
  })

  it('uses a hashed file name for ids with path characters', () => {
    const dir = temp()
    const store = MemoryStore.at(dir, () => {})
    store.save('../evil', MEMORY)
    expect(readdirSync(join(dir, 'memories'))).toEqual([expect.stringMatching(/^x-[0-9a-f]{16}\.json$/)])
    expect(store.text('../evil')).toBe(MEMORY)
  })
})

describe('session snapshot', () => {
  it('takes the snapshot on first assembly and keeps it for the whole session', () => {
    const dir = temp()
    const content = data(dir)
    content.bindings.setDefaultRole('alice')
    content.memories.save('alice', MEMORY)
    content.settle({ id: 's1' })
    const first = memoryPart(content, 's1')
    expect(first).toContain('叫他阿林')

    // 会话中途记忆更新：本会话不变，新会话用新版本。
    content.memories.save('alice', '## 关系\n已经是好朋友')
    content.settle({ id: 's1' })
    expect(memoryPart(content, 's1')).toBe(first)
    content.settle({ id: 's2' })
    expect(memoryPart(content, 's2')).toContain('已经是好朋友')

    // 重新打开旧会话（重启后重新读文件）逐字节相同。
    const reopened = data(dir)
    reopened.settle({ id: 's1' })
    expect(memoryPart(reopened, 's1')).toBe(first)
  })

  it('records an empty snapshot so memory written later stays out of the session', () => {
    const content = data()
    content.bindings.setDefaultRole('alice')
    content.settle({ id: 's1' })
    content.memories.save('alice', MEMORY)
    expect(memoryPart(content, 's1')).toBeUndefined()
  })

  it('takes a separate snapshot for each role the session switches to', () => {
    const content = data()
    content.bindings.setDefaultRole('alice')
    content.memories.save('alice', MEMORY)
    content.memories.save('bob', '## 关系\n同事')
    content.settle({ id: 's1' })
    content.bindings.set('s1', 'bob')
    content.settle({ id: 's1' })
    expect(memoryPart(content, 's1')).toContain('同事')
    content.memories.save('alice', '## 关系\n变了')
    content.bindings.set('s1', 'alice')
    content.settle({ id: 's1' })
    expect(memoryPart(content, 's1')).toContain('叫他阿林')
  })

  it('reports a stale snapshot and applies the new memory to one session (compaction path)', () => {
    const dir = temp()
    const content = data(dir)
    content.bindings.setDefaultRole('alice')
    expect(content.memoryState('s1')).toBeUndefined()
    content.memories.save('alice', MEMORY)
    content.settle({ id: 's1' })
    content.settle({ id: 's2' })
    expect(content.memoryState('s1')).toEqual({ role: 'alice', stale: false })

    // 自动整理只写记忆文件，会话快照不动，直到压缩时应用。
    content.memories.save('alice', '## 关系\n已经是好朋友')
    expect(content.memoryState('s1')).toEqual({ role: 'alice', stale: true })
    content.applyMemory('s1', 'alice')
    expect(content.memoryState('s1')).toEqual({ role: 'alice', stale: false })
    expect(memoryPart(content, 's1')).toContain('已经是好朋友')
    // 其他会话不受影响；重启后仍是应用后的版本。
    expect(memoryPart(content, 's2')).toContain('叫他阿林')
    expect(memoryPart(data(dir), 's1')).toContain('已经是好朋友')

    // 会话已换成别的角色时不动别的角色的快照。
    content.memories.save('alice', '## 关系\n又变了')
    content.bindings.set('s1', 'bob')
    content.applyMemory('s1', 'alice')
    content.bindings.set('s1', 'alice')
    expect(memoryPart(content, 's1')).toContain('已经是好朋友')
  })

  it('applies a manual memory edit to every session of that role', () => {
    const content = data()
    content.bindings.setDefaultRole('alice')
    content.settle({ id: 's1' })
    content.settle({ id: 's2' })
    content.bindings.set('s3', 'bob')
    content.settle({ id: 's3' })
    content.memories.save('bob', '## 关系\n同事')
    applyLibraryAction(content, { action: 'role.memory.save', id: 'alice', memory: MEMORY })
    expect(memoryPart(content, 's1')).toContain('叫他阿林')
    expect(memoryPart(content, 's2')).toContain('叫他阿林')
    // 别的角色的会话不受影响。
    expect(memoryPart(content, 's3')).toBeUndefined()
    // 角色卡保存里带的记忆也一样。
    const alice = libraryView(content).roles.find(role => role.id === 'alice')!
    applyLibraryAction(content, { action: 'role.save', create: false, role: { ...alice, memory: '## 关系\n恋人' } })
    expect(memoryPart(content, 's1')).toContain('恋人')
  })

  it('places the memory between the extension slot and the jailbreak tail', () => {
    const content = data()
    content.bindings.setDefaultRole('alice')
    content.memories.save('alice', MEMORY)
    content.presets.save({ name: '带结尾', head: '', mid: '', tail: '结尾' }, true)
    const preset = content.presets.list().find(p => p.name === '带结尾')!
    content.presets.assign('alice', preset.id)
    content.settle({ id: 's1' })
    const names = assembleParts(content, new QqbotRegistryStore(), { id: 's1' }).map(part => part.name)
    expect(names.indexOf('qqbot:role-memory')).toBe(names.indexOf('qqbot:jb-tail') - 1)
  })
})

/** 记下请求，依次回给定的文字。 */
function fakeLlm(...replies: string[]) {
  const calls: GenerateOptions[] = []
  return {
    calls,
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const text = replies[Math.min(calls.length - 1, replies.length - 1)]!
      yield * [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text } },
        { type: 'finish', reason: { kind: 'stop' } },
      ] as StreamChunk[]
    },
  }
}

const HISTORY = [
  { role: 'system', content: [{ type: 'text', text: '系统提示词' }] },
  { role: 'user', content: [{ type: 'text', text: '我叫阿林' }] },
] as never

const INPUT: ConsolidationInput = { provider: 'deepseek', model: 'flash', messages: HISTORY, toolHistory: undefined, sessionId: 's1' as never }

describe('consolidation request', () => {
  it('replays the session history unchanged and appends the instruction with the old memory', async () => {
    const llm = fakeLlm('## 称呼与身份\n- 叫他阿林')
    const result = await consolidateMemory(llm, INPUT, '爱丽丝', MEMORY)
    const [call] = llm.calls
    expect(call?.messages.slice(0, 2)).toEqual(HISTORY)
    expect(call?.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: consolidationInstruction('爱丽丝', MEMORY) }] })
    expect(call).toMatchObject({ provider: 'deepseek', model: 'flash', sessionId: 's1' })
    expect(call?.purpose).toBeUndefined()
    expect(result.text).toBe('## 称呼与身份\n- 叫他阿林')
  })

  it('asks for one rewrite on the same prefix, then gives up', async () => {
    const tooLong = `## 关系\n${'很'.repeat(MEMORY_LIMIT + 1)}`
    const llm = fakeLlm(tooLong, '## 关系\n朋友')
    expect((await consolidateMemory(llm, INPUT, '爱丽丝', '')).text).toBe('## 关系\n朋友')
    expect(llm.calls[1]?.messages.slice(0, 3)).toEqual(llm.calls[0]?.messages)

    const stubborn = fakeLlm(tooLong)
    const result = await consolidateMemory(stubborn, INPUT, '爱丽丝', '')
    expect(stubborn.calls).toHaveLength(2)
    expect(result).toMatchObject({ text: undefined, problem: expect.stringContaining('最多') })
  })
})

function liveSession(id: string, turn: { value: number }, reply: () => Promise<string | undefined>, active = 0) {
  let captures = 0
  const session: LiveMemorySession & { captures: () => number } = {
    id,
    latestTurn: () => turn.value,
    lastActive: () => active,
    capture: () => { captures++; return INPUT },
    run: async () => ({ text: await reply() }),
    captures: () => captures,
  }
  return session
}

describe('memory coordinator', () => {
  it('waits for enough new turns, then consolidates and records progress', async () => {
    const content = data()
    content.bindings.setDefaultRole('alice')
    content.settle({ id: 's1' })
    const turn = { value: MIN_NEW_TURNS - 1 }
    const coordinator = new MemoryCoordinator(content, () => {})
    coordinator.register(liveSession('s1', turn, async () => MEMORY))
    expect(await coordinator.consolidate('s1')).toEqual({ kind: 'skipped', reason: 'too-few' })
    turn.value = MIN_NEW_TURNS
    expect(await coordinator.consolidate('s1')).toEqual({ kind: 'done', changed: true })
    expect(content.memories.text('alice')).toBe(MEMORY)
    expect(content.memories.consolidatedTurn('alice', 's1')).toBe(MIN_NEW_TURNS)
    // 刚整理过，自动触发不再整理；手动也要至少一轮新内容。
    expect(await coordinator.consolidate('s1')).toMatchObject({ kind: 'skipped', reason: 'too-few' })
    expect(await coordinator.consolidate('s1', true)).toMatchObject({ kind: 'skipped', reason: 'too-few' })
  })

  it('counts only the current role segment after a switch', () => {
    const content = data()
    content.bindings.set('s1', 'alice')
    content.bindings.recordTurn('s1', 1, 'alice')
    content.bindings.recordTurn('s1', 30, 'bob')
    const coordinator = new MemoryCoordinator(content, () => {})
    expect(coordinator.pendingTurns('s1', 'bob', 34)).toBe(5)
    expect(coordinator.pendingTurns('s1', 'alice', 34)).toBe(34)
  })

  it('does not run the same session twice at once and queues per role', async () => {
    const content = data()
    content.bindings.set('s1', 'alice')
    content.bindings.set('s2', 'alice')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const coordinator = new MemoryCoordinator(content, () => {})
    coordinator.register(liveSession('s1', { value: 20 }, async () => { await gate; return '## 关系\n第一次' }))
    coordinator.register(liveSession('s2', { value: 20 }, async () => '## 关系\n第二次'))
    const a = coordinator.consolidate('s1')
    expect(await coordinator.consolidate('s1')).toEqual({ kind: 'skipped', reason: 'busy' })
    const b = coordinator.consolidate('s2')
    release()
    expect(await a).toMatchObject({ kind: 'done' })
    // 第二个排在后面，轮到时才读版本号，所以第一次写入后它仍能写入。
    expect(await b).toMatchObject({ kind: 'done' })
    expect(content.memories.text('alice')).toBe('## 关系\n第二次')
  })

  it('discards the result when the user edits the memory during consolidation', async () => {
    const content = data()
    content.bindings.set('s1', 'alice')
    const coordinator = new MemoryCoordinator(content, () => {})
    coordinator.register(liveSession('s1', { value: 20 }, async () => {
      content.memories.save('alice', MEMORY)
      return '## 关系\n模型写的'
    }))
    expect(await coordinator.consolidate('s1')).toEqual({ kind: 'stale' })
    expect(content.memories.text('alice')).toBe(MEMORY)
  })

  it('keeps the old memory and progress on request failure', async () => {
    const content = data()
    content.bindings.set('s1', 'alice')
    content.memories.save('alice', MEMORY)
    const coordinator = new MemoryCoordinator(content, () => {})
    coordinator.register(liveSession('s1', { value: 20 }, async () => { throw new Error('网络断了') }))
    const outcome = await coordinator.consolidate('s1')
    expect(outcome).toEqual({ kind: 'failed', error: '网络断了' })
    expect(outcomeMessage(outcome)).toContain('网络断了')
    expect(content.memories.text('alice')).toBe(MEMORY)
    expect(content.memories.consolidatedTurn('alice', 's1')).toBeUndefined()
  })

  it('manual consolidation picks the most recently active session of the role', async () => {
    const content = data()
    content.bindings.set('old', 'alice')
    content.bindings.set('new', 'alice')
    content.bindings.set('other', 'bob')
    const coordinator = new MemoryCoordinator(content, () => {})
    const older = liveSession('old', { value: 3 }, async () => '## 关系\n旧', 1)
    coordinator.register(older)
    coordinator.register(liveSession('new', { value: 3 }, async () => '## 关系\n新', 2))
    coordinator.register(liveSession('other', { value: 3 }, async () => '## 关系\nB', 3))
    expect(await coordinator.consolidateRole('alice')).toMatchObject({ kind: 'done' })
    expect(content.memories.text('alice')).toBe('## 关系\n新')
    expect(older.captures()).toBe(0)
    await expect(new MemoryCoordinator(content, () => {}).consolidateRole('alice')).rejects.toThrow('没有正在用这个角色的会话')
  })

  it('new session triggers background consolidation of other open sessions with the same role', async () => {
    const content = data()
    content.bindings.set('old', 'alice')
    content.bindings.set('bobs', 'bob')
    const coordinator = new MemoryCoordinator(content, () => {})
    const old = liveSession('old', { value: 15 }, async () => MEMORY)
    const bobs = liveSession('bobs', { value: 15 }, async () => '## 关系\nB')
    coordinator.register(old)
    coordinator.register(bobs)
    coordinator.consolidateOthers('fresh', 'alice')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(old.captures()).toBe(1)
    expect(bobs.captures()).toBe(0)
  })
})

describe('library memory actions', () => {
  it('shows and saves memory with the role, rejecting bad memory before writing the role', () => {
    const content = data()
    const alice = libraryView(content).roles.find(r => r.id === 'alice')!
    expect(alice.memory).toBe('')
    applyLibraryAction(content, { action: 'role.save', create: false, role: { ...alice, memory: MEMORY } })
    expect(libraryView(content).roles.find(r => r.id === 'alice')?.memory).toBe(MEMORY)
    expect(() => applyLibraryAction(content, { action: 'role.save', create: false, role: { ...alice, name: '改名', memory: '## 杂项\n- x' } }))
      .toThrow(MemoryFormatError)
    expect(content.roles.get('alice')?.name).toBe('爱丽丝')
    // 不带 memory（旧调用）时不改记忆。
    const { memory: _, ...withoutMemory } = alice
    applyLibraryAction(content, { action: 'role.save', create: false, role: withoutMemory })
    expect(content.memories.text('alice')).toBe(MEMORY)
  })

  it('moves memory to the trash with the role', () => {
    const dir = temp()
    const content = data(dir)
    content.memories.save('alice', MEMORY)
    applyLibraryAction(content, { action: 'role.remove', id: 'alice' })
    expect(existsSync(join(dir, 'memories', 'alice.json'))).toBe(false)
    expect(readdirSync(join(dir, 'roles-trash')).some(name => name.endsWith('-alice.memory.json'))).toBe(true)
  })
})
