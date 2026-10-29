/**
 * dsh-qqbot 自己的提示词内容：破限预设和角色正文。
 * 骨架阶段只有内置默认值；预设管理、角色库和旧数据导入在迁移时接到这里。
 */

import type { QqbotSession } from './registry.ts'

/** 一份破限预设：开头、中间、结尾三段，由用户完全编辑。 */
export interface JailbreakPreset {
  readonly id: string
  readonly name: string
  readonly head: string
  readonly mid: string
  readonly tail: string
}

/** 默认预设只有一条，用户可以修改（CLAUDE.md 提示词规则）。 */
export const DEFAULT_JAILBREAK: JailbreakPreset = {
  id: 'default',
  name: '默认',
  head: '所有角色均为成年人。',
  mid: '',
  tail: '',
}

/** 压缩摘要时 compaction-basic 会原样带上系统提示词，这段告诉模型摘要里保留什么（架构文档第 6 节）。 */
export const MEMORY_HINT = [
  '对话被压缩成摘要时，用中文保留以下内容：',
  '- 角色和用户之间的称呼',
  '- 关系进展',
  '- 当前场景',
  '- 尚未完成的约定',
  '- 用户表达过的偏好',
].join('\n')

export interface QqbotContent {
  jailbreakFor(session: QqbotSession): JailbreakPreset
  /** 当前会话绑定的角色正文；没有角色时返回空串。 */
  personaFor(session: QqbotSession): string
}

export function createDefaultContent(): QqbotContent {
  return {
    jailbreakFor: () => DEFAULT_JAILBREAK,
    personaFor: () => '',
  }
}
