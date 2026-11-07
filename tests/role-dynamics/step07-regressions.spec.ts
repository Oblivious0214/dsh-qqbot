import { afterEach, describe, expect, it } from 'vitest'
import { hostFixture, rc5Prompt, scope } from './host-fixture.ts'
import { RoleDynamicsService } from '../../src/role-dynamics/service.ts'
import * as prompt from '../../src/prompt.ts'
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UPDATE_TOOL, UPDATE_DESCRIPTION, UPDATE_PARAMETERS } from '../../src/role-dynamics/model.ts'
import { example } from './fixtures.ts'
import * as ui from '../../src/ui.ts'
import * as command from '../../src/role-command.ts'
const fixtures: Awaited<ReturnType<typeof hostFixture>>[] = []
async function setup() { const f = await hostFixture(); fixtures.push(f); return f }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
const op = (s: any, value: number, operationId = 'edit') => ({ operationId, baseRevision: s.revision, configRevision: s.configRevision,
  progressId: s.progressId, generation: s.generation, dataEpoch: s.dataEpoch, changes: [{ name: '好感', value }] })

describe('step 07 host blockers', () => {
  it('the final PTC complete prompt declares exactly this tool and its authorized schema, stable across values and refresh', async () => {
    const f = await setup(), a = await f.agent(); a.ctx.tools.presentAs('ptc'); f.start(a)
    const first = await f.assemble(a), model = JSON.stringify(first)
    expect(first.sections.map((s: any) => s.name)).toEqual(['qqbot:prompt'])
    expect(first.tools.map((t: any) => t.name)).toEqual(['run_code'])
    expect(first.sections[0].text).toContain(UPDATE_TOOL)
    expect(first.sections[0].text).toContain(UPDATE_DESCRIPTION)
    expect(first.sections[0].text).toContain(JSON.stringify(UPDATE_PARAMETERS))
    expect(rc5Prompt.renderPrompt(first)).toContain(`tools.${UPDATE_TOOL}`)
    expect(rc5Prompt.renderPrompt(first)).toContain(UPDATE_DESCRIPTION)
    for (const hidden of ['隐藏开关', '熟悉正文', '亲近正文', 'progressId', '阶段一名称']) expect(model).not.toContain(hidden)
    await f.owner(a, 80)
    expect((await f.assemble(a)).sections).toEqual(first.sections)
    expect(f.root.systemPrompt.refreshContext(first, { agent: a.value, scope: a.value } as any).sections).toEqual(first.sections)
    f.end(a); await f.state(a); f.start(a, 2)
    expect((await f.assemble(a)).sections).toEqual(first.sections)
  })
  it.each(['static', 'disabled', 'readonly'])('PTC %s gets no state declaration or capability', async mode => {
    const f = await setup()
    if (mode === 'static') f.host.data.bindings.setDefaultRole(undefined)
    else {
      const config = example(); if (mode === 'disabled') config.enabled = false
      else config.fields.forEach(field => { field.aiWritable = false })
      await f.host.data.roles.saveAsync({ ...f.role, dynamics: config, dynamicsBaseRevision: f.role.dynamicsRevision }, false)
    }
    const a = await f.agent(); a.ctx.tools.presentAs('ptc'); f.start(a)
    expect(JSON.stringify(await f.assemble(a))).not.toContain(UPDATE_TOOL)
    expect((await f.call(a, 31, { ptc: true })).result.isError).toBe(true)
  })
  it.each([false, true])('preset disposal revokes all open agents durably while completed rounds survive, ptc=%s', async ptc => {
    const f = await setup(), open = await f.agent('open'), done = await f.agent('done')
    for (const a of [open, done]) { if (ptc) a.ctx.tools.presentAs('ptc'); f.start(a); await f.assemble(a); await f.call(a, 31, { ptc }) }
    f.end(done); await f.promptFiber.dispose(); f.end(open)
    expect((await f.state(open))!.snapshot.values['好感']).toBe(20)
    expect((await f.state(done))!.snapshot.values['好感']).toBe(31)
    const child = await f.agent('after-unload', open.session)
    await f.host.attach(child.id)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(20)
    expect((await f.state(open))!.snapshot.values['好感']).toBe(20)
    const cold = new RoleDynamicsService({ store: f.host.store, history: f.host.history, epoch: f.host.maintenance.view().dataEpoch,
      config: id => f.host.data.roles.configuration(id), isSelected: target => f.host.data.roleIdFor({ id: target.sessionId }) === target.roleId })
    expect((await cold.readSnapshot({ sessionId: open.id, roleId: f.role.id }))!.values['好感']).toBe(20)
    cold.dispose()
  })
  it.each(['before', 'after'])('unload across %s beginTurn return cannot leave usable old handles', async boundary => {
    const f = await setup(), a = await f.agent(); f.start(a)
    const original = f.host.core.beginTurn.bind(f.host.core)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.host.core.beginTurn = async (...args) => {
      const handle = boundary === 'after' ? await original(...args) : undefined
      entered(); await new Promise<void>(resolve => { release = resolve })
      return boundary === 'after' ? handle : original(...args)
    }
    const assembly = f.assemble(a).then(() => false, () => true)
    await started; await f.promptFiber.dispose(); release()
    expect(await assembly).toBe(true)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
    const journal = f.host.store.load(f.role.id) as any
    expect(journal.progress.flatMap((p: any) => p.turns).every((turn: any) => turn.revoked)).toBe(true)
  })
  it.each([false, true])('unload during a persisted proposal rejects the awaited result and a new adapter cannot revive it, ptc=%s', async ptc => {
    const f = await setup(), a = await f.agent(); if (ptc) a.ctx.tools.presentAs('ptc')
    f.start(a); await f.assemble(a)
    const original = f.host.core.propose.bind(f.host.core)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.host.core.propose = async (...args) => { const result = await original(...args); entered(); await new Promise<void>(resolve => { release = resolve }); return result }
    const call = f.call(a, 31, { ptc }); await started; await f.promptFiber.dispose(); release()
    expect((await call).result.isError).toBe(true); f.end(a)
    const next = await f.preset.ctx.plugin(prompt)
    try {
      await f.root.serial(scope.scopeTarget(a.value, a.value), 'agent/created', { agent: a.value, source: 'startup' } as any)
      expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
    } finally { await next.dispose() }
  })
  it('failed unload persistence stays revoked through a branch read and retries durable storage', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a, 31)
    const save = f.host.store.save.bind(f.host.store); let fail = true
    f.host.store.save = (...args) => { if (fail) throw Error('injected stop write failure'); save(...args) }
    await f.promptFiber.dispose().catch(() => {})
    f.end(a); fail = false
    const child = await f.agent('stop-write-fork', a.session); await f.host.attach(child.id)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(20)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
    expect((f.host.store.load(f.role.id) as any).progress.find((p: any) => p.sessionId === a.id).turns[0].revoked).toBe(true)
  })
  it('fork materializes every inherited role; old cuts, pending edits and grandchildren remain independent after parent removal', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a, 31); f.end(a); await f.state(a)
    const b = f.host.data.roles.save({ name: 'B', persona: 'B', description: '', dynamics: example() }, true)
    await f.host.prepareSelection(a.id, b.id); f.host.data.bindings.set(a.id, b.id); a.session.append('user/message', { text: 'B' })
    await f.host.ownerCommit(a.id, b.id, op((await f.state(a))!.snapshot, 55)); a.session.append('user/message', { text: '55' })
    const count = a.session.seq
    await f.host.ownerCommit(a.id, b.id, op((await f.state(a))!.snapshot, 90, 'pending'))
    const child = await f.agent('multi-child', a.session, count)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(55)
    f.sessions.all.delete(a.id)
    await f.host.prepareSelection(child.id, f.role.id); f.host.data.bindings.set(child.id, f.role.id)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(31)
    child.session.append('user/message', { text: 'A again' })
    const grand = await f.agent('multi-grand', child.session)
    f.sessions.all.delete(child.id)
    expect((await f.state(grand))!.snapshot.values['好感']).toBe(31)
    await f.host.prepareSelection(grand.id, b.id); f.host.data.bindings.set(grand.id, b.id)
    expect((await f.state(grand))!.snapshot.values['好感']).toBe(55)
  })
  it('a historical multi-role fork ignores the parent later selected role and later sealed values', async () => {
    const f = await setup(), a = await f.agent(); await f.owner(a, 31); a.session.append('user/message', { text: 'A31' })
    const b = f.host.data.roles.save({ name: 'historical B', persona: 'B', description: '', dynamics: example() }, true)
    await f.host.prepareSelection(a.id, b.id); f.host.data.bindings.set(a.id, b.id); a.session.append('user/message', { text: 'B' })
    await f.host.ownerCommit(a.id, b.id, op((await f.state(a))!.snapshot, 55)); a.session.append('user/message', { text: 'B55' })
    const count = a.session.seq
    await f.host.prepareSelection(a.id, f.role.id); f.host.data.bindings.set(a.id, f.role.id)
    await f.owner(a, 90, 'later A90'); a.session.append('user/message', { text: 'later A90' })
    const child = await f.agent('old-multi-cut', a.session, count); f.sessions.all.delete(a.id)
    expect(f.host.data.roleIdFor({ id: child.id })).toBe(b.id)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(55)
    await f.host.prepareSelection(child.id, f.role.id); f.host.data.bindings.set(child.id, f.role.id)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(31)
  })
  it.each(['missing', 'corrupt'])('a genuinely %s copied role baseline fails without substituting initial values', async fault => {
    const f = await setup(), a = await f.agent(); await f.owner(a, 31); a.session.append('user/message', { text: 'A31' })
    const child = await f.agent('damaged-child', a.session)
    const file = join(f.dir, 'role-dynamics', 'roles', createHash('sha256').update(f.role.id).digest('hex'), 'journal.json')
    const original = readFileSync(file)
    // Remove all authority for this role after its branch baseline was established.
    if (fault === 'missing') unlinkSync(file)
    else writeFileSync(file, '{invalid journal', 'utf8')
    f.sessions.all.delete(a.id)
    try {
      await expect(f.state(child)).rejects.toThrow()
      if (fault === 'missing') expect(existsSync(file)).toBe(false)
      else expect(readFileSync(file, 'utf8')).toBe('{invalid journal')
    } finally { writeFileSync(file, original) }
  })
  for (const entry of ['http', 'command']) it.each(['running', 'nextTurn', 'nextStep', 'standard', 'replaced', 'removed', 'idle'])('%s rechecks %s after awaited history', async change => {
    const f = await setup(), a = await f.agent(); let handler: any
    if (entry === 'http') await f.root.plugin(ui)
    else command.apply({ qqbot: f.root.qqbot, effect: (fn: any) => fn(), commands: { register: (def: any) => { handler = def.handler; return () => {} } } } as any)
    const before = f.host.data.bindings.get(a.id)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.queries.gate = () => { entered(); return new Promise<void>(resolve => { release = resolve }) }
    const pending = entry === 'http' ? f.route('/api/qqbot/ui').fetch(new Request('http://local/api/qqbot/ui', { method: 'POST',
      body: JSON.stringify({ action: 'session.role', session: a.id, role: null }) })) : handler({ agent: a.value, rawInput: 'none' })
    await started
    if (change === 'running') { a.value.status = 'running'; f.start(a) }
    if (change === 'nextTurn' || change === 'nextStep') a.value.inbox[change].push({ text: 'queued' })
    if (change === 'standard') (f.root.agentPresets as any).choices.set(a.ctx, 'standard')
    if (change === 'replaced') f.agents.all.set(a.id, { ...a.value })
    if (change === 'removed') f.agents.all.delete(a.id)
    f.queries.gate = undefined; release(); const result = await pending
    expect(entry === 'http' ? result.status : result.kind).toBe(change === 'idle' ? (entry === 'http' ? 200 : 'success') : (entry === 'http' ? 409 : 'error'))
    expect(f.host.data.bindings.get(a.id)).toBe(change === 'idle' ? null : before)
  })
})
