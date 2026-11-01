/** 表情包教程沿用语音的标准会话启动与失败降级流程。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { memeGuidePrompt } from '../meme-guide.ts'
import { StandardGuide, type StandardGuideHost } from './standard-guide.ts'

export class MemeGuide extends StandardGuide<'meme'> {
  constructor(host: StandardGuideHost) { super(host, 'qqbotMemeGuide', memeGuidePrompt) }
}

export function createMemeGuide(ctx: Context, closeEditor: () => void): MemeGuide | undefined {
  const navigation = ctx.get('uiWorkspace')
  if (navigation === undefined) return undefined
  return new MemeGuide({ sessions: ctx.sessions, open: id => navigation.openSession(id), closeEditor })
}
