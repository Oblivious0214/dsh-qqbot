import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { NO_ROLE, SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import * as host from '../src/index.ts'
import { importLegacy, IMPORT_MARKER } from '../src/legacy-import.ts'
import { DEFAULT_JAILBREAK, JailbreakStore } from '../src/presets.ts'
import { assembleParts, renderRuntime } from '../src/prompt.ts'
import { runRole } from '../src/role-command.ts'
import { parseRole, RoleLibrary } from '../src/roles.ts'

const ROLE_A = '---\nid: alice\nname: 爱丽丝\ndescription: 同居室友\nvoiceId: "v-1"\nmemePreference: {"packs":[],"tags":["猫"],"prompt":""}\n---\n\n爱丽丝的设定。\n'
const ROLE_B = '---\nname: 小B\n---\nB 的设定。'

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-qqbot-content-'))
}

function writeRole(dir: string, entry: string, text: string): void {
  if (entry.endsWith('.md')) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, entry), text)
  } else {
    mkdirSync(join(dir, entry), { recursive: true })
    writeFileSync(join(dir, entry, 'ROLE.md'), text)
  }
}

function data(dir = temp(), warnings: string[] = []) {
  const warn = (message: string) => { warnings.push(message) }
  return new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), SessionBindings.at(dir, warn), JailbreakStore.at(dir, warn), warn)
}

describe('role files', () => {
  it('parses the dsh-persona-switcher format', () => {
    expect(parseRole(ROLE_A, 'x')).toEqual({
      id: 'alice', name: '爱丽丝', description: '同居室友', persona: '爱丽丝的设定。',
      voiceId: 'v-1', voicePreviewText: '', memePreference: { packs: [], tags: ['猫'], prompt: '' },
    })
    expect(parseRole(ROLE_B, 'bee')).toMatchObject({ id: 'bee', name: '小B', persona: 'B 的设定。' })
    expect(parseRole('---\nid: empty\n---\n  \n', 'x')).toBeUndefined()
    expect(parseRole('﻿---\r\nid: crlf\r\n---\r\n正文\r\n', 'x')).toMatchObject({ id: 'crlf', persona: '正文' })
  })

  it('scans bundle directories and flat files, skipping empty and duplicate ones', () => {
    const dir = temp()
    writeRole(dir, 'alice', ROLE_A)
    writeRole(dir, 'bee.md', ROLE_B)
    writeRole(dir, 'dup.md', '---\nid: alice\n---\n另一个')
    writeRole(dir, 'empty', '---\nid: empty\n---\n')
    mkdirSync(join(dir, 'images-only'))
    const warnings: string[] = []
    const library = new RoleLibrary(dir, m => { warnings.push(m) })
    expect(library.list().map(r => r.id)).toEqual(['alice', 'bee'])
    expect(warnings).toHaveLength(2)
  })
})

