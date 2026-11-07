import { useEffect, useState } from 'react'
import { MEME_SCOPE_PATH, type MemeScopeView } from '../meme-scope.ts'

const EMPTY: MemeScopeView = { memes: [] }
/** 每条回复只读取其会话／轮次的范围，迟到请求不能串到新角色。 */
export function useMemeScope(session: string, turn: number, revision: number, active: boolean): MemeScopeView {
  const key = `${session}:${turn}:${revision}`
  const [state, setState] = useState<{ key: string; view: MemeScopeView }>()
  useEffect(() => {
    if (!active) return
    const abort = new AbortController()
    let generation = 0
    const load = async () => {
      const current = ++generation
      setState(undefined)
      try {
        const params = new URLSearchParams({ session, turn: String(turn) })
        const response = await fetch(`${MEME_SCOPE_PATH.slice(1)}?${params}`, { cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) })
        if (!response.ok) throw new Error('读取失败')
        const view = await response.json() as MemeScopeView
        if (!Array.isArray(view.memes)) throw new Error('格式无效')
        if (!abort.signal.aborted && current === generation) setState({ key, view })
      } catch { if (!abort.signal.aborted && current === generation) setState({ key, view: EMPTY }) }
    }
    void load()
    // 图库开关可从另一设置页改变；聚焦时刷新，不沿用全局描述索引。
    window.addEventListener('focus', load)
    return () => { abort.abort(); window.removeEventListener('focus', load) }
  }, [key, active])
  return active && state?.key === key ? state.view : EMPTY
}
