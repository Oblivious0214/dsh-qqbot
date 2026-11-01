import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import WebServer from '@deepseek-ai/dsh-host-webserver/src/index.ts'
import * as connection from '@deepseek-ai/dsh-client-connection/src/index.ts'
import { QqbotService } from '../../src/index.ts'
import * as phone from '../../src/phone/index.ts'
import { PHONE_PATH, PHONE_LOGIN } from '../../src/phone-types.ts'
import { createGateway } from '../../src/phone/gateway.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
describe('手机入口与原生认证 API', () => {
  it('真实宿主连接服务完成认证转发，保留 owner 接口权限并隔离入口管理', async () => {
    const root = new Context(); cleanup.push(() => root.fiber.dispose())
    let record: unknown
    root.provide('credentials', { modifyRecord: async (_key: unknown, mutate: (value: unknown) => Promise<unknown>) => {
      const next = await mutate(record); if (next !== undefined) record = next; return record
    } } as any)
    await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await root.plugin(connection)
    await root.plugin(QqbotService)
    const phoneFiber = root.plugin(phone); await phoneFiber
    root.connection.fetch.register({ path: '/api/qqbot/probe', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => Response.json({ method: request.method, owner: true }) })
    root.webServer.registerFallback({ resource: async request => {
      let response = new Response('', { status: 401 })
      const allowed = root.connection.authorizeIndex(request, { writeHead: (status, headers) => { response = new Response(null, { status, headers }) }, end: () => {} })
      return allowed ? new Response('<html><head></head><body>native DSH shell</body></html>', { headers: { 'content-type': 'text/html' } }) : response
    } })
    const origin = root.webServer.getOrigin()
    const exchange = await fetch(root.connection.authenticatedUrl(origin), { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    const ownerCookie = exchange.headers.get('set-cookie')!.split(';')[0]!
    expect((await fetch(new URL(PHONE_PATH, origin))).status).toBe(401)
    const local = await fetch(new URL(PHONE_PATH, origin), { headers: { cookie: ownerCookie } })
    expect(local.status).toBe(200); const view = await local.json()
    expect(view.running).toBe(false); expect(view.enabled).toBe(false)
    const marked = await fetch(new URL(PHONE_PATH, origin), { headers: { cookie: ownerCookie, 'x-qqbot-phone-proxy': '1' } })
    expect(marked.status).toBe(403)
    const invalid = await fetch(new URL(PHONE_PATH, origin), { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: '{"action":"save"}' })
    expect(invalid.status).toBe(400)
    const gateway = await createGateway({ host: '127.0.0.1', port: 0, upstream: origin, accessCode: 'phone-integration-test', authenticate: async () => {
      const auth = await fetch(root.connection.authenticatedUrl(origin), { redirect: 'manual' }); await auth.body?.cancel()
      if (auth.status !== 303) throw new Error('exchange failed')
      return auth.headers.get('set-cookie')!.split(';')[0]!
    } }); cleanup.push(() => gateway.close())
    const login = await fetch(new URL(PHONE_LOGIN, gateway.url), { redirect: 'manual', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=phone-integration-test' })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect((await fetch(gateway.url, { headers: { cookie } })).status).toBe(200)
    const probe = await fetch(new URL('/api/qqbot/probe', gateway.url), { method: 'POST', headers: { cookie, origin: new URL(gateway.url).origin }, body: 'test' })
    expect(await probe.json()).toEqual({ method: 'POST', owner: true })
    expect((await fetch(new URL(PHONE_PATH, gateway.url), { headers: { cookie } })).status).toBe(403)
    // scope 撤销不影响其他原生路由；完整关闭由 afterEach 释放。
    await phoneFiber.dispose()
    expect((await fetch(new URL(PHONE_PATH, origin), { headers: { cookie: ownerCookie } })).status).toBe(404)
    expect((await fetch(new URL('/api/qqbot/probe', origin), { headers: { cookie: ownerCookie } })).status).toBe(200)
  })
})
