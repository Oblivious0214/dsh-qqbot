import type { ReleaseUpdate } from './update-types.ts'

export const REPOSITORY = 'Oblivious0214/dsh-qqbot'
export const INSTALL_URL = `https://github.com/${REPOSITORY}`
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
  return { version, url: INSTALL_URL, notes: String(r['body'] ?? '').slice(0, 20000), page: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(String(r['tag_name']))}` }
}

export interface InstallResult { application: string; error?: { message?: string; diagnostic?: string; code?: string }; version?: string }
export interface NativeManager {
  listBundles(): Promise<{ name: string; version?: string; source?: string; enabled: boolean; availability: string }[]>
  removeBundle(name: string): Promise<InstallResult>
  installBundle(spec: string, options: { enabled: boolean }): Promise<InstallResult>
}
const succeeded = (r: InstallResult) => r.application === 'applied' || r.application === 'restart-required'
const failure = (r: InstallResult, fallback: string) => r.error?.diagnostic || r.error?.message || (r.error?.code ? `${fallback}（${r.error.code}）` : fallback)
export async function installUpdate(manager: NativeManager, release: ReleaseUpdate, hmr: boolean,
  backup: () => Promise<void | string>, progress: (message: string) => void): Promise<InstallResult> {
  const previous = (await manager.listBundles()).find(b => b.name === 'dsh-qqbot')
  if (!previous?.source || previous.availability !== 'profile') throw new Error('当前安装方式不支持一键升级。')
  if (!previous.version || !newer(release.version, previous.version)) throw new Error('已安装此版本或更新版本，请重新检查。')
  progress('正在备份…'); const backupSource = await backup()
  if (hmr) {
    progress('正在准备安装…')
    const removed = await manager.removeBundle('dsh-qqbot')
    if (!succeeded(removed)) throw new Error(failure(removed, '旧版本未能移除。'))
  }
  try {
    progress('正在安装新版…')
    // Ignore cached asset/tag URLs from earlier plugin versions. Install the repository's default branch.
    const result = await manager.installBundle(INSTALL_URL, { enabled: previous.enabled })
    if (!succeeded(result)) throw new Error(failure(result, '新版安装失败。'))
    const installed = (await manager.listBundles()).find(b => b.name === 'dsh-qqbot')
    const version = installed?.version
    if (!version || installed.availability !== 'profile' ||
      (version !== release.version && !newer(version, release.version))) throw new Error('安装后的版本低于发布版本，请重新检查。')
    return { ...result, version }
  } catch (error) {
    progress('正在恢复旧版本…')
    if (hmr) {
      const current = (await manager.listBundles()).find(b => b.name === 'dsh-qqbot')
      if (current) {
        const removed = await manager.removeBundle('dsh-qqbot')
        if (!succeeded(removed)) throw new Error('升级失败，无法移除失败版本；请在 DSH 插件页恢复。')
      }
    }
    const restored = await manager.installBundle(backupSource || previous.source, { enabled: previous.enabled })
    if (!succeeded(restored)) throw new Error('升级失败，旧版本恢复失败；请在 DSH 插件页重新安装。')
    const restoredBundle = (await manager.listBundles()).find(b => b.name === 'dsh-qqbot')
    if (restoredBundle?.version !== previous.version) throw new Error('升级失败，恢复后的版本与旧版本不一致；请在 DSH 插件页检查。')
    throw new Error(`${error instanceof Error ? error.message : '升级失败。'} 已恢复旧版本。${restored.application === 'restart-required' ? '请重启 DSH。' : ''}`)
  }
}
