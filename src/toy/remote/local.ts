import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ButtplugConnection } from '../client/buttplug.ts'
import { checkMove, type Transport, type TransportState } from '../client/transport.ts'
import { defaultMotion, parseMotion } from '../core/config.ts'
import { defaultActionLibrary } from '../motion-library/builtins.ts'
import { RemoteExecutor } from './executor.ts'
import { RemoteConnector } from './connector.ts'
import { record, remoteAddress, string } from './protocol.ts'

class SimulatedTransport implements Transport {
  readonly kind = 'buttplug' as const
  readonly profile = {}
  state: TransportState = { phase: 'ready', message: '模拟设备', error: '' }
  moves = 0
  subscribe(listener: (state: TransportState) => void) { listener(this.state); return () => {} }
  async connect() { return this.state }
  async move(position: number, duration: number, limits: Parameters<Transport['move']>[2]) {
    checkMove(position, duration, limits); this.moves++; return { remainingMs: duration }
  }
  async stop() {}
  disconnect() {}
}

/** 独立本地服务；调用方显式选择模拟模式或真实 Buttplug，导入模块不会启动。 */
export async function startLocal(options: { dataDir: string; port?: number; simulate?: boolean; allowLoopback?: boolean }) {
  await mkdir(options.dataDir, { recursive: true })
  const tokenFile = join(options.dataDir, 'remote-token.json')
  const settingsFile = join(options.dataDir, 'motion.json')
  let config = defaultMotion()
  try { config = parseMotion(JSON.parse(await readFile(settingsFile, 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本地设备设置损坏，请恢复 motion.json 后重试')
  }
  let saved: { address: string; token: string } | undefined
  try { const raw = record(JSON.parse(await readFile(tokenFile, 'utf8'))); saved = { address: string(raw.address, 2000), token: string(raw.token) } } catch { /* 首次连接。 */ }
  const transport = options.simulate ? new SimulatedTransport() : new ButtplugConnection()
  let pageSeen = 0
  let connector: RemoteConnector | undefined
  const executor = new RemoteExecutor(transport, config, defaultActionLibrary(), undefined, undefined,
    () => { connector?.invalidated() }, () => performance.now() - pageSeen < 5000)
  let address = ''
  let saveError = false
  let saveTask = Promise.resolve()
  let settingsTask = Promise.resolve()
  connector = new RemoteConnector(executor, token => {
    saved = { address, token }
    saveTask = writeFile(tokenFile, JSON.stringify(saved), { mode: 0o600 }).catch(() => { saveError = true })
  }, undefined, options.allowLoopback ?? false)
  const csrf = randomBytes(32).toString('hex')
  let origin = ''
  const html = await readFile(new URL('./control.html', import.meta.url), 'utf8')
  const server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    if (req.headers.host !== new URL(origin).host) { json(403, { error: '来源无效' }); return }
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Set-Cookie', `serveu=${csrf}; HttpOnly; SameSite=Strict; Path=/`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); return
    }
    const cookie = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith('serveu='))?.slice(7) ?? ''
    if (!/^[a-f0-9]{64}$/u.test(cookie) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(csrf))) { json(403, { error: '请重新打开设备页面' }); return }
    if (req.method === 'GET' && req.url === '/state') {
      pageSeen = performance.now()
      json(200, { status: !executor.online && connector!.status === '已接入' ? '未接入' : connector!.status, device: transport.state.message, config,
        ready: transport.state.phase === 'ready', simulated: options.simulate === true, paired: saved !== undefined, address: saved?.address ?? '',
        error: saveError ? '配对凭据保存失败，下次需要重新配对' : transport.state.error }); return
    }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { json(403, { error: '来源无效' }); return }
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new Error('请求过大') }
      const raw = record(JSON.parse(body))
      if (req.url === '/pause') connector!.pause()
      else if (req.url === '/disconnect') { connector!.disconnect(); transport.disconnect() }
      else if (req.url === '/settings') {
        settingsTask = settingsTask.catch(() => {}).then(async () => {
          const next = parseMotion({ ...config, minPosition: raw.minPosition, maxPosition: raw.maxPosition, maxSpeed: raw.maxSpeed })
          await writeFile(settingsFile, JSON.stringify(next), { mode: 0o600 })
          config = next; executor.configure(config)
        })
        await settingsTask
      }
      else if (req.url === '/device') {
        const local = new URL(typeof raw.address === 'string' ? raw.address : 'ws://127.0.0.1:12345')
        if (local.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || local.username || local.password || local.search || local.hash) throw new Error('设备服务须在本机')
        await transport.connect(local.href)
      } else if (req.url === '/connect') {
        if (transport.state.phase !== 'ready') throw new Error('请先连接设备')
        address = remoteAddress(string(raw.address, 2000), options.allowLoopback)
        const pairCode = typeof raw.pairCode === 'string' ? raw.pairCode.trim() : ''
        const credentials = pairCode ? { pairCode } : saved?.address === address ? { token: saved.token } : {}
        connector!.connect(address, '本地设备', credentials)
      } else { json(404, { error: '操作不存在' }); return }
      json(200, { ok: true })
    } catch (error) { json(400, { error: error instanceof Error ? error.message : '操作失败' }) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 18941, '127.0.0.1', resolve) })
  const endpoint = server.address()
  if (endpoint === null || typeof endpoint === 'string') throw new Error('本地入口不可用')
  origin = `http://127.0.0.1:${endpoint.port}`
  return { url: origin, executor, connector, async close() { connector!.disconnect(); executor.dispose(); transport.disconnect(); await saveTask; await new Promise<void>(resolve => server.close(() => resolve())) } }
}
