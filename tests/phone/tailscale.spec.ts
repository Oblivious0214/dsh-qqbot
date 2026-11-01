import { describe, expect, it } from 'vitest'
import { prepareTailscale } from '../../src/phone/tailscale.ts'

function fixture(initial: Record<string, unknown> = {}) {
  let config = initial
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desktop.test-net.ts.net.' } })
    if (args[1] === 'status') return JSON.stringify(config)
    if (args.at(-1) === 'off') config = {}
    else config = { TCP: { '443': { HTTPS: true } }, Web: { 'desktop.test-net.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3088' } } } } }
    return ''
  }
  return { calls, run, replace: (value: Record<string, unknown>) => { config = value } }
}
describe('Tailscale HTTPS 入口', () => {
  it('自动生成地址，只建立私有 Serve，关闭时撤销自己的入口', async () => {
    const f = fixture(), entry = await prepareTailscale(3088, f.run)
    expect(entry.origin).toBe('https://desktop.test-net.ts.net')
    await entry.start(); await entry.close(); await entry.close()
    expect(f.calls).toContainEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:3088'])
    expect(f.calls.filter(c => c.at(-1) === 'off')).toHaveLength(1)
    expect(f.calls.flat()).not.toContain('funnel')
  })
  it('已有 TCP、网站、Funnel 或前台入口时不覆盖', async () => {
    for (const config of [{ TCP: { '443': { TCPForward: 'elsewhere:80' } } },
      { Web: { 'desktop.test-net.ts.net:443': { Handlers: { '/other': { Text: 'keep' } } } } },
      { AllowFunnel: { 'desktop.test-net.ts.net:443': true } },
      { Foreground: { session: { TCP: { '443': { HTTPS: true } } } } }]) {
      const f = fixture(config), entry = await prepareTailscale(3088, f.run)
      await expect(entry.start()).rejects.toThrow('已被使用'); await entry.close()
      expect(f.calls.every(c => c.includes('--json'))).toBe(true)
    }
  })
  it('崩溃遗留或手动配置的同一目标可以复用，关闭时不删除既有映射', async () => {
    const f = fixture(); await f.run(['serve', '--bg', '--https=443', 'http://127.0.0.1:3088']); f.calls.length = 0
    const entry = await prepareTailscale(3088, f.run); await entry.start(); await entry.close()
    expect(f.calls.every(c => c.includes('--json'))).toBe(true)
  })
  it('关闭前配置被其他程序改变时保留它', async () => {
    const f = fixture(), entry = await prepareTailscale(3088, f.run)
    await entry.start(); f.replace({ TCP: { '443': { TCPForward: 'other:80' } } }); await entry.close()
    expect(f.calls.some(c => c.at(-1) === 'off')).toBe(false)
  })
  it('拒绝离线、未登录、错误域名和坏状态', async () => {
    for (const status of ['{}', '{broken', JSON.stringify({ BackendState: 'NeedsLogin' }),
      JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'evil.example.com' } })]) {
      await expect(prepareTailscale(3088, async () => status)).rejects.toThrow()
    }
  })
  it('Serve 命令部分成功后报错，也会核对并清理', async () => {
    const f = fixture()
    const entry = await prepareTailscale(3088, async args => {
      const result = await f.run(args)
      if (args.includes('--bg')) throw new Error('timeout')
      return result
    })
    await expect(entry.start()).rejects.toThrow('timeout')
    expect(f.calls).toContainEqual(['serve', '--https=443', 'off'])
  })
})
