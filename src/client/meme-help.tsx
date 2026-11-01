import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { memeGuidePrompt } from '../meme-guide.ts'
import type { MemeGuide } from './meme-guide.ts'
import type { StandardGuideResult } from './standard-guide.ts'
import { ActionDialog } from './action-dialog.tsx'

type Failure = Extract<StandardGuideResult, { ok: false }>
export function MemeHelp({ guide, disabled, onBusy }: {
  readonly guide: MemeGuide | undefined; readonly disabled: boolean
  readonly onBusy: (busy: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure>()
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const launch = async () => {
    if (locked.current || disabled) return
    locked.current = true; setBusy(true); onBusy(true); setCopied(false); setCopyError(false)
    try {
      const result: StandardGuideResult = guide === undefined
        ? { ok: false, prompt: memeGuidePrompt(), message: '暂时无法自动打开标准对话，请复制引导，在新建的标准对话中发送。' }
        : await guide.launch('meme')
      if (!alive.current) return
      if (result.ok) {
        try { guide!.open(result.sessionId) } catch {
          setFailure({ ok: false, sessionId: result.sessionId, prompt: memeGuidePrompt(), message: '引导已发送，但未能打开对话。请从侧栏查看新对话，不要重复发送。' })
        }
      } else setFailure(result)
    } finally { locked.current = false; onBusy(false); if (alive.current) setBusy(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(failure!.prompt); setCopied(true); setCopyError(false) }
    catch { setCopyError(true) }
  }
  return <>
    <div className="ql-actions"><Button size="sm" variant="outline" disabled={disabled || busy}
      title={disabled ? '先保存或放弃角色的修改' : '新建标准对话，让 DSH 帮你安装表情包并绑定角色'}
      onClick={() => { void launch() }}>{busy ? '正在打开…' : '查看教程'}</Button></div>
    {failure !== undefined && <ActionDialog title="表情包配置引导" cancelLabel="关闭" onCancel={() => setFailure(undefined)}>
      <p>{failure.message}</p>
      <textarea aria-label="可复制的表情包配置引导" readOnly rows={9} value={failure.prompt}
        style={{ width: '100%', boxSizing: 'border-box' }} onFocus={event => event.currentTarget.select()} />
      <div className="ql-actions"><Button size="sm" variant="outline" onClick={() => { void copy() }}>{copied ? '已复制' : '复制引导'}</Button>
        {failure.sessionId !== undefined && guide !== undefined && <Button size="sm" variant="outline" onClick={() => {
          try { guide.open(failure.sessionId!) } catch { setCopyError(true) }
        }}>打开已建对话</Button>}
      </div>
      {copyError && <p role="status">无法完成操作，请选中上方文字手动复制，并从侧栏打开标准对话。</p>}
    </ActionDialog>}
  </>
}
