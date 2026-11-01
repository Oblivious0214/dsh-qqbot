import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionBindings } from '../src/bindings.ts'
import { QqbotData } from '../src/content.ts'
import { JailbreakStore } from '../src/presets.ts'
import { RoleLibrary } from '../src/roles.ts'
import { runRole } from '../src/role-command.ts'
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
describe('对话开始后锁定角色', () => {
  it.each(['current', 'older'])('%s 宿主允许空白 QQ 对话选择角色，按当前绑定判断预设', async host => {
    const { data, ui } = fixture()
    let handler!: (request: Request) => Promise<Response>
    const agentContext = {} as Context
    let preset = 'qqbot'
    const sessionId = `compat-${host}`
    const config = { format: 'dsh-qqbot-config', version: 1, roles: [{ name: `导入角色-${host}`, persona: '导入的设定。' }] }
    const options = { presets: true, roles: true, conflict: 'skip' }
    expect(importConfiguration(data, config, options, previewConfiguration(data, config, options).revision).roles).toBe(1)
    const role = data.roles.list().find(item => item.name === `导入角色-${host}`)!
    const agent = { ctx: agentContext, session: { id: sessionId, header: { agentPreset: 'standard' } }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
    const agentPresets = host === 'current'
      ? { presetForSession: () => preset }
      : { composedPreset: (ctx: Context) => { expect(ctx).toBe(agentContext); return preset } }
    apply({ qqbot: { content: data, ui, maintenance: new Maintenance(dshHome(), () => {}) },
      agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 0 }) }, agentPresets,
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
  it('历史轮次阻止界面接口和命令改人，仍可查看与设置新对话默认角色', () => {
    const { data, ui } = fixture()
    applyUiAction(data, ui, { action: 'session.role', session: 's', role: 'alice' })
    data.recordTurn({ id: 's' }, 1)
    expect(() => applyUiAction(data, ui, { action: 'session.role', session: 's', role: null })).toThrow('对话开始后')
    expect(runRole(data, { id: 's' }, 'none').kind).toBe('error')
    expect(runRole(data, { id: 's' }, '爱丽丝').kind).toBe('error')
    expect(runRole(data, { id: 's' }, '').kind).toBe('success')
    expect(runRole(data, { id: 's' }, 'default 爱丽丝').kind).toBe('success')
    expect(data.bindings.get('s')).toBe('alice')
  })
  it.each(['running', 'queued', 'started', 'standard'])('首次回复前的竞态与非 QQ 对话也不能通过 HTTP 换人：%s', async state => {
    const { data, ui } = fixture()
    let handler!: (request: Request) => Promise<Response>
    const agent = { session: { id: 's' }, status: state === 'running' ? 'running' : 'idle', inbox: { nextTurn: state === 'queued' ? [{}] : [], nextStep: [] } }
    apply({ qqbot: { content: data, ui, maintenance: new Maintenance(dshHome(), () => {}) }, agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: state === 'started' ? 1 : 0 }) },
      agentPresets: { presetForSession: () => state === 'standard' ? 'standard' : 'qqbot' },
      effect: (fn: () => unknown) => fn(), connection: { fetch: { register: (route: any) => {
        if (route.path.includes('/ui')) handler = route.fetch
        return vi.fn()
      } } } } as unknown as Context)
    const response = await handler(new Request('http://local/api/qqbot/ui', { method: 'POST', body: JSON.stringify({ action: 'session.role', session: 's', role: 'alice' }) }))
    expect(response.status).toBe(409)
    expect(data.bindings.get('s')).toBeUndefined()
  })
})
