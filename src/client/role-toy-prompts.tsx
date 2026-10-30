import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ROLE_PROACTIVITIES, ROLE_PROACTIVITY_LABELS, ROLE_PROACTIVITY_TEXT_LIMIT,
  type RoleProactivity, type RoleProactivityTexts,
} from '../library-types.ts'

/** 默认说明由联动插件提供，QQbot 不复制设备提示词。只读接口不连接设备。 */
export function RoleToyPrompts({ active, value, onChange }: {
  readonly active: boolean
  readonly value: RoleProactivityTexts | undefined
  readonly onChange: (value: RoleProactivityTexts | undefined) => void
}) {
  const [defaults, setDefaults] = useState<Required<RoleProactivityTexts>>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    const abort = new AbortController()
    setError('')
    void (async () => {
      try {
        const response = await fetch('api/toy-buttplug/state', { cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error('读取自主性提示词失败')
        const body = await response.json() as { proactivityDefaults?: Required<RoleProactivityTexts> }
        const texts = body.proactivityDefaults
        if (texts === undefined || ROLE_PROACTIVITIES.some(key => typeof texts[key] !== 'string')) {
          throw new Error('请更新联动插件后重试')
        }
        if (!abort.signal.aborted) setDefaults(texts)
      } catch (reason) {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { abort.abort() }
  }, [active, retry])

  const edit = (key: RoleProactivity, text: string | undefined) => {
    const next = { ...value }
    if (text === undefined || text === defaults?.[key]) delete next[key]
    else next[key] = text
    onChange(Object.keys(next).length === 0 ? undefined : next)
  }
  if (error !== '') return <div className="ql-state" role="alert">{error}
    <Button size="sm" onClick={() => { setRetry(n => n + 1) }}>重试</Button></div>
  if (defaults === undefined) return active ? <p className="ql-note">正在读取提示词…</p> : null
  return <details className="ql-group"><summary><strong>自主性提示词</strong></summary>
    <div className="ql-group-body">
      {ROLE_PROACTIVITIES.map(key => <details className="ql-group" key={key}>
        <summary>{ROLE_PROACTIVITY_LABELS[key]}{value?.[key] !== undefined && '（已修改）'}</summary>
        <div className="ql-group-body">
          <label className="ql-field"><span title="只对这个角色生效；当前档位标题由程序添加">提示词</span>
            <textarea rows={4} maxLength={ROLE_PROACTIVITY_TEXT_LIMIT} aria-label={`${ROLE_PROACTIVITY_LABELS[key]}提示词`}
              value={value?.[key] ?? defaults[key]} onChange={event => { edit(key, event.target.value) }} />
          </label>
          <div className="ql-actions"><Button size="sm" variant="outline" disabled={value?.[key] === undefined}
            title="恢复联动插件提供的默认说明" onClick={() => { edit(key, undefined) }}>恢复默认</Button></div>
        </div>
      </details>)}
    </div>
  </details>
}
