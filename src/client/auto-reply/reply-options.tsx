import { useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QuickReplyState } from './quick-state.ts'

type Props = Pick<PropsRuntime<'conversation.input.left'>, 'sessionId' | 'useInput' | 'inputActions' | 'useChat' | 'useSession'> & {
  quick: QuickReplyState; replies: readonly string[]; turn: number; step: number
}
export function ReplyOptions({ quick, replies, turn, step, sessionId, useInput, inputActions, useChat, useSession }: Props) {
  useSyncExternalStore(quick.subscribe, quick.getVersion)
  const input = useInput(value => value)
  const blocked = useSession(value => value.running || value.removed || value.openState !== 'open' || value.pendingSubmissions.length > 0)
  const latest = useChat(value => {
    if (value.legacy.partial) return false
    const tail = value.legacy.nodes.findLast(node => node.kind === 'assistant' || node.kind === 'user' || node.kind === 'steering')
    return tail?.kind === 'assistant' && tail.turn === turn && tail.step === step
  })
  const [picked, setPicked] = useState(false)
  const picking = useRef(false)
  const send = quick.clickMode(sessionId) === 'send'
  if (!quick.get(sessionId) || replies.length !== 3 || !latest || blocked || picked) return null
  const disabled = input.draft.length > 0 || input.attachmentIds.length > 0 || input.phase !== 'plain'
  return <div className="dsh-qqbot-auto-reply qar-reply-options" role="group" aria-label="回复建议">
    <div className="qar-quick">{replies.map(text => <button key={text} type="button" disabled={disabled}
      title={disabled ? '输入框已有内容，请先发送或清空' : send ? '直接发送' : '填入回复栏，可修改后发送'}
      onClick={() => {
        if (disabled || picking.current) return
        picking.current = true
        inputActions.setDraft(text)
        inputActions.persistDraft()
        if (send) inputActions.submit()
        setPicked(true)
      }}>{text}</button>)}</div>
  </div>
}
