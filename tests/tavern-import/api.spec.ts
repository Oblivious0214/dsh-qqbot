import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Maintenance } from '../../src/maintenance.ts'
import { JailbreakStore } from '../../src/presets.ts'
import { RoleLibrary } from '../../src/roles.ts'
import { createImportHandler, directBody, registerTavernImport } from '../../src/tavern-import/api.ts'
import { extract } from '../../src/tavern-import/extract.ts'
import { defaultSelections } from '../../src/tavern-import/static.ts'
import { TavernImportStore } from '../../src/tavern-import/store.ts'
import { LIMITS, TAVERN_IMPORT_PATH } from '../../src/tavern-import/types.ts'
import { jsonBytes } from '../../src/tavern-import/util.ts'
import { input, payload } from './fixtures.ts'
const dirs: string[] = []
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'qqbot-tavern-api-')); dirs.push(home)
  const dir = join(home, 'qqbot'); mkdirSync(dir)
  const data = { roles: new RoleLibrary(join(dir, 'roles'), () => {}), presets: JailbreakStore.at(dir, () => {}) }
  return { home, dir, data, maintenance: new Maintenance(home, () => {}) }
}
const request = (body: unknown, headers?: HeadersInit): Request => new Request('http://localhost' + TAVERN_IMPORT_PATH, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...headers ? { headers } : {} })
afterEach(() => { for (const dir of dirs.splice(0)) {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('qqbot-tavern-api-')) throw new Error('临时路径不符合预期')
  rmSync(dir, { recursive: true, force: true })
} })
describe('isolated import route', () => {
  it('echoes revision/request, extracts without disk writes and exposes local direct adoption', async () => {
    const { dir, data } = setup(), store = new TavernImportStore(data), handler = createImportHandler(() => store)
    const req = input(), response = await handler(request({ action: 'extract', input: req, requestId: 'extract-1', revision: 7 }))
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ requestId: 'extract-1', revision: 7, extraction: { kind: 'role' } })
    expect(readdirSync(dir)).toEqual([]); expect(directBody(req, defaultSelections(extract(req)))).toContain('小岚')
    expect((await handler(new Request('http://localhost' + TAVERN_IMPORT_PATH))).headers.get('cache-control')).toBe('no-store')
  })
  it('previews and commits while preserving metadata and returning categorized errors', async () => {
    const { data } = setup(), store = new TavernImportStore(data), handler = createImportHandler(() => store), p = payload()
    const call = (action: string, extra: object = {}) => handler(request({ action, input: p, requestId: 'p', revision: 'rev', ...extra }))
    const preview = (await (await call('preview')).json() as any).preview
    expect(await (await call('commit', { preview })).json()).toMatchObject({ requestId: 'p', revision: 'rev', saved: { kind: 'role' } })
    const bad = await handler(request({ action: 'extract', input: {}, requestId: 'x', revision: 1 })); expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'malformed' })
    expect((await handler(request('{'))).status).toBe(400)
    expect((await call('missing')).status).toBe(400)
  })
  it('rejects oversized envelopes by both declared and actual bytes before parsing', async () => {
    const { data } = setup(), store = new TavernImportStore(data), handler = createImportHandler(() => store)
    expect((await handler(request('{}', { 'content-length': String(LIMITS.envelope + 1) }))).status).toBe(413)
    const bytes = new Uint8Array(1024 ** 2).fill(32)
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 65; i++) controller.enqueue(bytes); controller.close() } })
    const r = new Request('http://localhost', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect((await handler(r)).status).toBe(413)
  })
  it('drops requests closed or replaced while the body was being read', async () => {
    const { data } = setup(); let store = new TavernImportStore(data)
    const handler = createImportHandler(() => store), r = request({ action: 'preview', input: payload(), requestId: 'x', revision: 1 })
    const pending = handler(r); store = new TavernImportStore(data)
    expect(await (await pending).json()).toMatchObject({ code: 'cancelled' })
    const controller = new AbortController(); controller.abort()
    const aborted = new Request(request({ action: 'extract', input: input(), requestId: 'x', revision: 1 }), { signal: controller.signal })
    expect((await handler(aborted)).status).toBe(499)
  })
  it('counts the full response envelope and returns a specific overflow error', async () => {
    const { data } = setup(), req = input()
    const store = new TavernImportStore(data), stableHandler = createImportHandler(() => store)
    const limits = LIMITS as { normalized: number }, previous = limits.normalized
    try {
      limits.normalized = jsonBytes(extract(req)) + 10
      const response = await stableHandler(request({ action: 'extract', input: req, requestId: 'x'.repeat(128), revision: 1 }))
      expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ code: 'too-large', message: expect.stringContaining('响应超过') })
    } finally { limits.normalized = previous }
    expect((await stableHandler(request({ action: 'extract', input: req, requestId: 'x', revision: 'v'.repeat(129) }))).status).toBe(400)
  })
  it('registers one exact owner route with lifecycle, cleanup generation and maintenance guard', async () => {
    const { dir, data, maintenance } = setup(), root = new Context(), routes = new Map<string, { fetch: (r: Request) => Promise<Response> }>()
    root.provide('connection', { fetch: { register: (route: any) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } } })
    const fiber = await root.plugin({ apply: (ctx: Context) => registerTavernImport(ctx, data, maintenance) })
    const route = routes.get(TAVERN_IMPORT_PATH)!, call = (action: string, extra = {}) => route.fetch(request({ action, input: payload(), requestId: 'x', revision: 1, ...extra }, { 'x-qqbot-data-epoch': maintenance.view().dataEpoch }))
    try {
      const preview = (await (await call('preview')).json() as any).preview
      await maintenance.clear('cache'); expect((await call('commit', { preview })).status).toBe(200)
      await maintenance.clear('cache'); expect(existsSync(join(dir, 'import-backups'))).toBe(true)
      const oldEpoch = maintenance.view().dataEpoch
      await maintenance.clear('all')
      data.presets.reload(); data.roles.reload()
      expect((await route.fetch(request({ action: 'commit' }, { 'x-qqbot-data-epoch': oldEpoch }))).status).toBe(409)
      expect((await call('commit', { preview })).status).toBe(409)
      expect((await call('preview')).status).toBe(200)
    } finally { await fiber.dispose() }
    expect(routes.size).toBe(0)
    expect((await route.fetch(request({ action: 'extract', input: input(), requestId: 'x', revision: 1 }))).status).toBe(499)
  })
  it('invalidates old tokens but keeps a usable generation after credential cleanup fails', async () => {
    const { data, maintenance } = setup(), root = new Context(); let route: any
    root.provide('connection', { fetch: { register: (r: any) => { route = r; return () => {} } } })
    const fiber = await root.plugin({ apply: (ctx: Context) => registerTavernImport(ctx, data, maintenance) })
    const call = (action: string, extra = {}) => route.fetch(request({ action, input: payload(), requestId: 'failure', revision: 1, ...extra }))
    const unregister = maintenance.register({ credentials: async () => { throw new Error('simulated credentials failure') } })
    const unregisterReload = maintenance.register({ reload: () => { data.presets.reload(); data.roles.reload() } })
    try {
      const old = (await (await call('preview')).json()).preview
      await expect(maintenance.clear('all')).rejects.toThrow('simulated credentials failure')
      expect((await call('commit', { preview: old })).status).toBe(409)
      const response = await call('preview'); expect(response.status).toBe(200)
      const fresh = (await response.json()).preview
      expect((await call('commit', { preview: fresh })).status).toBe(200)
      unregister(); await maintenance.clear('all')
      expect((await call('commit', { preview: fresh })).status).toBe(409)
      expect((await call('preview')).status).toBe(200)
    } finally { unregister(); unregisterReload(); await fiber.dispose() }
  })
})
