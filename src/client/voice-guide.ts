/** 语音页配置引导；共用明确指定 standard 的会话启动流程。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { voiceGuidePrompt, type VoiceGuideRoute } from '../voice-guide.ts'
import { StandardGuide, type StandardGuideHost } from './standard-guide.ts'

export type { StandardGuideResult as VoiceGuideResult, StandardGuideHost as VoiceGuideHost } from './standard-guide.ts'

export class VoiceGuide extends StandardGuide<VoiceGuideRoute> {
  constructor(host: StandardGuideHost) { super(host, 'qqbotVoiceGuide', voiceGuidePrompt) }
}

export function createVoiceGuide(ctx: Context, closeEditor: () => void): VoiceGuide | undefined {
  const navigation = ctx.get('uiWorkspace')
  if (navigation === undefined) return undefined
  return new VoiceGuide({ sessions: ctx.sessions, open: id => navigation.openSession(id), closeEditor })
}