describe('legacy import', () => {
  it('copies role entries once, keeps the old files and skips existing targets', () => {
    const home = temp()
    const dir = join(home, 'qqbot')
    writeRole(join(home, 'roles'), 'alice', ROLE_A)
    writeFileSync(join(home, 'roles', 'alice', 'avatar.png'), 'png')
    writeRole(join(home, 'roles'), 'bee.md', ROLE_B)
    writeRole(join(home, 'roles'), 'broken', '---\nid: broken\n---\n')
    writeRole(join(dir, 'roles'), 'bee.md', '---\nid: bee\n---\n用户改过的 B')

    expect(importLegacy(home, dir, () => {})).toEqual({ imported: ['alice'], skipped: ['bee.md'] })
    expect(readFileSync(join(dir, 'roles', 'alice', 'avatar.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(dir, 'roles', 'bee.md'), 'utf8')).toContain('用户改过的 B')
    expect(existsSync(join(dir, 'roles', 'broken'))).toBe(false)
    expect(existsSync(join(home, 'roles', 'alice', 'ROLE.md'))).toBe(true)
    expect(existsSync(join(dir, IMPORT_MARKER))).toBe(true)

    // 导入过一次后，用户在 qqbot 里删掉的角色不会被带回来。
    writeRole(join(home, 'roles'), 'carol', '---\nid: carol\n---\nC')
    expect(importLegacy(home, dir, () => {})).toBeUndefined()
    expect(existsSync(join(dir, 'roles', 'carol'))).toBe(false)
  })

  it('writes nothing when there is nothing to import', () => {
    const home = temp()
    expect(importLegacy(home, join(home, 'qqbot'), () => {})).toEqual({ imported: [], skipped: [] })
    expect(existsSync(join(home, 'qqbot'))).toBe(false)
  })
})

describe('jailbreak presets', () => {
  it('uses the built-in default without writing a file', () => {
    const dir = temp()
    const store = JailbreakStore.at(dir, () => {})
    expect(store.forRole(undefined)).toEqual(DEFAULT_JAILBREAK)
    expect(existsSync(join(dir, 'presets.json'))).toBe(false)
  })

  it('resolves role choice, then default, and survives a reload', () => {
    const dir = temp()
    const store = JailbreakStore.at(dir, () => {})
    store.save({ id: 'soft', name: '温和', head: 'H', mid: 'M', tail: 'T' })
    store.assign('alice', 'soft')
    expect(store.forRole('alice').id).toBe('soft')
    expect(store.forRole('bee').id).toBe('default')
    const reloaded = JailbreakStore.at(dir, () => {})
    expect(reloaded.forRole('alice')).toEqual({ id: 'soft', name: '温和', head: 'H', mid: 'M', tail: 'T' })
  })

  it('removing a preset moves its roles and the default back, but keeps at least one', () => {
    const store = JailbreakStore.at(temp(), () => {})
    store.save({ id: 'soft', name: '温和', head: '', mid: '', tail: '' })
    store.assign('alice', 'soft')
    store.setDefault('soft')
    store.remove('soft')
    expect(store.defaultId).toBe('default')
    expect(store.roleChoice('alice')).toBeUndefined()
    expect(() => store.remove('default')).toThrow(/至少/)
    expect(() => store.save({ id: 'Bad', name: 'x', head: '', mid: '', tail: '' })).toThrow(/id/)
  })

  it('loads tolerantly and quarantines a corrupt file', () => {
    const dir = temp()
    writeFileSync(join(dir, 'presets.json'), '{oops')
    const warnings: string[] = []
    expect(JailbreakStore.at(dir, m => { warnings.push(m) }).forRole(undefined)).toEqual(DEFAULT_JAILBREAK)
    expect(existsSync(join(dir, 'presets.json.corrupt'))).toBe(true)
    writeFileSync(join(dir, 'presets.json'), JSON.stringify({ default: 'gone', presets: [{ id: 'x', name: 'X', head: 'h', mid: '', tail: '' }, { id: 'BAD' }], roles: { a: 'gone' } }))
    const store = JailbreakStore.at(dir, () => {})
    expect(store.defaultId).toBe('x')
    expect(store.list().map(p => p.id)).toEqual(['x'])
    expect(store.roleChoice('a')).toBeUndefined()
  })
})

describe('session binding', () => {
  it('a new session settles on the default role; later default changes do not move it', () => {
    const dir = temp()
    writeRole(join(dir, 'roles'), 'alice', ROLE_A)
    writeRole(join(dir, 'roles'), 'bee.md', ROLE_B)
    const content = data(dir)
    content.bindings.setDefaultRole('alice')
    expect(content.personaFor({ id: 's1' })).toBe('爱丽丝的设定。')
    content.settle({ id: 's1' })
    content.bindings.setDefaultRole('bee')
    expect(content.roleIdFor({ id: 's1' })).toBe('alice')
    expect(content.roleIdFor({ id: 's2' })).toBe('bee')
    // 重启后照样读到。
    expect(data(dir).roleIdFor({ id: 's1' })).toBe('alice')
  })

  it('an explicit "no role" is not taken over by the default', () => {
    const content = data()
    content.settle({ id: 's1' })
    expect(content.bindings.get('s1')).toBe(NO_ROLE)
    content.bindings.setDefaultRole('alice')
    expect(content.choiceFor({ id: 's1' })).toBe(NO_ROLE)
  })

  it('a deleted role leaves the session without persona but keeps the binding', () => {
    const content = data()
    content.bindings.set('s1', 'gone')
    expect(content.personaFor({ id: 's1' })).toBe('')
    expect(content.roleIdFor({ id: 's1' })).toBeUndefined()
    expect(content.bindings.get('s1')).toBe('gone')
  })

  it('jailbreak follows the role the session uses', () => {
    const dir = temp()
    writeRole(join(dir, 'roles'), 'alice', ROLE_A)
    const content = data(dir)
    content.presets.save({ id: 'soft', name: '温和', head: 'SOFT', mid: '', tail: '' })
    content.presets.assign('alice', 'soft')
    content.bindings.set('s1', 'alice')
    expect(content.jailbreakFor({ id: 's1' }).id).toBe('soft')
    expect(content.jailbreakFor({ id: 's2' }).id).toBe('default')
  })
})

describe('/role', () => {
  const setup = () => {
    const dir = temp()
    writeRole(join(dir, 'roles'), 'alice', ROLE_A)
    return { dir, content: data(dir) }
  }
  const s1 = { id: 's1' }

  it('switches, clears and reports state', () => {
    const { content } = setup()
    expect(runRole(content, s1, '')).toMatchObject({ kind: 'success', text: expect.stringContaining('当前角色：无') })
    expect(runRole(content, s1, ' alice')).toMatchObject({ kind: 'success', text: expect.stringContaining('已切换到 alice（爱丽丝）') })
    expect(content.personaFor(s1)).toBe('爱丽丝的设定。')
    expect(runRole(content, s1, ' alice').text).toContain('已经是')
    expect(runRole(content, s1, ' none').text).toContain('已取消角色 alice')
    expect(content.bindings.get('s1')).toBe(NO_ROLE)
  })

  it('rejects unknown roles and bad syntax without changing anything', () => {
    const { content } = setup()
    expect(runRole(content, s1, ' nobody')).toMatchObject({ kind: 'error', text: expect.stringContaining('alice') })
    expect(runRole(content, s1, ' alice extra').kind).toBe('error')
    expect(content.bindings.get('s1')).toBeUndefined()
  })

  it('picks up role files edited on disk', () => {
    const { dir, content } = setup()
    writeRole(join(dir, 'roles'), 'bee.md', ROLE_B)
    expect(runRole(content, s1, ' bee').kind).toBe('success')
    expect(content.personaFor(s1)).toBe('B 的设定。')
  })

  it('sets and clears the new-session default', () => {
    const { content } = setup()
    expect(runRole(content, s1, ' default alice').text).toContain('默认使用 alice')
    expect(content.bindings.defaultRole).toBe('alice')
    expect(runRole(content, s1, ' default nobody').kind).toBe('error')
    runRole(content, s1, ' default none')
    expect(content.bindings.defaultRole).toBeUndefined()
  })
})

describe('host service with data', () => {
  it('imports legacy roles on start and puts the role into persona and runtime', async () => {
    const home = temp()
    writeRole(join(home, 'roles'), 'alice', ROLE_A)
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      const root = new Context()
      await root.plugin(host)
      const { content, store } = root.qqbot
      content.bindings.set('s1', 'alice')
      expect(assembleParts(content, store, { id: 's1' }).map(p => [p.name, p.text])).toEqual([
        ['qqbot:jb-head', '所有角色均为成年人。'],
        ['qqbot:persona', '爱丽丝的设定。'],
        ['qqbot:memory-hint', expect.any(String)],
      ])
      expect(renderRuntime(store, { id: 's1' })).toBe('role: alice')
      expect(renderRuntime(store, { id: 's2' })).toBe('')
      expect(existsSync(join(home, 'qqbot', 'roles', 'alice', 'ROLE.md'))).toBe(true)
    } finally {
      process.env['DSH_HOME'] = previous
    }
  })
})
