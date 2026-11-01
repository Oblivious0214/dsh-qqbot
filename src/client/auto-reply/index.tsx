import type { MaintenanceClient } from '../maintenance.ts'
import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { QuickReplyState } from './quick-state.ts'
import type {} from '../segments-service.ts'
import type {} from '../ui-extensions.tsx'
import { AutoReplySessions } from './sessions.ts'
import { AutoReplySettings } from './settings.tsx'

export const AUTO_REPLY_CLASS = 'dsh-qqbot-auto-reply'
export const AUTO_REPLY_CSS = `
.${AUTO_REPLY_CLASS}.qar-reply-options { margin: 8px 0 16px; }
.${AUTO_REPLY_CLASS} .qar-quick { display: flex; flex-wrap: wrap; gap: 8px; }
.${AUTO_REPLY_CLASS} .qar-quick button { font: inherit; cursor: pointer; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 6px 10px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.${AUTO_REPLY_CLASS} .qar-quick button:disabled { opacity: .5; cursor: default; }
`
interface Injected {
  quick: QuickReplyState
  sessions: AutoReplySessions
  active(session: string): boolean
  displaying(session: string): boolean
}
type Props = PropsRuntime<'conversation.input.left'> & InjectFace<Injected>

/** Invisible composer observer; the settings page never owns its lease. */
export function AutoReplyMonitor(props: Props) {
  const isQqbot = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset === 'qqbot')
  return isQqbot ? <Monitor key={props.sessionId} {...props} /> : null
}

function Monitor(props: Props) {
  const input = props.useInput(value => value)
  const latest = useRef(input)
  latest.current = input
  useEffect(() => props.sessions.mount(props.sessionId, () => ({
    active: !document.hidden && props.active(props.sessionId),
    blocked: latest.current.draft.length > 0 || latest.current.attachmentIds.length > 0
      || latest.current.phase !== 'plain' || props.displaying(props.sessionId),
    activity: latest.current.draftRev,
  })), [props.sessionId, props.sessions])
  useEffect(() => {
    const refresh = () => { void props.quick.refresh(props.sessionId).catch(() => {}) }
    refresh()
    const timer = setInterval(refresh, 10000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [props.quick, props.sessionId])
  return null
}

export const inject = ['slots', 'sessions', 'uiSession', 'qqbotSegments', 'qqbotUi']
export function apply(ctx: Context, options: { quick: QuickReplyState; maintenance?: MaintenanceClient }): void {
  const sessions = new AutoReplySessions()
  ctx.effect(() => options.maintenance?.register(all => { if (all) sessions.stopAll() }) ?? (() => {}), 'qqbot: reset auto reply client')
  const pending = new Map<string, Set<string>>()
  ctx.qqbotSegments.register({
    revealed: (session, reply) => {
      const replies = pending.get(session) ?? new Set<string>()
      replies.add(reply)
      pending.set(session, replies)
    },
    ended: (session, reply) => {
      const replies = pending.get(session)
      replies?.delete(reply)
      if (replies?.size === 0) pending.delete(session)
    },
  })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'qqbot-auto-reply-monitor', order: 20,
    inject: (): Injected => ({
      quick: options.quick, sessions,
      active: session => ctx.uiSession.adapter.current.getSnapshot().key === session,
      displaying: session => (pending.get(session)?.size ?? 0) > 0,
    }),
  }, AutoReplyMonitor))
  ctx.qqbotUi.register(function ReplySettingsPage(props) {
    const current = useSyncExternalStore(ctx.uiSession.adapter.current.subscribe, ctx.uiSession.adapter.current.getSnapshot)
    const list = useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot)
    const session = current.key
    if (session === undefined || list.byId[session as keyof typeof list.byId]?.projectionValues?.agentPreset !== 'qqbot') return <p className="ql-note">请先打开一个 QQ Bot 对话。</p>
    return <AutoReplySettings key={session} session={session} sessions={sessions} quick={options.quick} {...props} />
  }, 'reply')
  ctx.effect(() => {
    const hidden = () => { if (document.hidden) sessions.stopAll('页面已隐藏，自动接话已关闭。') }
    const leaving = () => sessions.stopAll()
    let lastSession = ctx.uiSession.adapter.current.getSnapshot().key
    const unsubscribe = ctx.uiSession.adapter.current.subscribe(() => {
      const session = ctx.uiSession.adapter.current.getSnapshot().key
      if (session !== lastSession) { sessions.stopAll(); lastSession = session }
    })
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', leaving)
    const style = document.createElement('style')
    style.textContent = AUTO_REPLY_CSS
    document.head.append(style)
    return () => {
      unsubscribe(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leaving)
      sessions.dispose(); style.remove(); pending.clear()
    }
  }, 'qqbot: auto reply lifecycle')
}
