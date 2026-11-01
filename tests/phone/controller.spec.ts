import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneController, type ControllerOptions } from '../../src/phone/controller.ts'
import { dshHome } from '../../src/storage.ts'
import type { GatewayOptions } from '../../src/phone/gateway.ts'

const controllers: PhoneController[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose() })
function fixture(override: Partial<ControllerOptions> = {}) {
  const file = join(mkdtempSync(join(dshHome(), 'phone-case-')), 'settings.json')
  let available = [{ address: '192.168.1.20', name: 'Wi-Fi' }]
  const close = vi.fn(async () => {})
  const create = vi.fn(async (options: GatewayOptions) => ({ url: `http://${options.host}:${options.port}/`, close }))
  const controller = new PhoneController({ file, networks: () => available, upstream: () => 'http://127.0.0.1:3000/', authenticate: async () => 'owner=secret', warn: () => {}, create, ...override })
  controllers.push(controller)
  return { controller, file, create, close, network: (next: typeof available) => { available = next }, action: (action: 'start' | 'stop') => controller.action({ action, revision: controller.snapshot().revision }) }
}
describe('手机入口生命周期', () => {
  it('首次默认关闭，读设置不启动；启动后只保存本插件设置，重载保留访问码', async () => {
    const f = fixture(); await f.controller.initialize()
    expect(f.create).not.toHaveBeenCalled(); expect(f.controller.snapshot().enabled).toBe(false)
    const code = f.controller.snapshot().accessCode
    await f.action('start'); expect(f.controller.snapshot().running).toBe(true)
    expect(JSON.parse(readFileSync(f.file, 'utf8')).accessCode).toBe(code)
    await f.controller.dispose()
    const second = fixture({ file: f.file }); await second.controller.initialize(); expect(second.create).toHaveBeenCalledOnce()
    expect(second.controller.snapshot().accessCode).toBe(code)
  })
  it('启动失败可换端口重试；运行中禁止改码，关闭后保存不会自动启动', async () => {
    const f = fixture()
    f.create.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))
    await expect(f.action('start')).rejects.toThrow('端口已被占用')
    await f.controller.action({ action: 'save', revision: f.controller.snapshot().revision, address: '192.168.1.20', port: 3089, accessCode: 'new-phone-code' })
    expect(f.controller.snapshot().enabled).toBe(false); expect(f.create).toHaveBeenCalledTimes(1)
    await f.action('start')
    await expect(f.controller.action({ action: 'save', revision: f.controller.snapshot().revision, address: '', port: 3090, accessCode: 'other-code' })).rejects.toThrow('先关闭')
    await f.action('stop'); expect(f.close).toHaveBeenCalledOnce(); expect(f.controller.snapshot().running).toBe(false)
  })
  it('多网络需选择，网络消失不静默切换；旧页面的请求不会覆盖新设置', async () => {
    const f = fixture(); f.network([{ name: 'Wi-Fi', address: '192.168.1.20' }, { name: '有线网络', address: '10.0.0.20' }])
    await expect(f.action('start')).rejects.toThrow('选择')
    const revision = f.controller.snapshot().revision
    await f.controller.action({ action: 'save', revision, address: '10.0.0.20', port: 3088, accessCode: 'test-code' })
    await expect(f.controller.action({ action: 'start', revision })).rejects.toThrow('另一页面')
    f.network([{ name: 'Wi-Fi', address: '192.168.1.20' }])
    await expect(f.action('start')).rejects.toThrow('选择')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('全清理撤销连接并换码恢复默认；停用后禁止继续启动', async () => {
    const f = fixture(); await f.action('start'); const oldCode = f.controller.snapshot().accessCode
    f.controller.prepareReset(); await f.controller.reset()
    expect(f.close).toHaveBeenCalledOnce(); await expect(f.action('start')).rejects.toThrow('不可用')
    f.controller.reload(); expect(f.controller.snapshot()).toMatchObject({ enabled: false, running: false, port: 3088 })
    expect(f.controller.snapshot().accessCode).not.toBe(oldCode)
    await f.controller.dispose(); await expect(f.action('start')).rejects.toThrow('不可用')
  })
  it('候选入口已建立但保存失败时关闭它，不留下隐藏监听', async () => {
    const f = fixture({ file: join(dshHome(), 'blocked', 'settings.json') })
    writeFileSync(join(dshHome(), 'blocked'), 'not-a-directory')
    await expect(f.action('start')).rejects.toThrow()
    expect(f.close).toHaveBeenCalledOnce(); expect(f.controller.snapshot().running).toBe(false)
  })
  it('远程模式无局域网也能启动，监听回环并传入 HTTPS 地址；关闭撤销 Serve', async () => {
    const remote = { origin: 'https://desktop.test.ts.net', start: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const f = fixture({ tailscale: async () => remote }); f.network([])
    await f.controller.action({ action: 'save', revision: f.controller.snapshot().revision, mode: 'tailscale', address: '', port: 3088, accessCode: 'remote-test-code' })
    await f.action('start')
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', externalOrigin: remote.origin }))
    expect(remote.start).toHaveBeenCalledOnce()
    await f.action('stop'); expect(remote.close).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce()
  })
  it('HTTPS 启动失败时关闭候选网关，不保存自动启动', async () => {
    const remote = { origin: 'https://desktop.test.ts.net', start: vi.fn(async () => { throw new Error('HTTPS 未开启') }), close: vi.fn(async () => {}) }
    const f = fixture({ tailscale: async () => remote })
    await f.controller.action({ action: 'save', revision: f.controller.snapshot().revision, mode: 'tailscale', address: '', port: 3088, accessCode: 'remote-test-code' })
    await expect(f.action('start')).rejects.toThrow('HTTPS')
    expect(f.close).toHaveBeenCalledOnce(); expect(remote.close).toHaveBeenCalledOnce()
    expect(f.controller.snapshot()).toMatchObject({ running: false, enabled: false })
  })
  it('损坏配置不启动、不覆盖旧文件', async () => {
    const file = join(dshHome(), 'phone', 'settings.json'); mkdirSync(join(dshHome(), 'phone'), { recursive: true }); writeFileSync(file, '{broken')
    const f = fixture({ file }); await f.controller.initialize()
    expect(f.controller.snapshot().running).toBe(false); expect(f.create).not.toHaveBeenCalled()
    expect(readFileSync(file + '.corrupt', 'utf8')).toBe('{broken')
  })
})
