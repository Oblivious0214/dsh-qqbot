import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/auto-reply/index.ts'
import { AUTO_REPLY_SOURCE } from '../../src/auto-reply/types.ts'
import { QqbotRegistryStore } from '../../src/registry.ts'
import { QuickReplySettings } from '../../src/auto-reply/quick-settings.ts'
import { Maintenance } from '../../src/maintenance.ts'
import { dshHome, dataDir } from '../../src/storage.ts'

function fixture(host = 'current') {
  vi.useFakeTimers()
  const events = new Map<string, (...args: any[]) => void>()
  const dispose: Array<() => void> = []
  let handler!: (request: Request) => Promise<Response>
  let preset = 'qqbot', alive = true
  const workspace = { archivedSessionIds: [] as string[] }
  const registry = new QqbotRegistryStore()
  new QuickReplySettings(dataDir(), () => {}).set('s', false)
  const inbox = { nextTurn: [] as any[], nextStep: [] as any[], remove: vi.fn((id: string) => {
    const message = inbox.nextTurn.find(row => row.id === id)
    inbox.nextTurn = inbox.nextTurn.filter(row => row.id !== id)
    if (message) events.get('agent/inbox/discarded')?.({ agent, message })
    return !!message
  }) }
  const agentContext = {} as Context
  const agent = { id: 's', ctx: agentContext, session: { id: 's', header: {} }, status: 'idle', inbox,
    followup: vi.fn((message: any) => { inbox.nextTurn.push(message); events.get('agent/inbox/inserted')?.({ agent, message }) }) }
  const ctx = {
    qqbot: Object.assign(registry, { maintenance: new Maintenance(dshHome(), () => {}) }), logger: { warn: vi.fn() },
    get: () => workspace,
    agents: { get: (id: string) => alive && id === 's' ? agent : undefined, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    agentPresets: host === 'current' ? { presetForSession: () => preset }
      : { composedPreset: (ctx: Context) => { expect(ctx).toBe(agentContext); return preset } },
    on: (name: string, callback: (...args: any[]) => void) => { events.set(name, callback) },
    effect: (callback: () => () => void) => { dispose.push(callback()) },
    connection: { fetch: { register: (route: any) => { handler = route.fetch; return vi.fn() } } },
    llm: { stream: vi.fn(async function* () {
      yield { type: 'text-delta', index: 0, text: '{"replies":["听起来不错","后来怎么样了？","还有什么趣事？"]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }) },
  }
  apply(ctx as unknown as Context)
  const request = async (body: Record<string, unknown>) => {
    const response = await handler(new Request('http://localhost/api/qqbot/auto-reply', { method: 'POST',
      body: JSON.stringify({ session: 's', owner: 'owner-abcdefghijkl', ...body }) }))
    return { status: response.status, data: await response.json() }
  }
  const enable = () => request({ action: 'enable', options: { waitSeconds: 10, maxReplies: 2 } })
  const pulse = async () => { await vi.advanceTimersByTimeAsync(1000); return request({ action: 'pulse', blocked: false, activity: 0 }) }
  const wait = async () => { for (let i = 0; i < 11; i++) await pulse() }
  return { request, enable, pulse, wait, agent, events, workspace, registry, llm: ctx.llm, setPreset: (value: string) => { preset = value },
    detach: () => { alive = false }, dispose: () => { for (const fn of dispose.reverse()) fn() } }
}
afterEach(() => vi.useRealTimers())
describe('宿主公开接口接入（模拟 Agent，不调用模型）', () => {
  it('缺少 presetForSession 的宿主仍可设置并开启接话，标准对话拒绝', async () => {
    const f = fixture('older')
    expect((await f.request({ action: 'quick.get' })).status).toBe(200)
    expect((await f.enable()).status).toBe(200)
    await f.wait()
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    f.setPreset('standard')
    expect((await f.request({ action: 'quick.get' })).status).toBe(409)
    expect((await f.enable()).status).toBe(409)
    f.dispose()
  })
  it('清理全部数据关闭租约并撤回待发接话，恢复默认设置后不自启', async () => {
    const f = fixture()
    const original = (await f.request({ action: 'prompt.get' })).data.prompt
    const quickOriginal = (await f.request({ action: 'quick.prompt.get' })).data.prompt
    await f.request({ action: 'prompt.set', prompt: '待删除的文本' })
    await f.request({ action: 'quick.prompt.set', prompt: '待删除的建议文本' })
    await f.request({ action: 'quick.set', enabled: true })
    await f.enable(); await f.wait()
    f.agent.inbox.nextTurn.push({ id: 'human', source: { kind: 'user' } })
    await f.registry.maintenance.clear('all')
    expect(f.agent.inbox.nextTurn.map(item => item.id)).toEqual(['human'])
    expect((await f.request({ action: 'pulse', blocked: false, activity: 0 })).status).toBe(409)
    expect((await f.request({ action: 'quick.get' })).data.enabled).toBe(true)
    expect((await f.request({ action: 'quick.prompt.get' })).data.prompt).toBe(quickOriginal)
    expect((await f.request({ action: 'prompt.get' })).data.prompt).toBe(original)
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('保存的提示词用于下一次接话，恢复默认不启动或重置接话', async () => {
    const f = fixture()
    const original = (await f.request({ action: 'prompt.reset' })).data.prompt
    expect((await f.request({ action: 'prompt.set', prompt: '以当前角色聊聊今天的晚餐。' })).data.prompt).toContain('晚餐')
    expect(f.agent.followup).not.toHaveBeenCalled()
    await f.enable(); await f.wait()
    expect(f.agent.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: '以当前角色聊聊今天的晚餐。' }])
    expect((await f.request({ action: 'prompt.reset' })).data.prompt).toBe(original)
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    f.setPreset('standard')
    expect((await f.request({ action: 'prompt.set', prompt: '其他内容' })).status).toBe(409)
    expect((await f.request({ action: 'prompt.reset' })).status).toBe(409)
    f.dispose()
  })
  it('只生成带来源的 notice，防重并可只撤回自身待发项', async () => {
    const f = fixture(); expect((await f.enable()).status).toBe(200); await f.wait()
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    const message = f.agent.followup.mock.calls[0]![0]
    expect(message).toMatchObject({ role: 'user', source: { kind: AUTO_REPLY_SOURCE, form: 'notice', summary: '自动接话' } })
    f.agent.inbox.nextTurn.push({ id: 'human', source: { kind: 'user' } })
    await f.request({ action: 'disable' })
    expect(f.agent.inbox.nextTurn.map(row => row.id)).toEqual(['human'])
    f.dispose()
  })
  it.each(['aborted', 'blocked', 'error', 'max-tokens'])('turn/end=%s 后不再发起', async kind => {
    const f = fixture(); await f.enable()
    f.events.get('session/event')!(f.agent.session, { type: 'turn/end', data: { reason: { kind } } })
    expect((await f.pulse()).data.enabled).toBe(false)
    await f.wait(); expect(f.agent.followup).not.toHaveBeenCalled(); f.dispose()
  })
  it('错误通知和 agent 释放均失效，不恢复旧激活状态', async () => {
    const f = fixture(); await f.enable(); f.events.get('agent/error')!({ agent: f.agent })
    expect((await f.pulse()).data.enabled).toBe(false)
    await f.enable(); f.events.get('agent/disposed')!({ agent: f.agent }); f.detach()
    expect((await f.pulse()).status).toBe(409); f.dispose()
  })
  it('归档与标准预设在宿主再次校验，前端无法误开启', async () => {
    const f = fixture(); f.setPreset('standard'); expect((await f.enable()).status).toBe(409)
    f.setPreset('qqbot'); await f.enable(); f.workspace.archivedSessionIds.push('s')
    expect((await f.pulse()).data.enabled).toBe(false)
    f.workspace.archivedSessionIds.length = 0; await f.wait()
    expect(f.agent.followup).not.toHaveBeenCalled(); f.dispose()
  })
  it('卸载清理待发提醒及计时器，不清用户消息', async () => {
    const f = fixture(); await f.enable(); await f.wait()
    f.agent.inbox.nextTurn.push({ id: 'human', source: { kind: 'user' } }); f.dispose()
    expect(f.agent.inbox.nextTurn.map(row => row.id)).toEqual(['human'])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('勾选只改变当前会话登记的规则，不调用模型或发消息；旧候选接口已删除', async () => {
    const f = fixture()
    const rule = f.registry.snapshot().extensions.find(entry => entry.name === 'quick-replies')!.text as (session: { id: string }) => string
    expect(rule({ id: 's' })).toBe('')
    expect((await f.request({ action: 'quick.set', enabled: true })).data.enabled).toBe(true)
    expect(rule({ id: 's' })).toContain('[qq-replies]'); expect(rule({ id: 'other' })).toContain('[qq-replies]')
    expect((await f.request({ action: 'quick.get' })).data.enabled).toBe(true)
    expect((await f.request({ action: 'candidates' })).status).toBe(409)
    await f.request({ action: 'quick.set', enabled: false }); expect(rule({ id: 's' })).toBe('')
    expect(f.llm.stream).not.toHaveBeenCalled(); expect(f.agent.followup).not.toHaveBeenCalled()
    f.dispose(); expect(f.registry.snapshot().extensions).toHaveLength(0)
  })
  it('回复建议提示词按会话生效，关闭时保留编辑，恢复默认不发消息', async () => {
    const f = fixture()
    const rule = f.registry.snapshot().extensions.find(entry => entry.name === 'quick-replies')!.text as (session: { id: string }) => string
    const original = (await f.request({ action: 'quick.prompt.reset' })).data.prompt
    expect((await f.request({ action: 'quick.prompt.set', prompt: '起草三条晚餐建议。' })).data.prompt).toContain('晚餐')
    expect(rule({ id: 's' })).toBe('')
    await f.request({ action: 'quick.set', enabled: true })
    expect(rule({ id: 's' })).toBe('起草三条晚餐建议。')
    expect(rule({ id: 'other' })).toBe(original)
    expect((await f.request({ action: 'quick.prompt.set', prompt: '  ' })).status).toBe(409)
    expect(rule({ id: 's' })).toContain('晚餐')
    expect((await f.request({ action: 'quick.prompt.reset' })).data.prompt).toBe(original)
    expect(rule({ id: 's' })).toBe(original)
    expect(f.llm.stream).not.toHaveBeenCalled(); expect(f.agent.followup).not.toHaveBeenCalled()
    for (const state of ['standard', 'archived', 'detached']) {
      if (state === 'standard') f.setPreset('standard')
      if (state === 'archived') { f.setPreset('qqbot'); f.workspace.archivedSessionIds.push('s') }
      if (state === 'detached') { f.workspace.archivedSessionIds.length = 0; f.detach() }
      for (const action of ['quick.prompt.get', 'quick.prompt.set', 'quick.prompt.reset']) {
        expect((await f.request({ action, prompt: '其他内容' })).status).toBe(409)
      }
    }
    f.dispose()
  })
  it('点击方式只保存偏好，不改变提示词或发消息，并遵循会话隔离', async () => {
    const f = fixture()
    const before = (await f.request({ action: 'quick.get' })).data
    expect(before.clickMode).toBe('send')
    const rule = f.registry.snapshot().extensions.find(entry => entry.name === 'quick-replies')!.text as (session: { id: string }) => string
    const original = rule({ id: 's' })
    expect((await f.request({ action: 'quick.mode.set', clickMode: 'draft' })).data).toEqual({ enabled: before.enabled, clickMode: 'draft' })
    expect(rule({ id: 's' })).toBe(original)
    expect((await f.request({ action: 'quick.mode.set', clickMode: 'invalid' })).status).toBe(409)
    expect((await f.request({ action: 'quick.get' })).data.clickMode).toBe('draft')
    for (const state of ['standard', 'archived', 'detached']) {
      if (state === 'standard') f.setPreset('standard')
      if (state === 'archived') { f.setPreset('qqbot'); f.workspace.archivedSessionIds.push('s') }
      if (state === 'detached') { f.workspace.archivedSessionIds.length = 0; f.detach() }
      expect((await f.request({ action: 'quick.mode.set', clickMode: 'draft' })).status).toBe(409)
    }
    expect(f.llm.stream).not.toHaveBeenCalled(); expect(f.agent.followup).not.toHaveBeenCalled(); f.dispose()
  })
  it('标准、归档和失效会话不能设置快捷选项', async () => {
    const f = fixture(); f.setPreset('standard')
    expect((await f.request({ action: 'quick.set', enabled: true })).status).toBe(409)
    f.setPreset('qqbot'); f.workspace.archivedSessionIds.push('s')
    expect((await f.request({ action: 'quick.set', enabled: true })).status).toBe(409)
    f.workspace.archivedSessionIds.length = 0; f.detach()
    expect((await f.request({ action: 'quick.get' })).status).toBe(409)
    expect(f.llm.stream).not.toHaveBeenCalled(); f.dispose()
  })
})
