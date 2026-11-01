/** 用户主动点击的配置引导共用标准会话控制器；不修改已有会话或默认预设。 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { qqbotVoiceGuide: unknown; qqbotMemeGuide: unknown; qqbotPhoneGuide: unknown }
}

type SessionId = Awaited<ReturnType<ISessions['create']>>
export type StandardGuideResult =
  | { readonly ok: true; readonly sessionId: SessionId }
  | { readonly ok: false; readonly prompt: string; readonly message: string; readonly sessionId?: SessionId }

export interface StandardGuideHost {
  readonly sessions: Pick<ISessions, 'create' | 'retain'>
  readonly open: (id: SessionId) => void
  readonly closeEditor: () => void
}

/** 每条路线在本次页面运行中只尝试发送一次；失败也不盲目重试，避免丢失响应后重复部署。 */
export class StandardGuide<Route extends string> {
  private attempts = new Map<Route, Promise<StandardGuideResult>>()
  private readonly abort = new AbortController()

  constructor(
    private readonly host: StandardGuideHost,
    private readonly source: 'qqbotVoiceGuide' | 'qqbotMemeGuide' | 'qqbotPhoneGuide',
    private readonly promptFor: (route: Route) => string,
  ) {}

  launch(kind: Route): Promise<StandardGuideResult> {
    const existing = this.attempts.get(kind)
    if (existing !== undefined) return existing
    const attempt = this.start(kind)
    this.attempts.set(kind, attempt)
    return attempt
  }

  open(id: SessionId): void {
    this.abort.signal.throwIfAborted()
    this.host.open(id)
    this.host.closeEditor()
  }

  private async start(kind: Route): Promise<StandardGuideResult> {
    const prompt = this.promptFor(kind)
    let sessionId: SessionId | undefined
    let sent = false
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 30_000)
    const signal = AbortSignal.any([this.abort.signal, timeout.signal])
    const operation = async (): Promise<StandardGuideResult> => {
      signal.throwIfAborted()
      // 不传已有 sessionId，不沿用默认预设，也不修改任何已有对话。
      sessionId = await this.host.sessions.create({ agentPreset: 'standard' })
      signal.throwIfAborted()
      const reference = this.host.sessions.retain(sessionId, { source: this.source, signal })
      const release = () => reference.release()
      signal.addEventListener('abort', release, { once: true })
      try {
        const { session } = await reference.ready
        signal.throwIfAborted()
        if (session.getSnapshot().openState !== 'open') throw new Error('session not ready')
        if (session.projections.faceOf('agentPreset').getSnapshot() !== 'standard') throw new Error('unexpected preset')
        const submission = session.beginSubmission({ mode: 'queue', text: prompt, attachments: [] })
        sent = true
        const result = await session.prompt([{ type: 'text', text: prompt }], 'queue', signal, submission.requestId)
        if (!result.ok) throw new Error('prompt rejected')
        signal.throwIfAborted()
        return { ok: true, sessionId }
      } finally { signal.removeEventListener('abort', release); reference.release() }
    }
    try {
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return await Promise.race([operation(), aborted])
    } catch {
      // 不展示宿主/网络异常原文，里面可能包含路径或敏感配置。
      return {
        ok: false, prompt, ...sessionId === undefined ? {} : { sessionId },
        message: sent
          ? '没有确认引导是否发送成功。请先查看已建对话，避免重复发送；也可以复制下面的引导。'
          : '未能启动标准对话。可以复制下面的引导，在新建的标准对话中发送。',
      }
    } finally { clearTimeout(timer) }
  }

  dispose(): void { this.abort.abort() }
}
