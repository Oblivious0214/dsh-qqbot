import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { phoneGuidePrompt, type PhoneGuideRoute } from '../phone-guide.ts'
import { StandardGuide, type StandardGuideHost } from './standard-guide.ts'

export class PhoneGuide extends StandardGuide<PhoneGuideRoute> {
  constructor(host: StandardGuideHost) { super(host, 'qqbotPhoneGuide', phoneGuidePrompt) }
}

export function createPhoneGuide(ctx: Context, closeEditor: () => void): PhoneGuide | undefined {
  const navigation = ctx.get('uiWorkspace')
  if (navigation === undefined) return undefined
  return new PhoneGuide({ sessions: ctx.sessions, open: id => navigation.openSession(id), closeEditor })
}
