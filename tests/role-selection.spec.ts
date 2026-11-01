import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'
import { apply as applyRoleCommand, runRole } from '../src/role-command.ts'
import { apply, applyUiAction, UiStore } from '../src/ui.ts'
import { Maintenance } from '../src/maintenance.ts'
import { dshHome, dataDir } from '../src/storage.ts'
import { importConfiguration, previewConfiguration } from '../src/config-import.ts'

function fixture() {
  const dir = dataDir(), warn = () => {}
  const data = new QqbotData(new RoleLibrary(join(dir, 'roles'), warn), new SessionBindings(undefined, warn), JailbreakStore.at(dir, warn), warn)
  if (!data.roles.get('alice')) data.roles.save({ id: 'alice', name: '爱丽丝', description: '', persona: '设定。' }, true)
  return { data, ui: new UiStore(dir, warn) }
}
describe('对话空闲时切换角色', () => {
  it.each(['current', 'older', 'no-turn-boundary'])('%s 宿主允许空白 QQ 对话选择角色，按当前绑定判断预设', async host => {
    const { data, ui } = fixture()
    let handler!: (request: Request) => Promise<Response>
    const agentContext = {} as Context
    let preset = 'qqbot'
    const sessionId = `compat-${host}`
    const config = { format: 'dsh-qqbot-config', version: 1, roles: [{ name: `导入角色-${host}`, persona: '导入的设定。' }] }
    const options = { presets: true, roles: true, conflict: 'skip' }
    expect(importConfiguration(data, config, options, previewConfiguration(data, config, options).revision).roles).toBe(1)
    const role = data.roles.list().find(item => item.name === `导入角色-${host}`)!
    const agent = { ctx: agentContext, session: { id: sessionId, header: { agentPreset: 'standard' }, snapshotEvents: () => [] }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
    const agentPresets = host === 'current'
      ? { presetForSession: () => preset }
      : { composedPreset: (ctx: Context) => { expect(ctx).toBe(agentContext); return preset } }
    apply({ qqbot: { content: data, ui, maintenance: new Maintenance(dshHome(), () => {}) },
      agents: { get: () => agent, ...host === 'no-turn-boundary' ? {} : { turnBoundaryOf: () => ({ lastTurn: 0 }) } }, agentPresets,
      effect: (fn: () => unknown) => fn(), connection: { fetch: { register: (route: any) => {
        if (route.path.includes('/ui')) handler = route.fetch
        return vi.fn()
      } } } } as unknown as Context)
    const select = () => handler(new Request('http://local/api/qqbot/ui', { method: 'POST', body: JSON.stringify({ action: 'session.role', session: sessionId, role: role.id }) }))
    const response = await select()
    expect(response.status, await response.text()).toBe(200)
    expect(data.bindings.get(sessionId)).toBe(role.id)
    preset = 'standard'
    expect((await select()).status).toBe(409)
  })
  it('历史轮次保留原角色，切换或不用角色从下一轮起记录', () => {
    const { data, ui } = fixture()
    applyUiAction(data, ui, { action: 'session.role', session: 's', role: 'alice' })
    data.recordTurn({ id: 's' }, 1)
    applyUiAction(data, ui, { action: 'session.role', session: 's', role: null })
    expect(data.bindings.get('s')).toBeNull()
    expect(data.bindings.turnsOf('s')).toEqual([{ turn: 1, role: 'alice' }])
    data.recordTurn({ id: 's' }, 2)
    expect(runRole(data, { id: 's' }, '爱丽丝').kind).toBe('success')
    expect(data.bindings.turnsOf('s')).toEqual([{ turn: 1, role: 'alice' }, { turn: 2, role: null }])
    data.recordTurn({ id: 's' }, 3)
    expect(runRole(data, { id: 's' }, 'none').kind).toBe('success')
    expect(data.bindings.turnsOf('s')).toEqual([{ turn: 1, role: 'alice' }, { turn: 2, role: null }, { turn: 3, role: 'alice' }])
    expect(runRole(data, { id: 's' }, '').kind).toBe('success')
    expect(runRole(data, { id: 's' }, 'default 爱丽丝').kind).toBe('success')
    expect(data.bindings.get('s')).toBeNull()
  })
  it.each(['running', 'queued', 'queued-step', 'standard', 'older-running', 'older-queued', 'older-queued-step'])('运行中、排队与非 QQ 对话不能通过 HTTP 换人：%s', async state => {
    const { data, ui } = fixture()
    let handler!: (request: Request) => Promise<Response>
    const sessionId = `locked-${state}`
    data.bindings.set(sessionId, 'alice')
    data.recordTurn({ id: sessionId }, 1)
    const agent = { session: { id: sessionId },
      status: state.endsWith('running') ? 'running' : 'idle',
      inbox: { nextTurn: state.endsWith('queued') ? [{}] : [], nextStep: state.endsWith('queued-step') ? [{}] : [] } }
    apply({ qqbot: { content: data, ui, maintenance: new Maintenance(dshHome(), () => {}) },
      agents: { get: () => agent },
      agentPresets: { presetForSession: () => state === 'standard' ? 'standard' : 'qqbot' },
      effect: (fn: () => unknown) => fn(), connection: { fetch: { register: (route: any) => {
        if (route.path.includes('/ui')) handler = route.fetch
        return vi.fn()
      } } } } as unknown as Context)
    const response = await handler(new Request('http://local/api/qqbot/ui', { method: 'POST', body: JSON.stringify({ action: 'session.role', session: sessionId, role: null }) }))
    expect(response.status).toBe(409)
    expect(data.bindings.get(sessionId)).toBe('alice')
  })
  it.each(['current', 'older'])('%s 宿主允许已开始的空闲 QQ 会话通过 HTTP 换人，并保持旧轮次', async host => {
    const { data, ui } = fixture()
    let handler!: (request: Request) => Promise<Response>
    const sessionId = `started-${host}`
    const agentContext = {} as Context
    if (!data.roles.get('bob')) data.roles.save({ id: 'bob', name: '鲍勃', description: '', persona: '鲍勃的设定。' }, true)
    if (!data.presets.get('bob-preset')) data.presets.save({ id: 'bob-preset', name: '鲍勃模板', head: '鲍勃的通用提示词。', mid: '', tail: '' }, true)
    data.presets.assign('bob', 'bob-preset')
    data.bindings.set(sessionId, 'alice')
    data.recordTurn({ id: sessionId }, 1)
    const agent = { ctx: agentContext, session: { id: sessionId }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
    apply({ qqbot: { content: data, ui, maintenance: new Maintenance(dshHome(), () => {}) },
      agents: { get: () => agent },
      agentPresets: host === 'current' ? { presetForSession: () => 'qqbot' } : { composedPreset: () => 'qqbot' },
      effect: (fn: () => unknown) => fn(), connection: { fetch: { register: (route: any) => {
        if (route.path.includes('/ui')) handler = route.fetch
        return vi.fn()
      } } } } as unknown as Context)
    const select = (role: string | null) => handler(new Request(`http://local/api/qqbot/ui?session=${sessionId}`, { method: 'POST', body: JSON.stringify({ action: 'session.role', session: sessionId, role }) }))
    const response = await select(null)
    expect(response.status).toBe(200)
    expect((await response.json()).session).toMatchObject({ role: null, turns: [{ turn: 1, role: { id: 'alice' } }] })
    expect((await select('alice')).status).toBe(200)
    expect(data.bindings.turnsOf(sessionId)).toEqual([{ turn: 1, role: 'alice' }])
    expect((await select('bob')).status).toBe(200)
    expect(data.personaFor({ id: sessionId })).toBe('鲍勃的设定。')
    expect(data.jailbreakFor({ id: sessionId }).head).toBe('鲍勃的通用提示词。')
    expect(data.bindings.turnsOf(sessionId)).toEqual([{ turn: 1, role: 'alice' }])
    data.recordTurn({ id: sessionId }, 2)
    expect(data.bindings.turnsOf(sessionId)).toEqual([{ turn: 1, role: 'alice' }, { turn: 2, role: 'bob' }])
    agent.status = 'running'
    expect((await select(null)).status).toBe(409)
    expect(data.bindings.get(sessionId)).toBe('bob')
  })
  it('缺少轮次接口时 /role 支持中途切换，但运行中和排队时只可查看和改默认', () => {
    const { data } = fixture()
    let handler!: (input: any) => any
    const agent = { id: 'command-older', status: 'idle', inbox: { nextTurn: [] as object[], nextStep: [] as object[] } }
    applyRoleCommand({ qqbot: { content: data, maintenance: new Maintenance(dshHome(), () => {}) }, agents: {},
      effect: (fn: () => unknown) => fn(), commands: { register: (command: any) => { handler = command.handler; return vi.fn() } },
    } as unknown as Context)
    const run = (rawInput: string) => handler({ agent, rawInput })
    expect(run('爱丽丝').kind).toBe('success')
    expect(data.bindings.get(agent.id)).toBe('alice')
    data.recordTurn({ id: agent.id }, 1)
    expect(run('none').kind).toBe('success')
    expect(run('爱丽丝').kind).toBe('success')
    for (const busy of ['running', 'queued', 'queued-step']) {
      agent.status = busy === 'running' ? 'running' : 'idle'
      agent.inbox.nextTurn = busy === 'queued' ? [{}] : []
      agent.inbox.nextStep = busy === 'queued-step' ? [{}] : []
      expect(run('none')).toMatchObject({ kind: 'error', text: expect.stringContaining('排队消息') })
      expect(run('爱丽丝').kind).toBe('error')
      expect(run('').kind).toBe('success')
      expect(run('default 爱丽丝').kind).toBe('success')
      expect(data.bindings.get(agent.id)).toBe('alice')
    }
    expect(run('list').kind).toBe('success')
    expect(run('default 爱丽丝').kind).toBe('success')
    expect(data.bindings.get(agent.id)).toBe('alice')
  })
})
