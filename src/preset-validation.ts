/** 两端共用的预设校验。 */
import { isRecord } from './json-record.ts'
import type { LibraryPreset } from './library-types.ts'
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const NAME_LIMIT = 64
const TEXT_LIMIT = 20_000

/** 编辑界面提交的预设。修改时带 id；新建时不带，由 save() 生成。 */
export type PresetDraft = Omit<LibraryPreset, 'id'> & { readonly id?: string }

/** 校验一份预设；不合规时抛出可以直接展示给用户的错误。id 是内部键，用户看不到，只在格式不对时报"无效"。 */
export function validatePreset(value: unknown): LibraryPreset
export function validatePreset(value: unknown, optionalId: true): PresetDraft
export function validatePreset(value: unknown, optionalId = false): PresetDraft {
  if (!isRecord(value)) throw new TypeError('预设格式无效')
  const { id, name, head, mid, tail } = value
  if (!(optionalId && id === undefined) && (typeof id !== 'string' || !PRESET_ID_PATTERN.test(id))) throw new TypeError('预设 id 无效')
  if (typeof name !== 'string' || name.trim() === '' || name.length > NAME_LIMIT) throw new TypeError(`预设名称不能为空，最多 ${NAME_LIMIT} 个字符`)
  for (const [label, text] of [['开头', head], ['中间', mid], ['结尾', tail]] as const) {
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new TypeError(`预设${label}段必须是文本，最多 ${TEXT_LIMIT} 个字符`)
  }
  return { ...id === undefined ? {} : { id: id as string }, name: name.trim(), head: head as string, mid: mid as string, tail: tail as string }
}

