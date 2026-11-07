import { describe, expect, it } from 'vitest'
import { diagnose, evaluateCondition, initialValues, projectModel, validateConfig, validateValues, type Condition } from '../../src/role-dynamics/index.ts'
import { planEvolution } from '../../src/role-dynamics/evolution.ts'
import { example } from './fixtures.ts'

describe('strict definition and values', () => {
  it('four types and independent initial values', () => {
    const config = validateConfig(example()); const values = initialValues(config)
    expect(values).toEqual({ 好感: 20, 隐藏开关: false, 称呼: '朋友', 心情: '平静' })
    values['好感'] = 99; expect(initialValues(config)['好感']).toBe(20)
  })
  it.each([
    ['unknown version', (c: any) => { c.version = 2 }],
    ['unknown key', (c: any) => { c.extra = true }],
    ['duplicate NFC name', (c: any) => { c.fields[1].name = ' 好感 ' }],
    ['dangerous name', (c: any) => { c.fields[0].name = 'constructor' }],
    ['control name', (c: any) => { c.fields[0].name = 'a\u0000b' }],
    ['empty name', (c: any) => { c.fields[0].name = ' ' }],
    ['long name', (c: any) => { c.fields[0].name = 'x'.repeat(65) }],
    ['infinite', (c: any) => { c.fields[0].initial = Infinity }],
    ['NaN', (c: any) => { c.fields[0].initial = NaN }],
    ['negative zero', (c: any) => { c.fields[0].initial = -0 }],
    ['numeric string', (c: any) => { c.fields[0].initial = '20' }],
    ['range inverted', (c: any) => { c.fields[0].min = 200 }],
    ['initial range', (c: any) => { c.fields[0].initial = 101 }],
    ['boolean coercion', (c: any) => { c.fields[1].initial = 0 }],
    ['text limit', (c: any) => { c.fields[2].initial = 'x'.repeat(2001) }],
    ['choice initial', (c: any) => { c.fields[3].initial = 'unknown' }],
    ['choice duplicate', (c: any) => { c.fields[3].options = ['a', 'a'] }],
    ['choice empty', (c: any) => { c.fields[3].options = [] }],
    ['choice count', (c: any) => { c.fields[3].options = Array.from({ length: 33 }, (_, i) => String(i)) }],
    ['choice length', (c: any) => { c.fields[3].options = ['x'.repeat(101)] }],
    ['hidden writable', (c: any) => { c.fields[1].aiWritable = true }],
    ['missing rule', (c: any) => { delete c.fields[0].updateRule }],
    ['empty rule', (c: any) => { c.fields[0].updateRule = ' ' }],
    ['long rule', (c: any) => { c.fields[0].updateRule = 'x'.repeat(1001) }],
    ['unrelated range', (c: any) => { c.fields[1].min = 0 }],
    ['missing reference', (c: any) => { c.entries[0].when.field = 'absent' }],
    ['empty condition', (c: any) => { c.entries[0].when = { all: [] } }],
    ['condition extra', (c: any) => { c.entries[0].when.extra = 1 }],
    ['condition type', (c: any) => { c.entries[0].when.value = '30' }],
    ['unknown op', (c: any) => { c.entries[0].when.op = 'regex' }],
    ['text ordering', (c: any) => { c.entries[0].when = { field: '称呼', op: 'gt', value: 3 } }],
    ['entry duplicate', (c: any) => { c.entries[1].name = c.entries[0].name }],
    ['entry body limit', (c: any) => { c.entries[0].text = 'x'.repeat(8001) }],
    ['entry count', (c: any) => { c.entries = Array.from({ length: 65 }, (_, i) => ({ ...c.entries[0], name: String(i) })) }],
    ['field count', (c: any) => { c.fields = Array.from({ length: 33 }, (_, i) => ({ ...c.fields[0], name: String(i) })) }],
    ['no enabled fields', (c: any) => { c.fields = []; c.entries = [] }],
    ['disabled also checked', (c: any) => { c.enabled = false; c.fields[0].initial = 999 }],
  ])('rejects %s with a field path', (_name, mutate) => {
    const config = example(); mutate(config)
    expect(() => validateConfig(config)).toThrow(/\$/)
  })
  it('rejects pollution, getters, cycles and sparse arrays', () => {
    for (const value of [JSON.parse('{"__proto__":{"p":1}}'), { fields: { constructor: {} } }, Object.create({ version: 1 }), { get version() { throw new Error('getter executed') } }]) {
      expect(() => validateConfig(value)).toThrow()
    }
    const c: any = example(); c.loop = c; expect(() => validateConfig(c)).toThrow(/循环/)
    const sparse: any = example(); sparse.entries = new Array(3); expect(() => validateConfig(sparse)).toThrow(/稀疏/)
    expect(({} as any).p).toBeUndefined()
  })
  it('NFC normalization and body newline normalization', () => {
    const c = example(); c.fields[0]!.name = ' e\u0301 '; c.entries = [{ name: ' a ', when: { field: 'é', op: 'eq', value: 20 }, text: 'x\r\ny' }]
    const valid = validateConfig(c); expect(valid.fields[0]!.name).toBe('é'); expect(valid.entries[0]!.text).toBe('x\ny')
  })
  it('checks whole condition before evaluation; limits depth/nodes/bytes/body sum', () => {
    const c = example(); const values = initialValues(c)
    expect(() => evaluateCondition(c, values, { any: [{ field: '好感', op: 'eq', value: 20 }, { field: 'missing', op: 'eq', value: 1 }] })).toThrow(/引用/)
    let deep: Condition = { field: '好感', op: 'eq', value: 20 }
    for (let i = 0; i < 8; i++) deep = { all: [deep] }
    c.entries[0]!.when = deep; expect(() => validateConfig(c)).toThrow(/深度/)
    c.entries[0]!.when = { all: Array.from({ length: 128 }, () => ({ field: '好感', op: 'eq', value: 20 })) }; expect(() => validateConfig(c)).toThrow(/节点/)
    c.entries = Array.from({ length: 7 }, (_, i) => ({ name: String(i), when: { field: '好感', op: 'eq', value: 20 }, text: 'x'.repeat(8000) })); expect(() => validateConfig(c)).toThrow(/合计/)
    c.entries[0]!.text = '汉'.repeat(8000); c.entries.push(...Array.from({ length: 4 }, (_, i) => ({ name: `z${i}`, when: { field: '好感', op: 'eq' as const, value: 20 }, text: '汉'.repeat(8000) })))
    expect(() => validateConfig(c)).toThrow(/128 KiB/)
  })
  it.each(['gt', 'gte', 'lt', 'lte', 'eq', 'ne'] as const)('strict %s comparison', op => {
    const c = example(); const values = initialValues(c)
    expect(evaluateCondition(c, values, { field: '好感', op, value: 20 })).toBe(['gte', 'lte', 'eq'].includes(op))
    expect(() => evaluateCondition(c, values, { field: '好感', op, value: '20' } as Condition)).toThrow()
  })
  it('values require all fields and reject unknown fields/types/range', () => {
    const c = example(); const values = initialValues(c)
    for (const state of [{ ...values, 好感: 101 }, { ...values, 隐藏开关: 'false' }, { ...values, 心情: 'bad' }, { ...values, extra: true }, {}]) expect(() => validateValues(c, state)).toThrow()
  })
})
describe('projection and local diagnostics', () => {
  it.each([[29.9, '初识正文'], [30, '熟悉正文'], [69.9, '熟悉正文'], [70, '亲近正文'], [100, '亲近正文']])('stage boundary %s', (value, text) => {
    const c = example(); const values = { ...initialValues(c), 好感: value }
    const projection = projectModel(c, values); const json = JSON.stringify(projection)
    expect(projection.texts).toEqual([text]); expect(json).not.toContain('隐藏开关'); expect(json).not.toContain('阶段')
    expect(json).not.toContain('本地只读规则'); expect(json).not.toContain('解锁正文')
    expect(json).not.toContain('revision'); expect(json).not.toContain('progressId')
    expect(diagnose(c, values)).toHaveLength(4)
  })
  it('hidden change is byte stable unless its explicitly configured entry matches', () => {
    const c = example(); const values = initialValues(c)
    const first = JSON.stringify(projectModel(c, values)); c.entries.pop()
    const second = JSON.stringify(projectModel(c, { ...values, 隐藏开关: true }))
    expect(first).toBe(second)
    c.entries = example().entries
    expect(projectModel(c, { ...values, 隐藏开关: true }).texts).toEqual(['初识正文', '解锁正文'])
    c.enabled = false; expect(projectModel(c, values)).toEqual({ fields: [], texts: [] })
  })
  it('visible projection limit is enforced without truncation', () => {
    const c = example(); c.entries = Array.from({ length: 3 }, (_, i) => ({ name: String(i), when: { field: '好感', op: 'eq', value: 20 }, text: '汉'.repeat(8000) }))
    expect(() => projectModel(c, initialValues(c))).toThrow(/64 KiB/)
  })
})
describe('evolution planning', () => {
  it('adds initial once, preserves existing values, initial change does not reset', () => {
    const old = example(); const next = example(); next.fields[0]!.initial = 99
    next.fields.push({ name: '新', type: 'text', initial: 'new', visible: true, aiWritable: false })
    const plan = planEvolution(old, next, [{ progressId: 'p', values: initialValues(old) }])
    expect(plan.compatible).toBe(true); expect(plan.migrate(initialValues(old))).toMatchObject({ 好感: 20, 新: 'new' })
  })
  it('checks old branch snapshots, rejects removal, type change and implicit rename', () => {
    const old = example(); const next = example(); (next.fields[0] as any).max = 50
    const snapshots = [{ progressId: 'now', values: initialValues(old) }, { progressId: 'branch', values: { ...initialValues(old), 好感: 80 } }]
    expect(planEvolution(old, next, snapshots).issues[0]!.progressIds).toEqual(['branch'])
    next.fields = next.fields.filter(field => field.name !== '称呼'); expect(planEvolution(old, next, snapshots).compatible).toBe(false)
    const rename = example(); rename.fields[2]!.name = '昵称'
    expect(planEvolution(old, rename, snapshots).compatible).toBe(false)
    expect(planEvolution(old, rename, snapshots, { 称呼: '昵称' }).migrate(initialValues(old))['昵称']).toBe('朋友')
    expect(() => planEvolution(old, rename, snapshots, { missing: '昵称' })).toThrow()
  })
})
