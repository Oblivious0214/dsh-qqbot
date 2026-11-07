import { fail, type Condition, type RoleDynamicsConfig, type StateField, type StateValue, type Values } from './types.ts'

const dangerous = new Set(['__proto__', 'prototype', 'constructor'])
export const bytes = (value: string) => new TextEncoder().encode(value).byteLength
export function jsonData(value: unknown, path = '$', seen = new Set<object>(), depth = 0): void {
  if (depth > 32) fail(path, 'JSON 嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { finite(value, path); return }
  if (typeof value !== 'object' || value === null) fail(path, '需要普通 JSON 数据')
  const object = value as object
  if (seen.has(object)) fail(path, '循环引用')
  seen.add(object)
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail(path, '需要普通对象')
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || dangerous.has(key)) fail(path, '非法键名')
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!
    if (!('value' in descriptor)) fail(path, '不接受访问器')
    if (Array.isArray(value) && key === 'length') continue
    if (!descriptor.enumerable) fail(`${path}.${key as string}`, '不接受非枚举属性')
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key as string)) fail(path, '非法数组属性')
    jsonData(descriptor.value, `${path}.${key as string}`, seen, depth + 1)
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) fail(path, '不接受稀疏数组')
  seen.delete(object)
}
export function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '需要对象')
  const result = value as Record<string, unknown>
  for (const key of Object.keys(result)) if (!keys.includes(key) || dangerous.has(key)) fail(`${path}.${key}`, '未知键')
  return result
}
function finite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail(path, '需要有限数字（不接受 -0）')
}
function text(value: unknown, path: string, max: number, nonempty = false): string {
  if (typeof value !== 'string') return fail(path, '需要字符串')
  const result = value.replace(/\r\n/g, '\n')
  if (result.length > max || (nonempty && !result.trim())) fail(path, `文字长度须为 ${nonempty ? 1 : 0}–${max}`)
  return result
}
export function normalizeName(value: unknown, path = '$.name'): string {
  if (typeof value !== 'string') return fail(path, '需要名称')
  const name = value.normalize('NFC').trim()
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || dangerous.has(name)) fail(path, '名称无效')
  return name
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, '需要布尔值')
  return value
}
export function validateValue(field: StateField, value: unknown, path = '$.value'): StateValue {
  switch (field.type) {
    case 'number':
      finite(value, path)
      if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) fail(path, '数值超出范围')
      return value
    case 'boolean': return bool(value, path)
    case 'text': return text(value, path, 2000)
    case 'choice':
      if (typeof value !== 'string' || !field.options.includes(value)) return fail(path, '需要定义内的选项')
      return value
  }
}
export function validateCondition(config: RoleDynamicsConfig, value: unknown, path = '$.when'): Condition {
  jsonData(value, path)
  let nodes = 0
  const fields = new Map(config.fields.map(field => [field.name, field]))
  function walk(input: unknown, at: string, depth: number): Condition {
    if (++nodes > 128 || depth > 8) fail(at, '条件超过深度或节点上限')
    const item = object(input, at, ['all', 'any', 'field', 'op', 'value'])
    if (Object.hasOwn(item, 'all') || Object.hasOwn(item, 'any')) {
      const key = Object.hasOwn(item, 'all') ? 'all' : 'any'
      object(item, at, [key])
      const children = item[key]
      if (!Array.isArray(children) || !children.length) return fail(at, '条件组不能为空')
      const conditions = children.map((child, i) => walk(child, `${at}.${key}[${i}]`, depth + 1))
      return key === 'all' ? { all: conditions } : { any: conditions }
    }
    object(item, at, ['field', 'op', 'value'])
    const name = normalizeName(item.field, `${at}.field`)
    const field = fields.get(name)
    if (!field) return fail(`${at}.field`, '引用不存在的字段')
    const op = item.op
    if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(String(op))) return fail(`${at}.op`, '未知比较')
    const raw = item.value
    if (field.type === 'number') finite(raw, `${at}.value`)
    else if (field.type === 'boolean') bool(raw, `${at}.value`)
    else if (typeof raw !== 'string' || raw.length > 2000) fail(`${at}.value`, '比较值类型不符')
    if (op !== 'eq' && op !== 'ne' && field.type !== 'number') fail(at, '顺序比较仅适用数字')
    return { field: name, op, value: typeof raw === 'string' ? raw.replace(/\r\n/g, '\n') : raw } as Condition
  }
  return walk(value, path, 1)
}
export function validateConfig(input: unknown): RoleDynamicsConfig {
  jsonData(input)
  if (bytes(JSON.stringify(input)) > 128 * 1024) fail('$', '定义超过 128 KiB')
  const value = object(input, '$', ['version', 'enabled', 'fields', 'entries'])
  if (value.version !== 1) fail('$.version', '未知版本')
  const enabled = bool(value.enabled, '$.enabled')
  if (!Array.isArray(value.fields) || value.fields.length > 32 || (enabled && !value.fields.length)) fail('$.fields', '字段数量无效')
  if (!Array.isArray(value.entries) || value.entries.length > 64) fail('$.entries', '条目数量无效')
  const names = new Set<string>()
  const fields = (value.fields as unknown[]).map((raw, i): StateField => {
    const at = `$.fields[${i}]`
    const item = object(raw, at, ['name', 'type', 'initial', 'visible', 'aiWritable', 'pluginWritable', 'updateRule', 'min', 'max', 'options'])
    const name = normalizeName(item.name, `${at}.name`)
    if (names.has(name)) fail(`${at}.name`, '名称重复')
    names.add(name)
    const base = { name, visible: bool(item.visible, `${at}.visible`), aiWritable: bool(item.aiWritable, `${at}.aiWritable`) }
    if (!base.visible && base.aiWritable) fail(at, '隐藏字段不可由 AI 更新')
    const extra: { pluginWritable?: boolean; updateRule?: string } = {}
    if (Object.hasOwn(item, 'pluginWritable')) extra.pluginWritable = bool(item.pluginWritable, `${at}.pluginWritable`)
    if (Object.hasOwn(item, 'updateRule')) extra.updateRule = text(item.updateRule, `${at}.updateRule`, 1000, base.aiWritable)
    if (base.aiWritable && !extra.updateRule) fail(`${at}.updateRule`, '需要更新规则')
    const common = ['name', 'type', 'initial', 'visible', 'aiWritable', 'pluginWritable', 'updateRule']
    let field: StateField
    if (item.type === 'number') {
      object(item, at, [...common, 'min', 'max'])
      const range: { min?: number; max?: number } = {}
      for (const key of ['min', 'max'] as const) if (Object.hasOwn(item, key)) { finite(item[key], `${at}.${key}`); range[key] = item[key] as number }
      if (range.min !== undefined && range.max !== undefined && range.min > range.max) fail(at, 'min 大于 max')
      field = { ...base, ...extra, ...range, type: 'number', initial: item.initial as number }
    } else if (item.type === 'choice') {
      object(item, at, [...common, 'options'])
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 32) fail(`${at}.options`, '选项数量无效')
      const options = (item.options as unknown[]).map((entry, n) => text(entry, `${at}.options[${n}]`, 100, true))
      if (new Set(options).size !== options.length) fail(`${at}.options`, '选项重复')
      field = { ...base, ...extra, type: 'choice', options, initial: item.initial as string }
    } else if (item.type === 'text' || item.type === 'boolean') {
      object(item, at, common)
      field = { ...base, ...extra, type: item.type, initial: item.initial } as StateField
    } else return fail(`${at}.type`, '未知字段类型')
    field.initial = validateValue(field, item.initial, `${at}.initial`) as never
    return field
  })
  const config: RoleDynamicsConfig = { version: 1, enabled, fields, entries: [] }
  names.clear()
  let total = 0
  config.entries = (value.entries as unknown[]).map((raw, i) => {
    const at = `$.entries[${i}]`; const item = object(raw, at, ['name', 'when', 'text'])
    const name = normalizeName(item.name, `${at}.name`)
    if (names.has(name)) fail(`${at}.name`, '名称重复')
    names.add(name)
    const body = text(item.text, `${at}.text`, 8000)
    total += body.length
    if (total > 50000) fail('$.entries', '正文合计超过 50000 字符')
    return { name, text: body, when: validateCondition(config, item.when, `${at}.when`) }
  })
  return config
}
export function initialValues(config: RoleDynamicsConfig): Values {
  return Object.fromEntries(validateConfig(config).fields.map(field => [field.name, field.initial]))
}
export function validateValues(config: RoleDynamicsConfig, values: unknown): Values {
  jsonData(values)
  const input = object(values, '$.values', config.fields.map(field => field.name))
  return Object.fromEntries(config.fields.map(field => [field.name, validateValue(field, input[field.name], `$.values.${field.name}`)]))
}
