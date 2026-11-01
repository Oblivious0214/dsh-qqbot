/** 同步各页面的 QQ Bot 清理结果；只管理本插件的内存和存储键。 */
import { acceptCleanupEpoch } from './cleanup-epoch.ts'
import { MAINTENANCE_PATH, type CleanupKind, type MaintenanceView } from '../maintenance-types.ts'

type Listener = (all: boolean) => void | Promise<void>
const RESET_KEY = 'dsh-qqbot:cleanup-epoch'
const CONNECTION_KEY = 'dsh-toy-buttplug:connection'

export class MaintenanceClient {
  private readonly listeners = new Set<Listener>()
  private readonly subscribers = new Set<() => void>()
  private readonly abort = new AbortController()
  private cacheEpoch: string | undefined
  private dataEpoch: string | undefined
  private dataVersion = 0
  private busy = false
  private polling: Promise<void> = Promise.resolve()
  notice = ''
  subscribe = (listener: () => void) => { this.subscribers.add(listener); return () => { this.subscribers.delete(listener) } }
  getDataVersion = () => this.dataVersion
  register(listener: Listener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private async request(kind?: CleanupKind): Promise<MaintenanceView> {
    const response = await fetch(MAINTENANCE_PATH.slice(1), {
      method: kind === undefined ? 'GET' : 'POST', cache: 'no-store', signal: this.abort.signal,
      ...kind === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: kind }) },
    })
    const view = await response.json() as MaintenanceView & { message?: string }
    if (!response.ok) throw new Error(view.message ?? '清理未完成，请重试。')
    return view
  }

  private async adopt(view: MaintenanceView): Promise<void> {
    let known = this.dataEpoch
    if (known === undefined) {
      try { known = localStorage.getItem(RESET_KEY) ?? '' } catch { known = '' }
    }
    const all = known !== view.dataEpoch
    const changed = this.cacheEpoch !== undefined && this.cacheEpoch !== view.cacheEpoch
    let storageError: unknown
    if (all) {
      try { localStorage.removeItem(CONNECTION_KEY); localStorage.setItem(RESET_KEY, view.dataEpoch) }
      catch (error) { storageError = error }
    }
    if (all || changed) {
      // 任一页面清理后，所有已连接页面都停止旧任务并重新读资料。
      await Promise.all([...this.listeners].map(listener => listener(all)))
      if (all) this.dataVersion++
    }
    if (storageError !== undefined) throw new Error('数据已清理，但本页浏览器偏好未能清除，请允许浏览器存储后重试。')
    acceptCleanupEpoch(view.dataEpoch)
    this.dataEpoch = view.dataEpoch
    this.cacheEpoch = view.cacheEpoch
    for (const listener of this.subscribers) listener()
  }

  async clear(kind: CleanupKind): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.notice = ''
    try {
      await this.polling
      // 首次清理也有基准；发 POST 前不修改用户的本地偏好。
      if (this.cacheEpoch === undefined) await this.adopt(await this.request())
      const view = await this.request(kind)
      this.notice = kind === 'cache' ? '缓存已清理' : '全部数据已清理，已恢复初始配置'
      await this.adopt(view)
    } catch (error) { this.notice = ''; throw error } finally { this.busy = false }
  }

  /** 定期同步，离线页面重连也会清除过期的本地设备偏好。 */
  start(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = async () => {
      if (!this.busy) {
        this.polling = this.request().then(view => this.adopt(view)).catch(() => {})
        await this.polling
      }
      if (!this.abort.signal.aborted) timer = setTimeout(() => { void sync() }, 2000)
    }
    void sync()
    return () => { this.abort.abort(); clearTimeout(timer); this.listeners.clear(); this.subscribers.clear() }
  }
}
