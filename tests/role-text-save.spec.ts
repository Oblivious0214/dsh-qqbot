import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { applyLibraryAction, libraryView } from '../src/library.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'

const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-text-save-')); dirs.push(dir)
  const warn = () => {}
  const data = new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn)
  const role = { id: 'alice', name: '爱丽丝', description: '室友', persona: '保留角色正文。', memePrompt: '原表情要求',
    memeFrequency: 'high', memeTags: ['开心'], proactivity: 'situational', proactivityTexts: { follow: '低档说明', high: '' }, motionActions: ['稳定节奏'] }
  applyLibraryAction(data, { action: 'role.save', create: true, role })
  data.memories.save('alice', '## 称呼与身份\n叫小鱼。')
  const file = join(dir, 'roles', 'alice', 'ROLE.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('id: alice', 'id: alice\ncustom: 保留自定义字段'))
  return { data, file }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('independent role text saves', () => {
  it('saves and clears only the meme prompt, preserving the latest role, memory and template', () => {
    const { data, file } = fixture()
    const before = libraryView(data)
    // 模拟另一处先保存了角色，独立文本保存必须合并当前资料。
    data.roles.save({ ...data.roles.get('alice')!, name: '最新名称' }, false)
    expect(applyLibraryAction(data, { action: 'role.meme-prompt.save', id: 'alice', prompt: '新要求' })).toBe('alice')
    const { memory: _, ...roleBefore } = before.roles[0]!
    expect(data.roles.get('alice')).toEqual({ ...roleBefore, name: '最新名称', memePrompt: '新要求' })
    expect(readFileSync(file, 'utf8')).toContain('custom: 保留自定义字段')
    applyLibraryAction(data, { action: 'role.meme-prompt.save', id: 'alice', prompt: '' })
    expect(data.roles.get('alice')).not.toHaveProperty('memePrompt')
    expect(data.memories.text('alice')).toBe(before.roles[0]!.memory)
    expect(data.presets.currentId).toBe(before.currentPreset)
  })

  it('saves or resets one autonomy level without changing the actual level or other texts', () => {
    const { data } = fixture()
    const before = data.roles.get('alice')!
    applyLibraryAction(data, { action: 'role.proactivity-text.save', id: 'alice', level: 'situational', text: '中档说明' })
    expect(data.roles.get('alice')).toEqual({ ...before, proactivityTexts: { ...before.proactivityTexts, situational: '中档说明' } })
    applyLibraryAction(data, { action: 'role.proactivity-text.save', id: 'alice', level: 'follow' })
    expect(data.roles.get('alice')!.proactivityTexts).toEqual({ situational: '中档说明', high: '' })
    applyLibraryAction(data, { action: 'role.proactivity-text.save', id: 'alice', level: 'situational', text: '' })
    expect(data.roles.get('alice')!.proactivityTexts).toEqual({ situational: '', high: '' })
  })

  it('saves memory without rewriting the role file', () => {
    const { data, file } = fixture()
    const before = readFileSync(file)
    applyLibraryAction(data, { action: 'role.memory.save', id: 'alice', memory: '## 关系\n老朋友。' })
    expect(data.memories.text('alice')).toContain('老朋友。')
    expect(readFileSync(file)).toEqual(before)
    applyLibraryAction(data, { action: 'role.memory.save', id: 'alice', memory: '' })
    expect(data.memories.text('alice')).toBe('')
  })

  it('rejects malformed, oversized and missing-role saves before changing data', () => {
    const { data, file } = fixture()
    const before = readFileSync(file), memory = data.memories.text('alice')
    for (const action of [
      { action: 'role.meme-prompt.save', id: 'alice', prompt: 1 },
      { action: 'role.meme-prompt.save', id: 'alice', prompt: 'x'.repeat(4001) },
      { action: 'role.proactivity-text.save', id: 'alice', level: 'wild', text: 'x' },
      { action: 'role.proactivity-text.save', id: 'alice', level: 'high', text: null },
      { action: 'role.proactivity-text.save', id: 'alice', level: 'high', text: 'x'.repeat(2001) },
      { action: 'role.memory.save', id: 'alice', memory: 1 },
      { action: 'role.memory.save', id: 'alice', memory: 'x'.repeat(2000) },
      { action: 'role.meme-prompt.save', id: 'missing', prompt: 'x' },
      { action: 'role.memory.save', id: 'missing', memory: 'x' },
    ]) expect(() => applyLibraryAction(data, action)).toThrow()
    expect(readFileSync(file)).toEqual(before)
    expect(data.memories.text('alice')).toBe(memory)
  })
})
