import { createServer, request, type Server, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createGateway, isPrivateAddress, type PhoneGateway } from '../../src/phone/gateway.ts'
import { PHONE_LOGIN, PHONE_LOGOUT, PHONE_PATH } from '../../src/phone-types.ts'

const dispose: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close() })
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  dispose.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`
}
async function fixture(options: { now?: () => number; authenticate?: () => Promise<string>; sessionMs?: number } = {}) {
  const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = []
  const peers = new Set<Duplex>()
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    seen.push({ url: req.url!, headers: req.headers, body })
    if (req.url === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ready\n\n'); return }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'host-secret=never-forward' }); res.end('<html><head><title>DSH</title></head><body>native</body></html>'); return }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'host-secret=never-forward' }); res.end(JSON.stringify({ ok: true, body }))
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url!, headers: req.headers, body: '' }); peers.add(socket); socket.on('close', () => peers.delete(socket))
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', chunk => socket.write(chunk)); socket.on('error', () => {})
  })
  const upstream = await listen(server)
  dispose.push(async () => { for (const peer of peers) peer.destroy() })
  const gateway = await createGateway({ host: '127.0.0.1', port: 0, upstream, accessCode: 'test-phone-code', authenticate: options.authenticate ?? (async () => 'owner-cookie=server-only'), ...options })
  dispose.push(() => gateway.close())
  const call = (path: string, init?: RequestInit) => fetch(new URL(path, gateway.url), { redirect: 'manual', ...init })
  const login = async (code = 'test-phone-code') => {
    const response = await call(PHONE_LOGIN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code }) })
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }
  return { gateway, call, login, seen, upstream }
}
async function upgrade(gateway: PhoneGateway, cookie: string, endpoint = gateway.url): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/remote.mux', endpoint), { headers: { host: new URL(gateway.url).host, cookie, connection: 'Upgrade', upgrade: 'websocket', origin: new URL(gateway.url).origin, 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } })
    req.on('upgrade', (_res, socket) => resolve(socket)); req.on('response', res => { res.resume(); reject(new Error(String(res.statusCode))) }); req.on('error', reject); req.end()
  })
}
describe('本地手机认证代理', () => {
  it('只允许明确的私网和测试回环，拒绝通配地址及公网目标', async () => {
    expect(isPrivateAddress('192.168.1.2')).toBe(true); expect(isPrivateAddress('172.31.1.2')).toBe(true)
    expect(isPrivateAddress('0.0.0.0')).toBe(false); expect(isPrivateAddress('100.64.1.2')).toBe(false)
    await expect(createGateway({ host: '0.0.0.0', port: 0, upstream: 'http://127.0.0.1/', accessCode: 'test-code', authenticate: async () => '' })).rejects.toThrow('局域网')
    await expect(createGateway({ host: '127.0.0.1', port: 0, upstream: 'http://example.com/', accessCode: 'test-code', authenticate: async () => '' })).rejects.toThrow('本机')
  })
  it('登录前不转发；登录后共享页面、接口、语音和图片，主机 Cookie 不下发', async () => {
    const f = await fixture()
    expect((await f.call('/')).headers.get('location')).toBe(PHONE_LOGIN)
    expect((await f.call('/api/qqbot/library')).status).toBe(401); expect(f.seen).toHaveLength(0)
    const { response, cookie } = await f.login(); expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
    const index = await f.call('/', { headers: { cookie } })
    expect(await index.text()).toContain('<meta name="qqbot-phone" content="local">'); expect(index.headers.get('set-cookie')).toBeNull()
    for (const path of ['/api/qqbot/library', '/api/qqbot/voice/audio?id=test', '/api/qqbot/ui/image?id=test']) expect((await f.call(path, { headers: { cookie } })).status).toBe(200)
    const saved = await f.call('/api/qqbot/ui', { method: 'POST', headers: { cookie, origin: new URL(f.gateway.url).origin, 'content-type': 'application/json', authorization: 'phone-untrusted', 'x-forwarded-host': 'evil.invalid', 'x-qqbot-phone-proxy': 'spoofed' }, body: '{"palette":"blue"}' })
    expect(saved.status).toBe(200)
    const last = f.seen.at(-1)!
    expect(last.body).toBe('{"palette":"blue"}'); expect(last.headers.cookie).toBe('owner-cookie=server-only')
    expect(last.headers.authorization).toBeUndefined(); expect(last.headers['x-forwarded-host']).toBeUndefined(); expect(last.headers['x-qqbot-phone-proxy']).toBe('1')
    expect(last.headers.origin).toMatch(/^http:\/\/127\.0\.0\.1:/)
  })
  it('错误访问码、重复码、来源伪造和暴力尝试被拒绝', async () => {
    const f = await fixture()
    const wrongHost = await new Promise<number>(resolve => {
      const req = request(f.gateway.url, { headers: { host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode!) }); req.end()
    })
    expect(wrongHost).toBe(403)
    expect((await f.call(PHONE_LOGIN, { headers: { origin: 'https://evil.invalid' } })).status).toBe(403)
    expect((await f.call(PHONE_LOGIN, { method: 'POST', headers: { origin: 'null' } })).status).toBe(403)
    expect((await f.call(PHONE_LOGIN, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    for (let i = 0; i < 8; i++) expect((await f.login('wrong-code')).response.status).toBe(401)
    expect((await f.login()).response.status).toBe(429)
  })
  it('登录页和错误页保留同源表单来源，允许浏览器重试登录', async () => {
    const f = await fixture()
    expect((await f.call(PHONE_LOGIN)).headers.get('referrer-policy')).toBe('same-origin')
    const submit = (code: string) => f.call(PHONE_LOGIN, { method: 'POST', headers: {
      origin: new URL(f.gateway.url).origin, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ code }) })
    const wrong = await submit('wrong-code')
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('referrer-policy')).toBe('same-origin')
    expect((await submit('test-phone-code')).status).toBe(303)
  })
  it('手机不能管理入口、交换主机 token 或通过编码路径绕过', async () => {
    const f = await fixture(); const { cookie } = await f.login()
    for (const path of [PHONE_PATH, PHONE_PATH + '/other', '/connect?token=x', '/?token=x', '/__qqbot_phone/other']) expect((await f.call(path, { headers: { cookie } })).status).toBe(403)
    expect((await f.call('/api/qqbot/%70hone', { headers: { cookie } })).status).toBe(400)
    expect(f.seen).toHaveLength(0)
  })
  it('原生长连接双向转发，退出立即断开；旧登录不能继续请求或重连', async () => {
    const f = await fixture(); const { cookie } = await f.login()
    const socket = await upgrade(f.gateway, cookie)
    expect(f.seen.at(-1)!.headers.cookie).toBe('owner-cookie=server-only')
    const data = new Promise<Buffer>(resolve => socket.once('data', resolve)); socket.write('echo-check'); expect((await data).toString()).toBe('echo-check')
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    expect((await f.call(PHONE_LOGOUT, { method: 'POST', headers: { cookie } })).status).toBe(303); await closed
    expect((await f.call('/api/qqbot/library', { headers: { cookie } })).status).toBe(401)
    await expect(upgrade(f.gateway, cookie)).rejects.toThrow('401')
  })
  it('登录期限到达会断开已有长连接，关闭入口释放端口', async () => {
    let now = Date.now(); const f = await fixture({ now: () => now, sessionMs: 1000 }); const { cookie } = await f.login()
    const socket = await upgrade(f.gateway, cookie)
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    now += 1001
    expect((await f.call('/api/qqbot/library', { headers: { cookie } })).status).toBe(401); await closed
    await f.gateway.close()
    await expect(f.call('/')).rejects.toThrow()
  })
  it('等待本机认证期间退出，不得建立迟到的代理请求', async () => {
    let resolve!: (cookie: string) => void
    const f = await fixture({ authenticate: () => new Promise<string>(done => { resolve = done }) }); const { cookie } = await f.login()
    const pending = f.call('/api/qqbot/library', { headers: { cookie } })
    await new Promise(done => setTimeout(done, 30))
    await f.call(PHONE_LOGOUT, { method: 'POST', headers: { cookie } }); resolve('owner-cookie=server-only')
    expect((await pending).status).toBe(401); expect(f.seen).toHaveLength(0)
  })
})


describe('Tailscale HTTPS 反向代理', () => {
  it('远程登录使用 Secure Cookie，严格校验 HTTPS Host/Origin 并撤销登录', async () => {
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(r => probe.close(() => r()))
    const f = await fixture()
    const origin = 'https://desktop.test-net.ts.net'
    const gateway = await createGateway({ host: '127.0.0.1', port, upstream: f.upstream, externalOrigin: origin,
      accessCode: 'remote-test-code', authenticate: async () => 'owner=test' })
    dispose.push(() => gateway.close())
    const call = (path: string, method = 'GET', extra: Record<string, string> = {}, body = '') => new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { host: new URL(origin).host, origin, ...extra } }, res => {
        let data = ''; res.on('data', chunk => { data += chunk }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }))
      }); req.on('error', reject); req.end(body)
    })
    expect((await call(PHONE_LOGIN)).status).toBe(200)
    expect((await call(PHONE_LOGIN, 'GET', { origin: 'http://desktop.test-net.ts.net' })).status).toBe(403)
    expect((await call(PHONE_LOGIN, 'GET', { host: `127.0.0.1:${port}` })).status).toBe(403)
    expect((await call(PHONE_LOGIN, 'GET', { host: 'evil.invalid', 'x-forwarded-host': new URL(origin).host })).status).toBe(403)
    const login = await call(PHONE_LOGIN, 'POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'code=remote-test-code')
    expect(login.status).toBe(303); expect(login.headers['set-cookie']![0]).toContain('; Secure')
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!
    expect((await call('/', 'GET', { cookie })).body).toContain('qqbot-phone')
    expect((await call('/api/data', 'POST', { cookie }, 'hello')).status).toBe(200)
    expect(f.seen.at(-1)!.headers.cookie).toBe('owner=test')
    const socket = await upgrade(gateway, cookie, `http://127.0.0.1:${port}`)
    socket.destroy()
    expect((await call(PHONE_PATH, 'GET', { cookie })).status).toBe(403)
    expect((await call(PHONE_LOGOUT, 'POST', { cookie })).status).toBe(303)
    expect((await call('/api/data', 'GET', { cookie })).status).toBe(401)
    await expect(createGateway({ host: '192.168.1.20', port: 0, upstream: f.gateway.url, externalOrigin: origin,
      accessCode: 'test-code', authenticate: async () => '' })).rejects.toThrow('回环')
  })
})
