/**
 * 浏览器端调用 host 的 `/api/toy-buttplug/state`。走 DSH 自己的认证，只有 owner 能读写。
 */

import { writeHeaders } from '../../client/cleanup-epoch.ts'
import { STATE_PATH, type ToyAction, type ToyView } from '../api-types.ts'

export interface ToyApi {
  get(session?: string): Promise<ToyView>
  watch?(revision: number, signal: AbortSignal): Promise<ToyView>
  /** 会话操作返回的视图带上这个会话。 */
  post(action: ToyAction): Promise<ToyView>
  /** 页面关闭时用：keepalive，不等结果。 */
  beacon(action: ToyAction): void
}

// 相对路径：DSH 可能挂在子路径下（与 dsh-qqbot 一致）。
const PATH = STATE_PATH.slice(1)

async function read(response: Response): Promise<ToyView> {
  const body = await response.json().catch(() => undefined) as (ToyView & { message?: string }) | undefined
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`)
  return body as ToyView
}

export const fetchApi: ToyApi = {
  async watch(revision, signal) {
    return read(await fetch(`${PATH}?watch=${revision}`, { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) }))
  },
  async get(session) {
    const query = session === undefined ? '' : `?session=${encodeURIComponent(session)}`
    return read(await fetch(PATH + query, { cache: 'no-store' }))
  },
  async post(action) {
    return read(await fetch(PATH, {
      method: 'POST', cache: 'no-store', headers: writeHeaders(), body: JSON.stringify(action),
    }))
  },
  beacon(action) {
    void fetch(PATH, {
      method: 'POST', keepalive: true, cache: 'no-store', headers: writeHeaders(), body: JSON.stringify(action),
    }).catch(() => {})
  },
}
