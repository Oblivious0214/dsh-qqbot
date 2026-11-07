import { fail, type RoleDynamicsConfig, type Values } from './types.ts'
import { jsonData, normalizeName, validateConfig, validateValue, validateValues } from './validate.ts'

export interface EvolutionSnapshot { progressId: string; values: Values }
export function planEvolution(old: RoleDynamicsConfig, next: RoleDynamicsConfig, snapshots: EvolutionSnapshot[], renames: Record<string, string> = {}) {
  const previous = validateConfig(old); const config = validateConfig(next)
  jsonData(renames, '$.renames')
  const mapping = new Map<string, string>(); const targets = new Set<string>()
  for (const [raw, target] of Object.entries(renames)) {
    const from = normalizeName(raw); const to = normalizeName(target)
    if (mapping.has(from) || targets.has(to)) fail('$.renames', '重命名必须一一对应')
    const a = previous.fields.find(field => field.name === from); const b = config.fields.find(field => field.name === to)
    if (!a || !b || a.type !== b.type || (from !== to && previous.fields.some(field => field.name === to))) fail('$.renames', '重命名来源、目标或类型不兼容')
    mapping.set(from, to); targets.add(to)
  }
  const issues: { field: string; progressIds: string[]; reason: string }[] = []
  for (const field of previous.fields) {
    const name = mapping.get(field.name) ?? field.name
    const replacement = config.fields.find(item => item.name === name)
    let reason = !replacement ? '字段移除' : replacement.type !== field.type ? '字段类型变化' : ''
    const affected: string[] = []
    for (const snapshot of snapshots) {
      const values = validateValues(previous, snapshot.values)
      if (!reason && replacement) {
        try { validateValue(replacement, values[field.name]) } catch { affected.push(snapshot.progressId) }
      } else affected.push(snapshot.progressId)
    }
    if (reason || affected.length) issues.push({ field: field.name, progressIds: [...new Set(affected)], reason: reason || '历史值与新定义不兼容' })
  }
  const migrate = (values: Values): Values => {
    if (issues.length) return fail('$.evolution', '需要重置该角色进度后应用', 'incompatible')
    const state = validateValues(previous, values)
    const result: Values = {}
    for (const field of config.fields) {
      const explicit = [...mapping].find(([, to]) => to === field.name)?.[0]
      const from = explicit ?? (mapping.has(field.name) ? undefined : field.name)
      result[field.name] = from !== undefined && Object.hasOwn(state, from) ? validateValue(field, state[from]) : field.initial
    }
    return result
  }
  return { compatible: issues.length === 0, config, issues, migrate }
}
