import { expect, it } from 'vitest'
import { fixture, operation, openTurn, candidate, result, end } from './fixtures.ts'
import { hostFixture } from './host-fixture.ts'
import { LIBRARY_STATE_PATH } from '../../src/role-dynamics/api-types.ts'
import { auditStateHttp } from './http-audit.ts'

it('role library HTTP keeps owner-only exact routing, CAS, replay and cleanup checks', async () => {
  const result = await auditStateHttp(undefined, LIBRARY_STATE_PATH)
  expect(result.checks).toHaveLength(9); expect(result.errors).toEqual([])
})

it('owner previews initial values without creating progress, then edits a fresh persisted snapshot', async () => {
  const f = fixture()
  const preview = (await f.service.inspectSnapshot(f.target))!
  expect(preview.values['好感']).toBe(20)
  expect(f.store.saves).toBe(0)
  expect(f.store.data.size).toBe(0)
  const real = (await f.service.readSnapshot(f.target))!
  expect(real.progressId).not.toBe(preview.progressId)
  expect((await f.service.commit(f.target, operation(real, f.owner))).snapshot.values['好感']).toBe(31)
})

it('preview only exposes completed durable changes, without persisting settlement or notifying subscribers', async () => {
  const f = fixture(), handle = await openTurn(f)
  const seq = await candidate(f, handle, 41); result(f, seq)
  expect((await f.service.inspectSnapshot(f.target))!.values['好感']).toBe(20)
  end(f)
  const before = JSON.stringify([...f.store.data]), saves = f.store.saves
  let notifications = 0
  f.service.subscribe(f.target, () => notifications++)
  expect((await f.service.inspectSnapshot(f.target))!.values['好感']).toBe(41)
  expect(f.store.saves).toBe(saves)
  expect(JSON.stringify([...f.store.data])).toBe(before)
  expect(notifications).toBe(0)
  expect((await f.service.readSnapshot(f.target))!.values['好感']).toBe(41)
  expect(notifications).toBe(1)
})

it('preview inherits exact fork progress without writing either branch', async () => {
  const f = fixture(), snapshot = (await f.service.readSnapshot(f.target))!
  await f.service.commit(f.target, operation(snapshot, f.owner))
  f.history.event('s', 'user/message')
  f.history.fork('s', 'child'); f.selected.set('child', 'r')
  const before = JSON.stringify([...f.store.data]), saves = f.store.saves
  expect((await f.service.inspectSnapshot({ sessionId:'child', roleId:'r' }))!.values['好感']).toBe(31)
  expect(f.store.saves).toBe(saves)
  expect(JSON.stringify([...f.store.data])).toBe(before)
})

it('role library reads and edits an unopened selected conversation, rejects another role and stale revisions', async () => {
  const f = await hostFixture()
  try {
    const a = await f.agent('library-a'), b = await f.agent('library-b')
    f.host.data.bindings.set(a.id, f.role.id); f.host.data.bindings.set(b.id, f.role.id)
    const route = f.route(LIBRARY_STATE_PATH)
    const get = async (query: string) => {
      const response = await route.fetch(new Request(`http://local${LIBRARY_STATE_PATH}?roleId=${f.role.id}${query}`))
      return { response, body:await response.json() }
    }
    const list = await get('')
    expect(list.body.sessions).toEqual(expect.arrayContaining([a.id,b.id]))
    // No live Agent is needed: owner edits only plugin-owned progress.
    f.agents.all.delete(b.id)
    const before = JSON.stringify(f.host.store.load(f.role.id))
    const preview = await get(`&session=${b.id}&preview=1`)
    expect(preview.response.status).toBe(200)
    expect(preview.body.state.snapshot.values['好感']).toBe(20)
    expect(JSON.stringify(f.host.store.load(f.role.id))).toBe(before)
    const real = (await get(`&session=${b.id}`)).body.state
    const s = real.snapshot
    const post = () => route.fetch(new Request(`http://local${LIBRARY_STATE_PATH}`, { method:'POST',
      headers:{ 'content-type':'application/json', 'x-qqbot-data-epoch':s.dataEpoch },
      body:JSON.stringify({ session:b.id, roleId:f.role.id, operation:{ operationId:'edit-b', baseRevision:s.revision,
        configRevision:s.configRevision, dataEpoch:s.dataEpoch, progressId:s.progressId, generation:s.generation,
        changes:[{name:'好感', value:67}] } }) }))
    const changed = await post()
    expect(changed.status).toBe(200)
    expect((await changed.json()).state.snapshot.values['好感']).toBe(67)
    expect((await post()).status).toBe(200) // replay remains idempotent
    expect((await f.host.state(a.id))!.snapshot.values['好感']).toBe(20)
    f.host.data.bindings.set(b.id, null)
    expect((await get(`&session=${b.id}&preview=1`)).response.status).toBe(409)
    expect((await post()).status).toBe(409)
  } finally { await f.dispose() }
})
