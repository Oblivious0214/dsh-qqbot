/** 角色自己的表情偏好。格式独立于 dsh-meme，只借用它的只读图库目录。 */
import type { MemePackChoice, MemePreferences } from './library-types.ts'
import { MEME_PROMPT_LIMIT } from './library-types.ts'
import { isRecord } from './storage.ts'

const validName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
  && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)

/** 表单严格校验；空值不写入角色卡。 */
export function validateMemePreferences(value: Record<string, unknown>): MemePreferences {
  const { memePacks, memeTags, memePrompt } = value
  const packs = new Map<string, MemePackChoice>()
  if (memePacks !== undefined) {
    if (!Array.isArray(memePacks) || memePacks.length > 50) throw new TypeError('最多选择 50 个表情图库')
    for (const pack of memePacks) {
      if (!isRecord(pack) || !validName(pack['id']) || !validName(pack['name'])) throw new TypeError('表情图库无效')
      packs.set(pack['id'].trim(), { id: pack['id'].trim(), name: pack['name'].trim() })
    }
  }
  if (memeTags !== undefined && (!Array.isArray(memeTags) || memeTags.length > 100 || memeTags.some(tag => !validName(tag)))) {
    throw new TypeError('表情标签无效，最多选择 100 个')
  }
  if (memePrompt !== undefined && (typeof memePrompt !== 'string' || memePrompt.length > MEME_PROMPT_LIMIT || /\u0000/.test(memePrompt))) {
    throw new TypeError(`表情补充提示词最多 ${MEME_PROMPT_LIMIT} 个字符`)
  }
  const tags = [...new Set((memeTags as string[] | undefined)?.map(tag => tag.trim()))]
  const prompt = (memePrompt as string | undefined)?.trim()
  return {
    ...packs.size === 0 ? {} : { memePacks: [...packs.values()] },
    ...tags.length === 0 ? {} : { memeTags: tags },
    ...!prompt ? {} : { memePrompt: prompt },
  }
}
