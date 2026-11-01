/**
 * 本人手机到现有 DSH Web 载体的认证代理，不启动第二套 DSH。
 * 参考本工作区 dsh-lan-web / dsh-qq-skin vendor/lan-web（MIT），按新插件重写。
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { PHONE_LOGIN, PHONE_LOGOUT, PHONE_PATH } from '../phone-types.ts'
import { loginPage } from './views.ts'

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}
const loopback = (address: string) => isIP(address) === 4 && address.startsWith('127.')
export const validCode = (code: unknown): code is string => typeof code === 'string' && /^[\x21-\x7e]{8,128}$/.test(code)
const hash = (text: string) => createHash('sha256').update(text).digest()
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const json = (res: ServerResponse, status: number, message: string) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ message }))
}
interface Login { expires: number; streams: Set<() => void> }
export interface GatewayOptions {
  host: string; port: number; upstream: string; accessCode: string
  authenticate(): Promise<string>
  externalOrigin?: string
  sessionMs?: number
  now?: () => number
}
export interface PhoneGateway { url: string; close(): Promise<void> }

export async function createGateway(options: GatewayOptions): Promise<PhoneGateway> {
  const { host, port, accessCode, authenticate, now = Date.now, sessionMs = 12 * 60 * 60 * 1000 } = options
  if (!isPrivateAddress(host) && !loopback(host)) throw new Error('请选择一个本机局域网。')
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !validCode(accessCode)) throw new Error('端口或访问码无效。')
  if (options.externalOrigin && (host !== '127.0.0.1' || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(options.externalOrigin))) throw new Error('远程入口需要本机回环和 Tailscale HTTPS 地址。')
  const target = new URL(options.upstream)
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('DSH 需要提供本机 HTTP 页面入口。')
  const sessions = new Map<string, Login>(), attempts = new Map<string, { count: number; until: number }>()
  const sockets = new Set<Duplex>(), pending = new Set<ReturnType<typeof httpRequest>>()
  const cookieName = `qqbot_phone_${port}`
  let origin = '', closed = false, cookiePromise: Promise<string> | undefined
  const cookieHeader = (token: string, age: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.externalOrigin ? '; Secure' : ''}`
  const trusted = (req: IncomingMessage) => (!options.externalOrigin || ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) && req.headers.host === new URL(origin).host
    && req.headers['sec-fetch-site'] !== 'cross-site' && (req.headers.origin === undefined || req.headers.origin === origin)
  const revoke = (key: string) => { const login = sessions.get(key); sessions.delete(key); for (const stop of login?.streams ?? []) stop() }
  const clean = () => {
    for (const [key, login] of sessions) if (login.expires <= now()) revoke(key)
    for (const [ip, attempt] of attempts) if (attempt.until <= now()) attempts.delete(ip)
  }
  const session = (req: IncomingMessage): Login | undefined => {
    clean()
    const values = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`))
    if (values.length !== 1) return undefined
    return sessions.get(hash(values[0]!.slice(cookieName.length + 1)).toString('hex'))
  }
  const alive = (login: Login) => !closed && [...sessions.values()].includes(login) && login.expires > now()
  const secret = () => cookiePromise ??= Promise.resolve().then(authenticate).then(value => {
    if (!value || /[\r\n]/.test(value)) throw new Error('DSH 本机认证失败。')
    return value
  }).catch(error => { cookiePromise = undefined; throw error })
  const headers = (req: IncomingMessage, cookie: string, upgrade = false): OutgoingHttpHeaders => {
    const out: OutgoingHttpHeaders = {}
    const connection = (req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim())
    for (const [key, value] of Object.entries(req.headers)) {
      if (!hop.has(key) && !connection.includes(key) && !['host', 'origin', 'cookie', 'authorization', 'forwarded', 'accept-encoding'].includes(key)
        && !key.startsWith('x-forwarded-') && !key.startsWith('x-dsh-') && !key.startsWith('sec-fetch-')) out[key] = value
    }
    out.host = target.host; out.cookie = cookie; out['accept-encoding'] = 'identity'; out['x-qqbot-phone-proxy'] = '1'
    if (req.headers.origin) out.origin = target.origin
    if (upgrade) { out.connection = 'Upgrade'; out.upgrade = 'websocket' }
    return out
  }
  const redirect = (res: ServerResponse, location: string, cookie?: string) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...cookie ? { 'set-cookie': cookie } : {} }); res.end()
  }
  const html = (res: ServerResponse, status: number, error = '') => {
    // 同源表单 POST 需要保留 Origin；no-referrer 会让浏览器发送 Origin: null。
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' })
    res.end(loginPage(error))
  }
  async function proxy(req: IncomingMessage, res: ServerResponse, login: Login): Promise<void> {
    const cookie = await secret()
    if (!alive(login) || res.destroyed) { if (!res.destroyed) json(res, 401, '登录已失效。'); return }
    const outgoing = httpRequest(new URL(req.url!, target), { method: req.method, headers: headers(req, cookie) })
    const abort = () => outgoing.destroy()
    pending.add(outgoing); login.streams.add(abort)
    res.on('close', abort); req.on('aborted', abort)
    outgoing.on('close', () => { pending.delete(outgoing); login.streams.delete(abort); res.off('close', abort); req.off('aborted', abort) })
    outgoing.on('error', () => { if (!res.headersSent) json(res, 502, 'DSH 暂时不可用，请稍后重试。'); else res.destroy() })
    outgoing.on('response', upstream => {
      if (upstream.statusCode === 401) cookiePromise = undefined
      const index = upstream.statusCode === 200 && ['/', '/index.html'].includes(new URL(req.url!, target).pathname) && String(upstream.headers['content-type']).includes('text/html')
      const result: OutgoingHttpHeaders = {}
      for (const [key, value] of Object.entries(upstream.headers)) if (!hop.has(key) && key !== 'set-cookie' && (!index || !['content-length', 'etag'].includes(key))) result[key] = value
      result['cache-control'] = 'no-store'; result['referrer-policy'] = 'same-origin'; result['x-content-type-options'] = 'nosniff'
      if (typeof result.location === 'string') {
        try { const dest = new URL(result.location, target); result.location = dest.origin === target.origin && !dest.searchParams.has('token') ? dest.pathname + dest.search + dest.hash : '/' }
        catch { result.location = '/' }
      }
      upstream.on('aborted', () => res.destroy()); upstream.on('error', () => res.destroy())
      if (index) {
        // 仅标记入口；布局仍由客户端插件在 QQ 会话内挂载，标准会话不加样式。
        const chunks: Buffer[] = []; let size = 0
        upstream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) { outgoing.destroy(); res.destroy() } else chunks.push(chunk) })
        upstream.on('end', () => {
          if (res.destroyed) return
          res.writeHead(200, result)
          res.end(Buffer.concat(chunks).toString('utf8').replace(/<head(?:\s[^>]*)?>/i, open => `${open}<meta name="qqbot-phone" content="local">`))
        })
        return
      }
      res.writeHead(upstream.statusCode ?? 502, result); upstream.pipe(res)
    })
    req.pipe(outgoing)
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!trusted(req)) return json(res, 403, '入口地址或请求来源不匹配。')
    // 一次规范化后检查，拒绝能绕过管理路径隔离的编码斜杠和点路径。
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\r\n]/.test(req.url)) return json(res, 400, '请求地址无效。')
    const url = new URL(req.url, origin)
    let path: string
    try { path = decodeURIComponent(req.url.split('?')[0]!) } catch { return json(res, 400, '请求地址无效。') }
    if (path !== url.pathname || path.includes('\\') || path.startsWith('//') || path.split('/').some(p => p === '.' || p === '..')) return json(res, 400, '请求地址无效。')
    const login = session(req)
    if (path === PHONE_LOGIN) {
      if (req.method === 'GET') { if (login) redirect(res, '/'); else html(res, 200); return }
      if (req.method !== 'POST') return json(res, 405, '请使用登录表单。')
      const ip = req.socket.remoteAddress ?? ''
      if (attempts.size >= 256 && !attempts.has(ip)) return json(res, 429, '尝试过多，请稍后再试。')
      const attempt = attempts.get(ip) ?? { count: 0, until: now() + 5 * 60 * 1000 }
      if (attempt.count >= 8) return html(res, 429, '尝试过多，请在 5 分钟后再试。')
      attempts.set(ip, attempt)
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return json(res, 415, '登录格式无效。')
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of req) { size += chunk.length; if (size > 1024) return json(res, 413, '登录内容过长。'); chunks.push(Buffer.from(chunk)) }
      if (closed) return json(res, 503, '手机连接已关闭。')
      const codes = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).getAll('code')
      if (codes.length !== 1 || !timingSafeEqual(hash(codes[0]!), hash(accessCode))) { attempt.count++; attempts.set(ip, attempt); return html(res, 401, '访问码不正确，请查看电脑上的手机连接。') }
      if (sessions.size >= 64) return json(res, 503, '登录设备过多，请先退出其他设备。')
      attempts.delete(ip)
      const token = randomBytes(32).toString('base64url')
      sessions.set(hash(token).toString('hex'), { expires: now() + sessionMs, streams: new Set() })
      return redirect(res, '/', cookieHeader(token, Math.floor(sessionMs / 1000)))
    }
    if (!login) { if (req.method === 'GET' && (path === '/' || path === '/index.html')) redirect(res, PHONE_LOGIN); else json(res, 401, '请先登录手机连接。'); return }
    if (path === PHONE_LOGOUT) {
      if (req.method !== 'POST') return json(res, 405, '请使用退出按钮。')
      for (const [key, value] of sessions) if (value === login) revoke(key)
      return redirect(res, PHONE_LOGIN, cookieHeader('', 0))
    }
    // 入口管理只在电脑本机，主机认证令牌不下发到手机。
    if (path.startsWith('/__qqbot_phone/') || path === '/connect' || path === PHONE_PATH || path.startsWith(`${PHONE_PATH}/`) || url.searchParams.has('token')) return json(res, 403, '请在电脑上管理手机连接。')
    await proxy(req, res, login)
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 502, '手机连接暂时不可用。'); else res.destroy() }) })
  server.headersTimeout = 15_000; server.requestTimeout = 120_000
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const login = session(req)
    if (!trusted(req) || !login || req.url !== '/api/remote.mux' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    void (async () => {
      const cookie = await secret()
      if (!alive(login) || socket.destroyed) { socket.destroy(); return }
      const outgoing = httpRequest(new URL(req.url!, target), { headers: headers(req, cookie, true) })
      let peer: Duplex | undefined
      const abort = () => { outgoing.destroy(); peer?.destroy(); socket.destroy() }
      const done = () => { pending.delete(outgoing); login.streams.delete(abort) }
      pending.add(outgoing); login.streams.add(abort)
      socket.on('close', () => { abort(); done() }); socket.on('error', abort)
      outgoing.on('error', () => { abort(); done() })
      outgoing.on('response', response => { response.resume(); done(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
      outgoing.on('upgrade', (response, upstream, upstreamHead) => {
        if (!alive(login) || socket.destroyed) { upstream.destroy(); abort(); done(); return }
        peer = upstream
        const fields = Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${fields.join('\r\n')}\r\n\r\n`)
        if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead)
        peer.on('error', abort); peer.on('close', () => { done(); socket.destroy() })
        socket.pipe(peer).pipe(socket)
      })
      outgoing.end()
    })().catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
  origin = options.externalOrigin ?? `http://${host}:${(server.address() as { port: number }).port}`
  const timer = setInterval(clean, 1000); timer.unref()
  return { url: `${origin}/`, async close() {
    closed = true; clearInterval(timer)
    for (const key of sessions.keys()) revoke(key)
    for (const req of pending) req.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}
