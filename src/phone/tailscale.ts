import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../storage.ts'

export type TailscaleRun = (args: string[]) => Promise<string>
const run: TailscaleRun = args => new Promise((resolve, reject) => {
  const installed = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
  execFile(process.platform === 'win32' && existsSync(installed) ? installed : 'tailscale', args,
    { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '请先在电脑安装并登录 Tailscale。' : 'Tailscale 未就绪，请检查登录状态，并在 Tailscale 后台启用 HTTPS 后重试。'))
      else resolve(stdout)
    })
})
const parse = (value: string): Record<string, unknown> => {
  const data: unknown = JSON.parse(value)
  if (data === null) return {}
  if (!isRecord(data)) throw new Error('无法读取 Tailscale 状态。')
  return data
}
export interface TailscaleEntry { origin: string; start(): Promise<void>; close(): Promise<void> }

/** 仅管理本入口的 443 根路径，不重置已有 Serve，也不启用 Funnel。 */
export async function prepareTailscale(port: number, execute: TailscaleRun = run): Promise<TailscaleEntry> {
  const status = parse(await execute(['status', '--json']))
  if (status['BackendState'] !== 'Running') throw new Error('请先在电脑登录并连接 Tailscale。')
  const self = status['Self']
  const name = isRecord(self) && typeof self['DNSName'] === 'string' ? self['DNSName'].replace(/\.$/, '').toLowerCase() : ''
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(name)) throw new Error('请在 Tailscale 中开启 MagicDNS 和 HTTPS。')
  const key = `${name}:443`, target = `http://127.0.0.1:${port}`
  const read = async () => parse(await execute(['serve', 'status', '--json']))
  const occupied = (config: Record<string, unknown>): boolean => {
    const tcp = config['TCP'], web = config['Web'], funnel = config['AllowFunnel'], foreground = config['Foreground']
    return isRecord(tcp) && tcp['443'] !== undefined
      || isRecord(web) && Object.keys(web).some(k => k.endsWith(':443'))
      || isRecord(funnel) && Object.entries(funnel).some(([k, v]) => k.endsWith(':443') && v === true)
      || isRecord(foreground) && Object.values(foreground).some(v => isRecord(v) && occupied(v))
  }
  const matches = (config: Record<string, unknown>): boolean => {
    const tcp = config['TCP'], web = config['Web'], funnel = config['AllowFunnel']
    const listener = isRecord(tcp) ? tcp['443'] : undefined
    const site = isRecord(web) ? web[key] : undefined
    const handlers = isRecord(site) ? site['Handlers'] : undefined
    const root = isRecord(handlers) ? handlers['/'] : undefined
    return isRecord(listener) && Object.keys(listener).length === 1 && listener['HTTPS'] === true
      && isRecord(web) && Object.keys(web).filter(k => k.endsWith(':443')).length === 1
      && isRecord(handlers) && Object.keys(handlers).length === 1 && isRecord(root)
      && Object.keys(root).length === 1 && root['Proxy'] === target
      && !(isRecord(funnel) && funnel[key] === true)
      && !(isRecord(config['Foreground']) && Object.values(config['Foreground']).some(v => isRecord(v) && occupied(v)))
  }
  let owned = false
  const close = async () => {
    if (!owned) return
    if (matches(await read())) await execute(['serve', '--https=443', 'off'])
    owned = false
  }
  return { origin: `https://${name}`,
    async start() {
      const before = await read()
      if (matches(before)) return
      if (occupied(before)) throw new Error('Tailscale 的 HTTPS 入口已被使用，请先在 Tailscale 中处理现有入口。')
      // 命令失败也可能已经写入配置；close 会重新核对后再撤销。
      owned = true
      try {
        await execute(['serve', '--bg', '--https=443', target])
        if (!matches(await read())) throw new Error('Tailscale HTTPS 入口未正确建立。')
      } catch (error) { await close(); throw error }
    },
    close,
  }
}
