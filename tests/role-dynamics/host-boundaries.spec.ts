import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { hostFixture, scope } from './host-fixture.ts'
import { UPDATE_TOOL } from '../../src/role-dynamics/model.ts'
import type { DynamicsSource } from '../../src/role-dynamics/api-types.ts'
import { CONTEXT_NAME, CONTEXT_ORDER, PROMPT_ORDER, SECTION_NAME } from '../../src/order.ts'
import { assembleParts, renderRuntime, PART_SEPARATOR } from '../../src/prompt.ts'
import { digest } from '../../src/role-dynamics/history.ts'
import { example } from './fixtures.ts'
const fixtures: Awaited<ReturnType<typeof hostFixture>>[] = []
async function setup() { const f = await hostFixture(); fixtures.push(f); return f }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
function operation(snapshot: any, value = 50, id = 'plugin') {
  return { operationId: id, baseRevision: snapshot.revision, configRevision: snapshot.configRevision, progressId: snapshot.progressId,
    generation: snapshot.generation, dataEpoch: snapshot.dataEpoch, changes: [{ name: '好感', value }] }
}
async function source(f: Awaited<ReturnType<typeof setup>>, name: string) {
  let handle!: DynamicsSource
  const fiber = await f.root.plugin({ name, inject: ['qqbot'], apply: (ctx: Context) => { handle = ctx.qqbot.dynamics.registerSource(`来源${name}`) } })
  return { handle, fiber }
}
describe('host dynamic ancestry, sources and teardown', () => {
  it('ordinary static forks retain the original lazy binding and do not read dynamic history', async () => {
    const f = await setup(); f.host.data.bindings.setDefaultRole(undefined)
    const parent = await f.agent('plain-parent'), before = f.queries.leased
    const child = await f.agent('plain-child', parent.session)
    expect(f.queries.leased).toBe(before)
    expect(f.host.data.bindings.get(child.id)).toBeUndefined()
    f.start(child); await f.assemble(child)
    expect(f.host.data.bindings.get(child.id)).toBeNull()
    expect(child.ctx.tools.get(UPDATE_TOOL, child.value)).toBeUndefined()
  })
  it('fork restores the old role and values despite parent current choice and default changes; fork of fork is independent', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a); f.end(a)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(31)
    const count = a.session.seq
    const second = f.host.data.roles.save({ name: '另一个动态角色', description: '', persona: '另一正文', dynamics: example() }, true)
    await f.host.prepareSelection(a.id, second.id); f.host.data.bindings.set(a.id, second.id)
    f.host.data.bindings.setDefaultRole(second.id)
    a.session.append('user/message', { text: 'second role selected' })
    const child = await f.agent('child', a.session, count)
    expect(f.host.data.roleIdFor({ id: child.id })).toBe(f.role.id)
    const childState = (await f.state(child))!
    expect(childState.snapshot.values['好感']).toBe(31)
    expect(childState.snapshot.progressId).not.toBe((await f.host.core.readSnapshot({ sessionId: a.id, roleId: f.role.id }))!.progressId)
    await f.owner(child, 45, 'child-owner')
    const grand = await f.agent('grand', child.session, count)
    expect(f.host.data.roleIdFor({ id: grand.id })).toBe(f.role.id)
    expect((await f.state(grand))!.snapshot.values['好感']).toBe(31)
    child.session.append('user/message', { text: 'inherit manual value from now' })
    const after = await f.agent('after', child.session)
    expect((await f.state(after))!.snapshot.values['好感']).toBe(45)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(45)
  })
  it('switching back keeps each role state; pending role selection only enters a branch at the next actual event', async () => {
    const f = await setup(), a = await f.agent(); await f.owner(a, 80)
    a.session.append('user/message', { text: 'old role boundary' }); const count = a.session.seq
    const second = f.host.data.roles.save({ name: '第二人', description: '', persona: '正文', dynamics: example() }, true)
    await f.host.prepareSelection(a.id, second.id); f.host.data.bindings.set(a.id, second.id)
    const before = await f.agent('before-choice', a.session, count)
    expect(f.host.data.roleIdFor({ id: before.id })).toBe(f.role.id)
    a.session.append('user/message', { text: 'after choice' })
    const after = await f.agent('after-choice', a.session)
    expect(f.host.data.roleIdFor({ id: after.id })).toBe(second.id)
    await f.host.prepareSelection(a.id, f.role.id); f.host.data.bindings.set(a.id, f.role.id)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(80)
  })
  it('fork of an open round excludes candidates and excludes its forked closer from success', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a)
    const child = await f.agent('open-child', a.session)
    child.session.append('turn/end', { turn: 1, reason: { kind: 'forked' } })
    expect((await f.state(child))!.snapshot.values['好感']).toBe(20)
    f.end(a); expect((await f.state(a))!.snapshot.values['好感']).toBe(31)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(20)
  })
  it('copied child baselines and later grandchildren survive removal of the original parent history', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a); f.end(a)
    const child = await f.agent('independent-child', a.session)
    f.sessions.all.delete(a.id)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(31)
    const grand = await f.agent('independent-grandchild', child.session)
    expect((await f.state(grand))!.snapshot.values['好感']).toBe(31)
  })
  it('a completed child created before the queued parent settlement still reconstructs the completed cut', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a); f.end(a)
    const child = await f.agent('completed-child', a.session)
    expect((await f.state(child))!.snapshot.values['好感']).toBe(31)
    expect((await f.state(a))!.snapshot.revision).toBe(1)
  })
  it('a real prefix cut in the same session creates a new generation and excludes future owner tail', async () => {
    const f = await setup(), a = await f.agent(); a.session.append('user/message', { text: 'first' })
    await f.state(a); a.session.append('user/message', { text: 'second' }); await f.owner(a, 80)
    const before = (await f.state(a))!.snapshot
    a.session.events = a.session.events.slice(0, 1)
    const after = (await f.state(a))!.snapshot
    expect(after.values['好感']).toBe(20); expect(after.generation).not.toBe(before.generation)
    await expect(f.host.ownerCommit(a.id, f.role.id, operation(before))).rejects.toThrow()
  })
  it('registered identities come from actual Cordis callers; plugins cannot acquire owner field permission', async () => {
    const f = await setup(), a = await f.agent(), first = await source(f, 'plugin-a'), second = await source(f, 'plugin-b')
    const target = { sessionId: a.id, roleId: f.role.id }, snap = (await first.handle.readSnapshot(target))!
    await first.handle.commit(target, operation(snap))
    expect((await f.state(a))!.snapshot.values['好感']).toBe(50)
    await expect(second.handle.commit(target, operation(snap, 60))).rejects.toThrow('状态已变化')
    const current = (await second.handle.readSnapshot(target))!
    await expect(second.handle.commit(target, { ...operation(current), changes: [{ name: '称呼', value: '冒领' }] })).rejects.toThrow('未开放')
    await first.fiber.dispose()
    await expect(first.handle.readSnapshot(target)).rejects.toThrow('撤销')
  })
  it('plugin private partitions stay isolated and never affect public condition/model projection', async () => {
    const f = await setup(), a = await f.agent(), first = await source(f, 'plugin-one'), second = await source(f, 'plugin-two')
    const target = { sessionId: a.id, roleId: f.role.id }, snap = (await first.handle.readSnapshot(target))!
    const config = { version: 1 as const, enabled: true, fields: [{ name: '插件秘密', type: 'text' as const, initial: '初始秘密', visible: false, aiWritable: false }], entries: [] }
    await first.handle.commitExtension(target, config, { ...operation(snap), configRevision: digest(config), changes: [{ name: '插件秘密', value: '仅插件一' }] })
    expect(await second.handle.readExtension(target)).toBeUndefined()
    expect(JSON.stringify(await first.handle.projectModel(target))).not.toContain('插件秘密')
    expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it('owner and plugin handles are rebuilt after failed prepare and successful all-data cleanup', async () => {
    const f = await setup(), a = await f.agent(), plugin = await source(f, 'renew-plugin')
    const target = { sessionId: a.id, roleId: f.role.id }
    const cancel = f.host.maintenance.register({ credentials: async () => { throw Error('synthetic credentials failure') } })
    await expect(f.host.maintenance.clear('all')).rejects.toThrow('credentials failure')
    cancel()
    const snap = (await plugin.handle.readSnapshot(target))!
    await plugin.handle.commit(target, operation(snap, 55))
    await f.owner(a, 60)
    await f.host.maintenance.clear('cache')
    expect((await f.state(a))!.snapshot.values['好感']).toBe(60)
    const stale = (await f.state(a))!.snapshot
    await f.host.maintenance.clear('all')
    expect(await plugin.handle.readSnapshot(target)).toBeUndefined()
    await expect(f.host.ownerCommit(a.id, f.role.id, operation(stale))).rejects.toThrow()
    const replacement = f.host.data.roles.save({ name: '清理后角色', description: '', persona: '正文', dynamics: example() }, true)
    await f.host.prepareSelection(a.id, replacement.id); f.host.data.bindings.set(a.id, replacement.id)
    const freshTarget = { sessionId: a.id, roleId: replacement.id }, fresh = (await plugin.handle.readSnapshot(freshTarget))!
    await plugin.handle.commit(freshTarget, operation(fresh, 42))
    expect((await f.state(a))!.snapshot.values['好感']).toBe(42)
  })
  it('stop revokes scoped tools, plugins and old candidates, including direct invocation of a captured definition', async () => {
    const f = await setup(), a = await f.agent(), plugin = await source(f, 'stop-plugin')
    f.start(a); await f.assemble(a); const definition = a.ctx.tools.get(UPDATE_TOOL, a.value)!
    await f.call(a)
    await f.promptFiber.dispose()
    expect(a.ctx.tools.get(UPDATE_TOOL, a.value)).toBeUndefined()
    await expect(definition.execute({ changes: [{ name: '好感', value: 40 }] }, { agent: a.value, callId: 'late', signal: new AbortController().signal } as any)).rejects.toThrow('失效')
    f.host.dispose()
    await expect(plugin.handle.readSnapshot({ sessionId: a.id, roleId: f.role.id })).rejects.toThrow()
  })
  it('cancel before and after a candidate cannot commit a successful-looking late result', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a)
    const abort = new AbortController(); abort.abort()
    expect((await f.call(a, 31, { signal: abort.signal })).result.isError).toBe(true)
    f.end(a, 'aborted'); expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
  })
  it('disposing an open agent revokes durable candidates before a late completed event', async () => {
    const f = await setup(), a = await f.agent(); f.start(a); await f.assemble(a); await f.call(a)
    f.root.emit(scope.scopeTarget(a.value, a.value), 'agent/disposed', { agent: a.value })
    f.end(a)
    expect((await f.state(a))!.snapshot.values['好感']).toBe(20)
    expect(a.ctx.tools.get(UPDATE_TOOL, a.value)).toBeUndefined()
  })
  it('static request bytes match a qqbot preset with the dynamics adapter detached; standard is untouched', async () => {
    const f = await setup(); f.host.data.bindings.setDefaultRole(undefined)
    const a = await f.agent(); f.start(a); const before = await f.assemble(a)
    await f.promptFiber.dispose()
    // The original pure assembly functions remain byte-identical (also
    // checked against before/src/prompt.ts by the step verifier).
    f.preset.ctx.systemPrompt.section({ name: SECTION_NAME.PROMPT, order: PROMPT_ORDER, complete: true, interpolate: false,
      text: () => assembleParts(f.host.data, f.root.qqbot.store, { id: a.id }).map(part => part.text).join(PART_SEPARATOR) })
    f.preset.ctx.systemPrompt.context({ name: CONTEXT_NAME.RUNTIME, order: CONTEXT_ORDER.RUNTIME, required: true, interpolate: false,
      text: () => renderRuntime(f.root.qqbot.store, { id: a.id }) })
    const after = await f.assemble(a)
    expect(JSON.stringify(before)).toBe(JSON.stringify(after))
    expect(before.tools).toEqual([])
    expect(before.contexts.some((item: any) => item.name === CONTEXT_NAME.ROLE_DYNAMICS)).toBe(false)
    expect(JSON.stringify(before.sections)).not.toContain('动态')
  })
})
