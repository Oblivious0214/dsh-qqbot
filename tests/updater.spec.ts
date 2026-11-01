import { describe, it, expect, vi } from 'vitest'
import { installUpdate, releaseUpdate, newer, INSTALL_URL, type NativeManager } from '../src/updater.ts'

const url = 'https://github.com/Oblivious0214/dsh-qqbot/releases/download/v0.8.0/dsh-qqbot-0.8.0.tgz'
const release = { version: '0.8.0', url, notes: '', page: '' }
const payload = { tag_name: 'v0.8.0', assets: [{ name: 'dsh-qqbot-0.8.0.tgz', browser_download_url: url }] }
function manager() {
  const m = { listBundles: vi.fn().mockResolvedValue([{ name: 'dsh-qqbot', version: '0.7.6', source: '/old.tgz', enabled: true, availability: 'profile' }]),
    removeBundle: vi.fn().mockResolvedValue({ application: 'applied' }),
    installBundle: vi.fn().mockImplementation(async (spec: string) => {
      const version = spec === INSTALL_URL ? '0.8.0' : '0.7.6'
      m.listBundles.mockResolvedValue([{ name: 'dsh-qqbot', version, source: spec, enabled: true, availability: 'profile' }])
      return { application: 'applied', version }
    }) } satisfies NativeManager
  return m
}
describe('Release 更新', () => {
  it('按数字比较版本，不降级，正式版高于同版预发布', () => {
    expect(newer('0.10.0', '0.9.0')).toBe(true)
    expect(newer('0.8.0', '0.8.0')).toBe(false)
    expect(newer('0.8.0', '0.8.0-rc.1')).toBe(true)
    expect(newer('0.8.0', '1.0.0')).toBe(false)
  })
  it('从正式发布判断更新，安装统一使用仓库主页，不依赖附件或标签链接', () => {
    expect(releaseUpdate(payload, '0.7.6')?.url).toBe(INSTALL_URL)
    expect(releaseUpdate({ ...payload, assets: [] }, '0.7.6')?.url).toBe(INSTALL_URL)
    expect(releaseUpdate({ ...payload, assets: [{ browser_download_url: 'https://evil.test/file.tgz' }] }, '0.7.6')?.url).toBe(INSTALL_URL)
    expect(releaseUpdate({ ...payload, prerelease: true }, '0.7.6')).toBeUndefined()
    expect(releaseUpdate({ ...payload, draft: true }, '0.7.6')).toBeUndefined()
  })
  it('热重载先备份、移除，再原生安装，保留选择状态', async () => {
    const m = manager(), order: string[] = []
    m.removeBundle.mockImplementation(async () => { order.push('remove'); return { application: 'applied' } })
    const install = m.installBundle.getMockImplementation()!
    m.installBundle.mockImplementation(async spec => { order.push('install'); return install(spec) })
    await installUpdate(m, release, true, async () => { order.push('backup') }, () => {})
    expect(order).toEqual(['backup', 'remove', 'install'])
    expect(m.installBundle).toHaveBeenCalledWith(INSTALL_URL, { enabled: true })
  })
  it('无热重载直接安装并透传重启结果', async () => {
    const m = manager(), install = m.installBundle.getMockImplementation()!
    m.installBundle.mockImplementation(async spec => ({ ...await install(spec), application: 'restart-required' }))
    expect((await installUpdate(m, release, false, async () => {}, () => {})).application).toBe('restart-required')
    expect(m.removeBundle).not.toHaveBeenCalled()
  })
  it('备份失败不触碰安装', async () => {
    const m = manager()
    await expect(installUpdate(m, release, true, async () => { throw Error('backup') }, () => {})).rejects.toThrow('backup')
    expect(m.removeBundle).not.toHaveBeenCalled(); expect(m.installBundle).not.toHaveBeenCalled()
  })
  it('安装失败通过原生安装恢复原来源', async () => {
    const m = manager(); m.installBundle.mockResolvedValueOnce({ application: 'failed' })
    await expect(installUpdate(m, release, true, async () => {}, () => {})).rejects.toThrow('已恢复旧版本')
    expect(m.installBundle).toHaveBeenLastCalledWith('/old.tgz', { enabled: true })
  })
  it('恢复失败明确报告', async () => {
    const m = manager(); m.installBundle.mockResolvedValue({ application: 'failed' })
    await expect(installUpdate(m, release, true, async () => {}, () => {})).rejects.toThrow('恢复失败')
  })
  it('主分支已比检查时更新时接受实际安装版本，旧缓存 tgz 不再作为安装来源', async () => {
    const m = manager()
    m.installBundle.mockImplementationOnce(async spec => {
      m.listBundles.mockResolvedValue([{ name: 'dsh-qqbot', version: '0.9.0', source: spec, enabled: false, availability: 'profile' }])
      return { application: 'applied', version: '0.9.0' }
    })
    expect((await installUpdate(m, release, false, async () => {}, () => {})).version).toBe('0.9.0')
    expect(m.installBundle).toHaveBeenCalledWith(INSTALL_URL, { enabled: true })
  })
  it('宿主不返回 version 时仍以安装清单核对版本', async () => {
    const m = manager(), install = m.installBundle.getMockImplementation()!
    m.installBundle.mockImplementation(async spec => { await install(spec); return { application: 'applied' } })
    expect((await installUpdate(m, release, false, async () => {}, () => {})).version).toBe('0.8.0')
  })
  it('主分支仍旧时拒绝成功并从备份恢复，保留宿主的失败原因', async () => {
    const m = manager()
    m.installBundle.mockResolvedValueOnce({ application: 'failed', error: { diagnostic: 'GitHub 连接失败', code: 'operation-error' } })
    await expect(installUpdate(m, release, false, async () => '/backup/plugin', () => {})).rejects.toThrow('GitHub 连接失败')
    expect(m.installBundle).toHaveBeenLastCalledWith('/backup/plugin', { enabled: true })
  })
  it('安装结果声称新版但实际还是旧版时拒绝，并恢复本地备份', async () => {
    const m = manager(); m.installBundle.mockResolvedValueOnce({ application: 'applied', version: '0.8.0' })
    await expect(installUpdate(m, release, false, async () => '/backup/plugin', () => {})).rejects.toThrow('低于发布版本')
  })
  it('保留停用状态', async () => {
    const m = manager()
    m.listBundles.mockResolvedValueOnce([{ name: 'dsh-qqbot', version: '0.7.6', source: '/old.tgz', enabled: false, availability: 'profile' }])
    await installUpdate(m, release, false, async () => {}, () => {})
    expect(m.installBundle).toHaveBeenCalledWith(INSTALL_URL, { enabled: false })
  })
  it('并发期间已升级时拒绝重复安装', async () => {
    const m = manager(); m.listBundles.mockResolvedValue([{ name: 'dsh-qqbot', version: '0.8.0', source: url, enabled: true, availability: 'profile' }])
    await expect(installUpdate(m, release, true, async () => {}, () => {})).rejects.toThrow('重新检查')
    expect(m.installBundle).not.toHaveBeenCalled()
  })
})
