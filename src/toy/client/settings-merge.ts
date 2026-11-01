import { TIERS } from '../core/config.ts'
import { parseActionLibrary, type ActionLibrary } from '../motion-library/config.ts'

/** Apply only the fields edited since base, preserving unrelated concurrent saves. */
export function mergeSettings<T>(base: T, edited: T, latest: T, strict = false): T {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const merge = (before: unknown, after: unknown, current: unknown): unknown => {
    if (same(before, after)) return current
    if (same(before, current) || same(after, current)) return after
    if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)
      && [...before, ...after, ...current].every(item => object(item) && typeof item['id'] === 'string')) {
      const keyed = (items: Record<string, unknown>[]) => Object.fromEntries(items.map(item => [item['id'], item]))
      return Object.values(merge(keyed(before), keyed(after), keyed(current)) as Record<string, unknown>)
    }
    if (object(before) && object(after) && object(current)) {
      const result = { ...current }
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const value = merge(before[key], after[key], current[key])
        if (value === undefined) delete result[key]
        else result[key] = value
      }
      return result
    }
    if (strict) throw new Error('同一项已在其他位置修改，请重试保存或取消编辑')
    return after
  }
  return merge(base, edited, latest) as T
}

/** Pool references follow stable clip IDs while names are edited. */
export function mergeActionLibrary(base: ActionLibrary, edited: ActionLibrary, latest: ActionLibrary, strict = true): ActionLibrary {
  const keys = [...TIERS, 'burst', 'aftercare'] as const
  const keyed = (value: ActionLibrary) => Object.fromEntries(keys.map(key => {
    const pool = key === 'burst' ? value.burstPool : key === 'aftercare' ? value.aftercarePool : value.pools[key]
    return [key, pool === undefined ? undefined : Object.fromEntries(pool.map(entry => [value.library.clips.find(clip => clip.name === entry.name)!.id, entry.weight]))]
  }))
  const library = mergeSettings(base.library, edited.library, latest.library, strict)
  const pools = mergeSettings(keyed(base), keyed(edited), keyed(latest), strict)
  const named = (key: typeof keys[number]) => Object.entries(pools[key]!).map(([id, weight]) => ({ name: library.clips.find(clip => clip.id === id)?.name, weight }))
  return parseActionLibrary({ revision: latest.revision, library,
    pools: Object.fromEntries(TIERS.map(tier => [tier, named(tier)])),
    ...(pools['burst'] === undefined ? {} : { burstPool: named('burst') }),
    ...(pools['aftercare'] === undefined ? {} : { aftercarePool: named('aftercare') }) })
}
