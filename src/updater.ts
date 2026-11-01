import type { ReleaseUpdate } from './update-types.ts'

export const REPOSITORY = 'Oblivious0214/dsh-qqbot'
export function newer(version: string, current: string): boolean {
  const parse = (s: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.exec(s)
  const a = parse(version), b = parse(current)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i])
  return current.includes('-') && !version.includes('-')
}
export function releaseUpdate(input: unknown, current: string): ReleaseUpdate | undefined {
  if (!input || typeof input !== 'object') throw new Error('GitHub 版本信息无效。')
  const r = input as Record<string, unknown>
  if (r['draft'] || r['prerelease']) return undefined
  const version = String(r['tag_name'] ?? '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('发布版本号无效。')
  if (!newer(version, current)) return undefined
  const assets = Array.isArray(r['assets']) ? r['assets'] as Record<string, unknown>[] : []
  const matches = assets.filter(a => a['name'] === `dsh-qqbot-${version}.tgz`)
  if (matches.length !== 1) throw new Error('新版尚未提供安装包。')
  const url = String(matches[0]!['browser_download_url'])
  const expected = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(String(r['tag_name']))}/dsh-qqbot-${version}.tgz`
  if (url !== expected) throw new Error('发布安装包地址无效。')
  return { version, url, notes: String(r['body'] ?? '').slice(0, 20000), page: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(String(r['tag_name']))}` }
}

export interface InstallResult { application: string; error?: { message?: string }; version?: string }
export interface NativeManager {
  listBundles(): Promise<{ name: string; version?: string; source?: string; enabled: boolean; availability: string }[]>
  removeBundle(name: string): Promise<InstallResult>
  installBundle(spec: string, options: { enabled: boolean }): Promise<InstallResult>
}
const succeeded = (r: InstallResult) => r.application === 'applied' || r.application === 'restart-required'
export async function installUpdate(manager: NativeManager, release: ReleaseUpdate, hmr: boolean,
  backup: () => Promise<void>, progress: (message: string) => void): Promise<InstallResult> {
  const previous = (await manager.listBundles()).find(b => b.name === 'dsh-qqbot')
  if (!previous?.source || previous.availability !== 'profile') throw new Error('当前安装方式不支持一键升级。')
  if (!previous.version || !newer(release.version, previous.version)) throw new Error('已安装此版本或更新版本，请重新检查。')
  progress('正在备份…'); await backup()
  if (hmr) {
    progress('正在准备安装…')
    const removed = await manager.removeBundle('dsh-qqbot')
    if (!succeeded(removed)) throw new Error(removed.error?.message ?? '旧版本未能移除。')
  }
  try {
    progress('正在安装新版…')
    const result = await manager.installBundle(release.url, { enabled: previous.enabled })
    if (!succeeded(result)) throw new Error(result.error?.message ?? '新版安装失败。')
    if (result.version !== release.version) throw new Error('安装后的版本与发布版本不一致。')
    return result
  } catch (error) {
    progress('正在恢复旧版本…')
    if (hmr) {
      const current = (await manager.listBundles()).find(b => b.name === 'dsh-qqbot')
      if (current) {
        const removed = await manager.removeBundle('dsh-qqbot')
        if (!succeeded(removed)) throw new Error('升级失败，无法移除失败版本；请在 DSH 插件页恢复。')
      }
    }
    const restored = await manager.installBundle(previous.source, { enabled: previous.enabled })
    if (!succeeded(restored)) throw new Error('升级失败，旧版本恢复失败；请在 DSH 插件页重新安装。')
    throw new Error(`${error instanceof Error ? error.message : '升级失败。'} 已恢复旧版本。${restored.application === 'restart-required' ? '请重启 DSH。' : ''}`)
  }
}
