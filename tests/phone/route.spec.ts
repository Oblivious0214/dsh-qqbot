import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneController } from '../../src/phone/controller.ts'
import { phoneResponse } from '../../src/phone/route.ts'
import { checkPhoneMode } from '../../src/client/phone-mode.ts'
import { dshHome } from '../../src/storage.ts'

const controllers: PhoneController[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose() })
function fixture(fail = false) {
  const file = join(mkdtempSync(join(dshHome(), 'route-')), 'settings.json')
  const close = vi.fn(async () => {})
  const create = vi.fn(async () => ({ url: 'https://desktop.test.ts.net/', close }))
  const controller = new PhoneController({ file, networks: () => [], upstream: () => 'http://127.0.0.1:3000', authenticate: async () => 'test', warn: () => {}, create,
    tailscale: async () => ({ origin: 'https://desktop.test.ts.net', close, start: async () => { if (fail) throw new Error('HTTPS 未开启') } }),
  })
  controllers.push(controller)
  const request = (body?: object) => phoneResponse(controller, new Request('http://localhost/api/qqbot/phone', body ? { method: 'POST', body: JSON.stringify(body) } : {}))
  const save = () => request({ action: 'save', revision: controller.snapshot().revision, mode: 'tailscale', address: '', port: 3088, accessCode: 'test-code' })
  return { controller, create, close, request, save, file }
}
describe('远程控制真实路由与控制器', () => {
  it('保存响应、启动响应和磁盘配置均保留远程模式', async () => {
    const f = fixture(); const saved = await (await f.save()).json()
    expect(saved.mode).toBe('tailscale'); checkPhoneMode(saved, 'tailscale')
    const started = await f.request({ action: 'start', revision: saved.revision })
    expect(started.status).toBe(200); expect(await started.json()).toMatchObject({ mode: 'tailscale', running: true })
    expect(JSON.parse(readFileSync(f.file, 'utf8')).mode).toBe('tailscale')
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', externalOrigin: 'https://desktop.test.ts.net' }))
  })
  it('启动失败返回真实远程状态，关闭候选入口，允许修改和重试', async () => {
    const f = fixture(true); await f.save()
    const result = await f.request({ action: 'start', revision: f.controller.snapshot().revision })
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ message: 'HTTPS 未开启', state: { mode: 'tailscale', enabled: false, running: false } })
    expect(f.close).toHaveBeenCalled(); expect((await f.save()).status).toBe(200)
  })
  it('过期版本不会启动或覆盖另一页面的设置', async () => {
    const f = fixture(); const old = f.controller.snapshot().revision; await f.save()
    expect((await f.request({ action: 'start', revision: old })).status).toBe(409)
    expect(f.create).not.toHaveBeenCalled()
  })
  it('手机代理不能读取凭据或修改设置，无效请求返回400', async () => {
    const f = fixture()
    expect((await phoneResponse(f.controller, new Request('http://localhost/api/qqbot/phone', { headers: { 'x-qqbot-phone-proxy': '1' } }))).status).toBe(403)
    expect((await f.request({ action: 'save' })).status).toBe(400)
  })
  it('旧后端缺少模式时提示重启，不把远程视为局域网成功', () => {
    const f = fixture(); const { mode: _, ...legacy } = f.controller.snapshot()
    expect(() => checkPhoneMode(legacy, 'tailscale')).toThrow('重启 DSH')
    expect(() => checkPhoneMode(legacy, 'local')).not.toThrow()
  })
  it('后端丢失或返回不同的模式时中断启动', () => {
    const f = fixture()
    expect(() => checkPhoneMode(f.controller.snapshot(), 'tailscale')).toThrow('未保存成功')
  })
})
