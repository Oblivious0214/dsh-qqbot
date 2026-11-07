import { fail, type Condition, type ModelProjection, type RoleDynamicsConfig, type Values } from './types.ts'
import { bytes, validateCondition, validateConfig, validateValues } from './validate.ts'

function evaluate(values: Values, condition: Condition): boolean {
  if ('all' in condition) return condition.all.every(child => evaluate(values, child))
  if ('any' in condition) return condition.any.some(child => evaluate(values, child))
  const value = values[condition.field]!
  switch (condition.op) {
    case 'eq': return value === condition.value
    case 'ne': return value !== condition.value
    case 'gt': return (value as number) > condition.value
    case 'gte': return (value as number) >= condition.value
    case 'lt': return (value as number) < condition.value
    case 'lte': return (value as number) <= condition.value
  }
}
export function evaluateCondition(config: RoleDynamicsConfig, values: Values, when: Condition): boolean {
  const valid = validateConfig(config)
  return evaluate(validateValues(valid, values), validateCondition(valid, when))
}
export function projectModel(config: RoleDynamicsConfig, values: Values): ModelProjection {
  const valid = validateConfig(config); const state = validateValues(valid, values)
  if (!valid.enabled) return { fields: [], texts: [] }
  const projection: ModelProjection = {
    fields: valid.fields.filter(field => field.visible).map(field => {
      const base = { name: field.name, type: field.type, value: state[field.name]! }
      if (!field.aiWritable) return { ...base, writable: false as const }
      return { ...base, writable: true as const, updateRule: field.updateRule!,
        ...(field.type === 'number' && field.min !== undefined ? { min: field.min } : {}),
        ...(field.type === 'number' && field.max !== undefined ? { max: field.max } : {}),
        ...(field.type === 'choice' ? { options: [...field.options] } : {}),
      }
    }),
    texts: valid.entries.filter(entry => evaluate(state, entry.when)).map(entry => entry.text),
  }
  if (bytes(JSON.stringify(projection)) > 64 * 1024) fail('$.projection', '可见投影超过 64 KiB')
  return projection
}
export function diagnose(config: RoleDynamicsConfig, values: Values) {
  const valid = validateConfig(config); const state = validateValues(valid, values)
  function detail(when: Condition): unknown {
    if ('all' in when) return { matched: evaluate(state, when), all: when.all.map(detail) }
    if ('any' in when) return { matched: evaluate(state, when), any: when.any.map(detail) }
    return { ...when, actual: state[when.field], matched: evaluate(state, when) }
  }
  return valid.entries.map(entry => ({ name: entry.name, matched: evaluate(state, entry.when), reason: detail(entry.when) }))
}
