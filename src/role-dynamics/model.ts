/** Model text has only one input: the explicitly permitted projection. */
import type { ModelProjection } from './types.ts'
export const UPDATE_TOOL = 'qqbot_update_state'
export const STATE_GUIDANCE = '依据当前状态和已生效设定回应。'
export const UPDATE_DESCRIPTION = `${STATE_GUIDANCE}按字段更新规则，用 qqbot_update_state 提交本轮变化后的值；更新从下一轮生效。`
export function renderModelProjection(projection: ModelProjection): string {
  if (!projection.fields.length && !projection.texts.length) return ''
  const writable = projection.fields.some(field => field.writable)
  return [writable ? '' : STATE_GUIDANCE,
    projection.fields.length ? `当前状态：\n${JSON.stringify(projection.fields)}` : '',
    ...projection.texts,
  ].filter(Boolean).join('\n\n')
}
export const UPDATE_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['changes'],
  properties: { changes: { type: 'array', minItems: 1, maxItems: 32, items: {
    type: 'object', additionalProperties: false, required: ['name', 'value'],
    properties: { name: { type: 'string' }, value: { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }] } },
  } } },
} as const
