import { ROLE_PROACTIVITIES, ROLE_PROACTIVITY_TEXT_LIMIT, type RoleProactivityTexts } from './library-types.ts'
import { isRecord } from './storage.ts'

/** 空字符串表示只保留档位标题；缺省字段才是使用默认，不能互相替代。 */
export function validateProactivityTexts(value: unknown): RoleProactivityTexts | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).some(key => !ROLE_PROACTIVITIES.includes(key as typeof ROLE_PROACTIVITIES[number]))) {
    throw new TypeError('自主性提示词格式无效')
  }
  const result: RoleProactivityTexts = {}
  for (const key of ROLE_PROACTIVITIES) {
    const text = value[key]
    if (text === undefined) continue
    if (typeof text !== 'string' || text.length > ROLE_PROACTIVITY_TEXT_LIMIT) {
      throw new TypeError(`每档自主性提示词不超过 ${ROLE_PROACTIVITY_TEXT_LIMIT} 字`)
    }
    result[key] = text
  }
  return Object.keys(result).length === 0 ? undefined : result
}
