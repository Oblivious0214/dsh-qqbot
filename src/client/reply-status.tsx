import { TYPING_ATTRIBUTE } from './qq-style.ts'

/** 语音合成与段间打字共用一处状态，合成期间优先显示发送语音。 */
export function ReplyStatus({ typing, sendingVoice }: { readonly typing: boolean; readonly sendingVoice: boolean }) {
  if (!typing && !sendingVoice) return null
  return <div {...{ [TYPING_ATTRIBUTE]: '' }} role="status">{sendingVoice ? '发送语音中…' : '对方输入中…'}</div>
}
