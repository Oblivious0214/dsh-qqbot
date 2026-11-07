import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { HostConnectionService } from '../../../../qqbot/src/deepseek-harness/packages/client/connection/src/rpc-host.ts'
import { bridge as developmentBridge } from '../../../../qqbot/src/deepseek-harness/packages/client/connection/src/http-bridge.ts'
import { hostFixture } from './host-fixture.ts'
import { STATE_PATH, LIBRARY_STATE_PATH } from '../../src/role-dynamics/api-types.ts'
export async function auditStateHttp(bridge: typeof developmentBridge = developmentBridge, routePath = STATE_PATH) {
  const f = await hostFixture(), a = await f.agent(), transport = new Context()
  const connection = new HostConnectionService(transport, [], {} as any)
  const cancel = connection.fetch.register(f.route(routePath)), handler = connection.createSharedFetchHandler('/api')
  const checks: string[] = [], errors: string[] = []
  const server = createServer((request, response) => {
    const peer = request.headers['x-test-guest'] ? { principal: { kind: 'guest' } } as any : connection.browserPeer
    void bridge(request, response, handler, peer, 100000).catch(error => { errors.push(error.message); response.destroy(error) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const get = (headers = {}) => fetch(`${base}${routePath}?session=${a.id}${routePath === LIBRARY_STATE_PATH ? `&roleId=${f.role.id}` : ''}`, { headers })
  const post = (body: any, headers = {}) => fetch(base + routePath, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    assert.equal(handler.requestBodyMode({ method: 'GET', url: new URL(base + routePath) }), 'buffered')
    assert.equal(handler.requestBodyMode({ method: 'POST', url: new URL(base + routePath) }), 'buffered'); checks.push('GET/POST buffered exact route')
    const initial = await get(); assert.equal(initial.status, 200); const state = (await initial.json()).state; checks.push('owner GET has real snapshot')
    const s = state.snapshot, operation = { operationId: 'http-operation', baseRevision: s.revision, progressId: s.progressId, generation: s.generation,
      configRevision: s.configRevision, dataEpoch: s.dataEpoch, changes: [{ name: '好感', value: 31 }] }
    const body = { session: a.id, roleId: f.role.id, operation }
    for (const action of [() => get({ 'x-test-guest': '1' }), () => post(body, { 'x-test-guest': '1' })]) {
      const response = await action(); assert.equal(response.status, 403); await response.text()
    }
    assert.equal((await f.state(a))!.snapshot.revision, s.revision); checks.push('guest GET/POST forbidden before dispatch')
    const success = await post(body); assert.equal(success.status, 200); assert.equal((await success.json()).state.snapshot.values['好感'], 31); checks.push('owner POST commits')
    const replay = await post(body); assert.equal(replay.status, 200); assert.equal((await replay.json()).state.snapshot.revision, 1); checks.push('replay idempotent')
    const stale = await post({ ...body, operation: { ...operation, operationId: 'stale' } }); assert.equal(stale.status, 409); await stale.text(); checks.push('stale CAS 409')
    const impersonated = await post({ ...body, operation: { ...operation, source: 'owner' } }); assert.equal(impersonated.status, 409); await impersonated.text(); checks.push('self-reported source rejected')
    const epoch = await post(body, { 'x-qqbot-data-epoch': 'old' }); assert.equal(epoch.status, 409); await epoch.text(); checks.push('old epoch rejected')
    const suffix = await fetch(base + routePath + '/extra'); assert.equal(suffix.status, 404); await suffix.text(); checks.push('suffix is not an exact route')
    assert.deepEqual(errors, [])
    return { checks, errors }
  } finally {
    cancel(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await transport.fiber.dispose(); await f.dispose()
  }
}
