import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostFixture, scope } from './host-fixture.ts'
import { CONTEXT_NAME } from '../../src/order.ts'
import { UPDATE_TOOL, UPDATE_DESCRIPTION } from '../../src/role-dynamics/model.ts'
import { STATE_PATH } from '../../src/role-dynamics/api-types.ts'
import { digest } from '../../src/role-dynamics/history.ts'
import { example } from './fixtures.ts'
const fixtures: Awaited<ReturnType<typeof hostFixture>>[] = []
async function setup() { const f = await hostFixture(); fixtures.push(f); return f }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
const text = (assembly: any) => assembly.contexts.find((entry: any) => entry.name === CONTEXT_NAME.ROLE_DYNAMICS)?.text ?? ''

describe('actual rc.5 prompt/tools with synthetic sessionQuery and real journal', () => {
  it('first turn, native candidate, multistep and automatic retry remain frozen until the next round', async () => {
    const f = await setup(), a = await f.agent(); f.start(a)
    const initial = await f.assemble(a)
    expect(text(initial)).toContain('初识正文'); expect(initial.tools.find((t: any) => t.name === UPDATE_TOOL).description).toBe(UPDATE_DESCRIPTION)
    expect((await f.call(a)).result.isError).toBe(false)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
    expect(text(await f.assemble(a))).toBe(text(initial))
    const retry = f.root.systemPrompt.refreshContext(initial, { agent: a.value, scope: a.value } as any)
    expect(text(retry)).toBe(text(initial))
    expect((await f.call(a, 70)).result.isError).toBe(false)
    f.end(a)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(70)
    expect(f.sessions.flushed.get(a.id)).toBe(a.session.seq)
    f.start(a, 2); const next = await f.assemble(a)
    expect(text(next)).toContain('亲近正文'); expect(text(next)).not.toContain('熟悉正文')
    expect(next.sections).toEqual(initial.sections)
    expect(f.queries.leased).toBe(f.queries.released)
  })
  it.each(['error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked'])('%s discards otherwise successful candidates', async reason => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a); f.end(a, reason)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it.each(['tool-error', 'no-message', 'no-end'])('does not commit %s', async reason => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a)
    await f.call(a, 31, { error: reason === 'tool-error' })
    if (reason !== 'no-end') f.end(a, 'completed', reason !== 'no-message')
    expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it('real rc.5 run_code emits actual PTC subcall records; success commits after its successful outer result', async () => {
    const f = await setup(), a = await f.agent()
    a.ctx.tools.presentAs('ptc'); f.start(a)
    const assembled = await f.assemble(a)
    expect(assembled.tools.map((t: any) => t.name)).toEqual(['run_code'])
    const call = await f.call(a, 31, { ptc: true })
    expect(call.result.isError, JSON.stringify(call.result)).toBe(false)
    expect(a.session.events.some((event: any) => event.type === 'tool/ptc-dispatch-start' && event.data.name === UPDATE_TOOL)).toBe(true)
    expect(a.session.events.some((event: any) => event.type === 'tool/ptc-dispatch' && event.data.isError === false)).toBe(true)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(31)
  })
  it('failed outer run_code cannot commit a successful subcall', async () => {
    const f = await setup(), a = await f.agent(); a.ctx.tools.presentAs('ptc'); f.runtime.rootError = true
    f.start(a); await f.assemble(a); expect((await f.call(a, 31, { ptc: true })).result.isError).toBe(true)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it('programmatic calls without the real round call event have no candidate authority', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a)
    expect((await f.call(a, 31, { noCall: true })).result.isError).toBe(true)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it.each([false, true])('provider callId reuse in the same turn is bound to distinct actual seqs, ptc=%s', async ptc => {
    const f = await setup(), a = await f.agent()
    if (ptc) a.ctx.tools.presentAs('ptc')
    f.start(a); await f.assemble(a)
    expect((await f.call(a, 31, { callId: 'reused', ptc })).result.isError).toBe(false)
    expect((await f.call(a, 40, { callId: 'reused', ptc })).result.isError).toBe(false)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(40)
  })
  it('owner CAS changes the live state without changing current context; stale AI candidates are discarded', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); const initial = await f.assemble(a); await f.call(a)
    await f.owner(a, 80)
    expect(text(await f.assemble(a))).toBe(text(initial))
    expect(text(f.root.systemPrompt.refreshContext(initial, { agent: a.value, scope: a.value } as any))).toBe(text(initial))
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(80)
  })
  it('a standing preset isolates simultaneous dynamic, static and standard agents', async () => {
    const f = await setup(), a = await f.agent('a')
    const plain = f.host.data.roles.save({ name: '普通角色', description: '', persona: '普通正文' }, true)
    f.host.data.bindings.setDefaultRole(plain.id)
    const b = await f.agent('b'), standard = await f.agent('standard', undefined, undefined, false)
    f.start(a); f.start(b); f.start(standard)
    const one = await f.assemble(a), two = await f.assemble(b), three = await f.assemble(standard)
    expect(text(one)).toContain('初识正文'); expect(text(two)).toBe(''); expect(text(three)).toBe('')
    expect(a.ctx.tools.get(UPDATE_TOOL, a.value)).toBeDefined()
    expect(b.ctx.tools.get(UPDATE_TOOL, b.value)).toBeUndefined(); expect(standard.ctx.tools.get(UPDATE_TOOL, standard.value)).toBeUndefined()
    await f.call(a); f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(31)
    expect(await f.state(b)).toBeUndefined()
  })
  it.each(['disabled', 'readonly', 'static'])('%s has no callable native or programmatic state update', async mode => {
    const f = await setup()
    if (mode === 'static') f.host.data.bindings.setDefaultRole(undefined)
    else {
      const config = example()
      if (mode === 'disabled') config.enabled = false
      else config.fields.forEach(field => { field.aiWritable = false })
      await f.host.data.roles.saveAsync({ ...f.role, dynamics: config, dynamicsBaseRevision: f.role.dynamicsRevision }, false)
    }
    const beforeJournal = f.host.store.load(f.role.id)
    const a = await f.agent(); f.start(a); const assembled = await f.assemble(a)
    expect(assembled.tools.some((t: any) => t.name === UPDATE_TOOL)).toBe(false)
    expect(a.ctx.tools.get(UPDATE_TOOL, a.value)).toBeUndefined()
    expect((await f.call(a)).result.isError).toBe(true)
    if (mode === 'readonly') expect(text(assembled)).toContain('依据当前状态和已生效设定回应。')
    else expect(text(assembled)).toBe('')
    if (mode === 'static' || mode === 'disabled') expect(f.host.store.load(f.role.id)).toEqual(beforeJournal)
  })
  it('diagnostic assemble has no agent, no state files, no dynamic tool and no context', async () => {
    const f = await setup()
    const assembled = await f.root.systemPrompt.assemble({ scope: f.preset.ctx } as any)
    expect(text(assembled)).toBe(''); expect(existsSync(join(f.dir, 'role-dynamics'))).toBe(false)
  })
  it('hidden fields, unmatched text/names, local diagnostics and identities never enter model text or results', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); const assembled = await f.assemble(a)
    const sent = JSON.stringify(assembled)
    for (const secret of ['隐藏开关', '本地只读规则', '阶段一名称', '阶段二名称', '熟悉正文', '亲近正文', 'revision', 'progressId']) expect(sent).not.toContain(secret)
    for (const name of ['隐藏开关', '不存在', '称呼']) {
      const call = await f.call(a, undefined, { args: { changes: [{ name, value: true }] } })
      expect(call.result.isError).toBe(true)
      expect(JSON.stringify(call.result.content)).not.toContain(name)
      expect(JSON.stringify(call.result.content)).toContain('本轮没有这个可更新字段')
    }
    expect((await f.call(a, 101)).result.isError).toBe(true)
  })
  it('upcoming state changes cannot rewrite frozen context after a compatible configuration edit', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); const old = await f.assemble(a); await f.call(a)
    const next = example(); next.entries[0]!.text = '新初识正文'
    await f.host.data.roles.saveAsync({ ...f.role, dynamics: next, dynamicsBaseRevision: f.role.dynamicsRevision }, false)
    expect(text(await f.assemble(a))).toBe(text(old)); expect((await f.call(a, 40)).result.isError).toBe(true)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it('a stalled host flush blocks the next admission and maintenance, then admits the committed projection', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a)
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    f.sessions.barrier = () => { entered(); return new Promise(resolve => { release = resolve }) }
    f.end(a); await waiting
    await expect(f.host.maintenance.clear('all')).rejects.toThrow('正在处理')
    f.start(a, 2); let admitted = false
    const admission = f.assemble(a).then(result => { admitted = true; return result })
    await Promise.resolve(); expect(admitted).toBe(false)
    f.sessions.barrier = undefined; release()
    expect(text(await admission)).toContain('熟悉正文')
  })
  it('flush failure leaves durable candidates retryable and never starts a new dynamic round silently', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a)
    f.sessions.participates = false; f.end(a)
    await expect(f.state(a)).rejects.toThrow()
    f.start(a, 2); await expect(f.assemble(a)).rejects.toThrow()
    f.sessions.participates = true
    expect((await f.state(a))!.snapshot.values['好感']).toBe(31)
  })
  it('observation leases include events published during the awaited read and are always released', async () => {
    const f = await setup(), a = await f.agent()
    let release!: () => void
    f.queries.gate = () => new Promise(resolve => { release = resolve })
    const preparing = f.host.prepareSession(a.id)
    a.session.append('user/message', { text: 'during read' }); f.queries.gate = undefined; release(); await preparing
    expect(f.host.history.capture(a.id).events.at(-1)?.data.text).toBe('during read')
    expect(f.queries.leased).toBe(f.queries.released)
  })
  it('the exact owner route checks current role and all CAS identities, preserving a conflicting operation', async () => {
    const f = await setup(), a = await f.agent(); const route = f.route(STATE_PATH)
    const response = await route.fetch(new Request(`http://local${STATE_PATH}?session=${a.id}`))
    const state = (await response.json()).state; expect(state.name).toBe(f.role.name)
    const { revision, ...identity } = state.snapshot
    const operation = { operationId: 'http', baseRevision: revision, configRevision: identity.configRevision, progressId: identity.progressId, generation: identity.generation, dataEpoch: identity.dataEpoch, changes: [{ name: '好感', value: 42 }] }
    const request = (body: any) => route.fetch(new Request(`http://local${STATE_PATH}`, { method: 'POST', body: JSON.stringify(body) }))
    expect((await request({ session: a.id, roleId: f.role.id, operation })).status).toBe(200)
    expect((await request({ session: a.id, roleId: f.role.id, operation })).status).toBe(200)
    expect((await request({ session: a.id, roleId: f.role.id, operation: { ...operation, operationId: 'new', changes: [{ name: '好感', value: 60 }] } })).status).toBe(409)
    expect((await request({ session: a.id, roleId: f.role.id, operation: { ...operation, source: 'owner' } })).status).toBe(409)
    await f.host.prepareSelection(a.id); f.host.data.bindings.set(a.id, null)
    expect((await request({ session: a.id, roleId: f.role.id, operation })).status).toBe(409)
  })
})
