import { describe, it, expect, vi } from 'vitest'
import { installUpdate, releaseUpdate, newer, type NativeManager } from '../src/updater.ts'

const url = 'https://github.com/Oblivious0214/dsh-qqbot/releases/download/v0.8.0/dsh-qqbot-0.8.0.tgz'
const release = { version: '0.8.0', url, notes: '', page: '' }
const payload = { tag_name: 'v0.8.0', assets: [{ name: 'dsh-qqbot-0.8.0.tgz', browser_download_url: url }] }
function manager() {
  return { listBundles: vi.fn().mockResolvedValue([{ name: 'dsh-qqbot', version: '0.7.6', source: '/old.tgz', enabled: true, availability: 'profile' }]),
    removeBundle: vi.fn().mockResolvedValue({ application: 'applied' }),
    installBundle: vi.fn().mockResolvedValue({ application: 'applied', version: '0.8.0' }) } satisfies NativeManager
}
describe('Release 更新', () => {
  it('按数字比较版本，不降级，正式版高于同版预发布', () => {
    expect(newer('0.10.0', '0.9.0')).toBe(true)
    expect(newer('0.8.0', '0.8.0')).toBe(false)
    expect(newer('0.8.0', '0.8.0-rc.1')).toBe(true)
    expect(newer('0.8.0', '1.0.0')).toBe(false)
  })
  it('只取固定仓库和版本对应的唯一 tgz', () => {
    expect(releaseUpdate(payload, '0.7.6')?.url).toBe(url)
    expect(() => releaseUpdate({ ...payload, assets: [] }, '0.7.6')).toThrow('安装包')
    expect(() => releaseUpdate({ ...payload, assets: [{ ...payload.assets[0], browser_download_url: 'https://evil.test/file.tgz' }] }, '0.7.6')).toThrow('地址')
    expect(releaseUpdate({ ...payload, prerelease: true }, '0.7.6')).toBeUndefined()
  })
  it('热重载先备份、移除，再原生安装，保留选择状态', async () => {
    const m = manager(), order: string[] = []
    m.removeBundle.mockImplementation(async () => { order.push('remove'); return { application: 'applied' } })
    m.installBundle.mockImplementation(async () => { order.push('install'); return { application: 'applied', version: '0.8.0' } })
    await installUpdate(m, release, true, async () => { order.push('backup') }, () => {})
    expect(order).toEqual(['backup', 'remove', 'install'])
    expect(m.installBundle).toHaveBeenCalledWith(url, { enabled: true })
  })
  it('无热重载直接安装并透传重启结果', async () => {
    const m = manager(); m.installBundle.mockResolvedValue({ application: 'restart-required', version: '0.8.0' })
    expect((await installUpdate(m, release, false, async () => {}, () => {})).application).toBe('restart-required')
    expect(m.removeBundle).not.toHaveBeenCalled()
  })
  it('备份失败不触碰安装', async () => {
    const m = manager()
    await expect(installUpdate(m, release, true, async () => { throw Error('backup') }, () => {})).rejects.toThrow('backup')
    expect(m.removeBundle).not.toHaveBeenCalled(); expect(m.installBundle).not.toHaveBeenCalled()
  })
  it('安装失败通过原生安装恢复原来源', async () => {
    const m = manager(); m.installBundle.mockResolvedValueOnce({ application: 'failed' }).mockResolvedValueOnce({ application: 'applied' })
    await expect(installUpdate(m, release, true, async () => {}, () => {})).rejects.toThrow('已恢复旧版本')
    expect(m.installBundle).toHaveBeenLastCalledWith('/old.tgz', { enabled: true })
  })
  it('恢复失败明确报告', async () => {
    const m = manager(); m.installBundle.mockResolvedValue({ application: 'failed' })
    await expect(installUpdate(m, release, true, async () => {}, () => {})).rejects.toThrow('恢复失败')
  })
  it('并发期间已升级时拒绝重复安装', async () => {
    const m = manager(); m.listBundles.mockResolvedValue([{ name: 'dsh-qqbot', version: '0.8.0', source: url, enabled: true, availability: 'profile' }])
    await expect(installUpdate(m, release, true, async () => {}, () => {})).rejects.toThrow('重新检查')
    expect(m.installBundle).not.toHaveBeenCalled()
  })
})
