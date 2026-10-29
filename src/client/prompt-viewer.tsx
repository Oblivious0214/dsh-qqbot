/**
 * 提示词查看器：qqbot 会话标题栏右侧的按钮和弹窗，只读。
 * 数据来自 host 的 PROMPT_VIEW_PATH；改内容要去对应的编辑入口，这里不改文本（架构文档第 11 节）。
 * 角色和破限预设的段落带"编辑"按钮，关掉查看器、打开编辑器并定位到对应条目。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconContextInjectionOutlineRegular, IconRefreshOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SECTION_NAME } from '../order.ts'
import { PRESET_ID, PROMPT_VIEW_PATH, type PromptView, type PromptViewPart } from '../view-types.ts'
import type { EditorTarget, OpenEditor } from './library-editor.tsx'

/** 所有样式都在这个根 class 下（CLAUDE.md 隔离原则第 3 条）。 */
export const ROOT_CLASS = 'dsh-qqbot-viewer'

export const VIEWER_CSS = `
[role="dialog"].${ROOT_CLASS} { width: min(880px, 100%); max-height: 100%; }
.${ROOT_CLASS} .qv-body { display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow: auto; padding-right: 4px; }
.${ROOT_CLASS} .qv-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.${ROOT_CLASS} .qv-bar .qv-grow { flex: 1; }
.${ROOT_CLASS} .qv-state { padding: 6px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); font-size: 12px; }
.${ROOT_CLASS} .qv-state.qv-warn { color: var(--dsw-alias-state-warn-label); }
.${ROOT_CLASS} .qv-group > summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 4px 0; }
.${ROOT_CLASS} .qv-item { margin: 4px 0 4px 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.${ROOT_CLASS} .qv-item > summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.${ROOT_CLASS} .qv-item > summary b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.${ROOT_CLASS} .qv-item.qv-stale { border-color: var(--dsw-alias-state-warn-label); }
.${ROOT_CLASS} .qv-tag { color: var(--dsw-alias-state-warn-label); }
.${ROOT_CLASS} .qv-edit { margin-left: auto; border: none; background: none; padding: 0; color: var(--dsw-alias-state-business-primary); font: inherit; cursor: pointer; }
.${ROOT_CLASS} pre { margin: 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; font-family: var(--dsw-font-mono, monospace); font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-layer-1); border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${ROOT_CLASS} .qv-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-left: 12px; }
`

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly view: PromptView }

async function fetchView(sessionId: string, signal: AbortSignal): Promise<PromptView> {
  // 相对路径：DSH 可能挂在子路径下（与 experimental-inspector 的写法一致）。
  const response = await fetch(`${PROMPT_VIEW_PATH.slice(1)}?session=${encodeURIComponent(sessionId)}`, { signal, cache: 'no-store' })
  const body = await response.json().catch(() => undefined) as (PromptView & { message?: string }) | undefined
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`)
  return body as PromptView
}

const SELF_SOURCE = 'dsh-qqbot'
const sourceOf = (part: PromptViewPart) => part.owner === 'qqbot' ? SELF_SOURCE : part.source ?? '未知插件'

/** 这段是否会在下一轮让缓存失效：它的范围到达了第一个不同字符。 */
function isStale(view: PromptView, part: PromptViewPart): boolean {
  return view.lastSent.state === 'changed' && part.start + part.text.length >= view.lastSent.firstDiff
}

const JAILBREAK_PARTS: readonly string[] = [SECTION_NAME.JB_HEAD, SECTION_NAME.JB_MID, SECTION_NAME.JB_TAIL]

/** 这段对应的编辑入口；外部插件和记忆说明没有。 */
function editTarget(view: PromptView, part: PromptViewPart): { readonly label: string; readonly target: EditorTarget } | undefined {
  if (part.name === SECTION_NAME.PERSONA && view.roleId !== undefined) return { label: '编辑角色', target: { tab: 'roles', id: view.roleId } }
  if (JAILBREAK_PARTS.includes(part.name)) return { label: '编辑破限预设', target: { tab: 'presets', id: view.presetId } }
  return undefined
}

type Edit = (target: EditorTarget) => void

function PartItem({ view, part, onEdit }: { readonly view: PromptView; readonly part: PromptViewPart; readonly onEdit: Edit }) {
  const stale = isStale(view, part)
  const edit = editTarget(view, part)
  return <details className={`qv-item${stale ? ' qv-stale' : ''}`}>
    <summary>
      <b>{part.name}</b>
      <span>order {part.order}</span>
      <span>{sourceOf(part)}</span>
      <span>{part.text.length} 字符</span>
      <span>位置 {part.start}–{part.start + part.text.length}</span>
      {stale && <span className="qv-tag">下一轮缓存从这里失效</span>}
      {edit !== undefined && <button type="button" className="qv-edit"
        onClick={(event) => { event.preventDefault(); onEdit(edit.target) }}>{edit.label}</button>}
    </summary>
    <pre>{part.text}</pre>
  </details>
}

function SystemParts({ view, bySource, onEdit }: { readonly view: PromptView; readonly bySource: boolean; readonly onEdit: Edit }) {
  const parts = view.system.parts
  if (parts.length === 0) return <div className="qv-empty">没有内容</div>
  if (!bySource) return <>{parts.map(part => <PartItem key={part.name} view={view} part={part} onEdit={onEdit} />)}</>
  const groups = new Map<string, PromptViewPart[]>()
  for (const part of parts) groups.set(sourceOf(part), [...groups.get(sourceOf(part)) ?? [], part])
  return <>{[...groups].map(([source, list]) => (
    <details key={source} className="qv-group" open>
      <summary>{source} · {list.length} 段 · {list.reduce((sum, part) => sum + part.text.length, 0)} 字符</summary>
      {list.map(part => <PartItem key={part.name} view={view} part={part} onEdit={onEdit} />)}
    </details>
  ))}</>
}

function LastSentState({ view }: { readonly view: PromptView }) {
  const last = view.lastSent
  if (last.state === 'none') return <div className="qv-state">本次启动后这个会话还没有发出请求，下面是下一轮将要发送的内容。</div>
  if (last.state === 'same') return <div className="qv-state">和上一轮发给模型的系统提示词一致，下一轮前缀缓存可以命中。</div>
  const part = view.system.parts.find(p => p.start + p.text.length >= last.firstDiff)
  return <div className="qv-state qv-warn">
    和上一轮不同：从第 {last.firstDiff} 个字符{part === undefined ? '' : `（${part.name}）`}开始变化，下一轮这之后的前缀缓存会失效。上一轮共 {last.previousLength} 字符。
  </div>
}

function ViewerBody({ load, bySource, onEdit }: { readonly load: Load; readonly bySource: boolean; readonly onEdit: Edit }) {
  if (load.kind === 'loading') return <div className="qv-empty">加载中…</div>
  if (load.kind === 'error') return <div className="qv-state qv-warn">{load.message}</div>
  const { view } = load
  return <>
    <LastSentState view={view} />
    <details className="qv-group" open>
      <summary>系统提示词 · {view.system.parts.length} 段 · {view.system.length} 字符</summary>
      <SystemParts view={view} bySource={bySource} onEdit={onEdit} />
    </details>
    <details className="qv-group" open>
      <summary>runtime context · {view.contexts.length} 条（不影响系统提示词前缀）</summary>
      {view.contexts.length === 0
        ? <div className="qv-empty">没有内容</div>
        : view.contexts.map(item => <details key={item.name} className="qv-item">
          <summary><b>{item.name}</b>{item.source !== undefined && <span>{item.source}</span>}<span>{item.text.length} 字符</span></summary>
          <pre>{item.text}</pre>
        </details>)}
    </details>
    <details className="qv-group">
      <summary>工具 · {view.tools.length} 个（取自上一次请求）</summary>
      {view.tools.length === 0
        ? <div className="qv-empty">还没有请求</div>
        : view.tools.map(tool => <details key={tool.name} className="qv-item">
          <summary><b>{tool.name}</b><span>{tool.description.length + JSON.stringify(tool.parameters).length} 字符</span></summary>
          <pre>{tool.description}{'\n\n'}{JSON.stringify(tool.parameters, null, 2)}</pre>
        </details>)}
    </details>
  </>
}

/** 标题栏"角色与预设"按钮：有角色时定位到当前角色，否则到当前预设。 */
function libraryTarget(load: Load): EditorTarget {
  if (load.kind !== 'ready') return { tab: 'roles' }
  const { roleId, presetId } = load.view
  return roleId !== undefined ? { tab: 'roles', id: roleId } : { tab: 'presets', id: presetId }
}

function ViewerDialog({ sessionId, onClose, onEdit }: { readonly sessionId: string; readonly onClose: () => void; readonly onEdit: Edit }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [bySource, setBySource] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setLoad({ kind: 'loading' })
    fetchView(sessionId, abort.signal).then(
      view => { setLoad({ kind: 'ready', view }) },
      (error: unknown) => { if (!abort.signal.aborted) setLoad({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { abort.abort() }
  }, [sessionId, generation])
  const copy = useCallback(() => {
    if (load.kind !== 'ready') return
    void navigator.clipboard.writeText(load.view.system.parts.map(part => part.text).join('\n\n'))
  }, [load])

  return <Modal open onClose={onClose} title="提示词查看器" closeLabel="关闭" className={ROOT_CLASS}
    description="当前 QQ 会话发给模型的内容，只读。角色和破限预设的段落可以跳到编辑器；外部插件的内容到插件设置里改。">
    <div className="qv-body">
      <div className="qv-bar">
        <Button size="sm" variant={bySource ? 'ghost' : 'outline'} onClick={() => { setBySource(false) }}>按段落</Button>
        <Button size="sm" variant={bySource ? 'outline' : 'ghost'} onClick={() => { setBySource(true) }}>按来源</Button>
        <span className="qv-grow" />
        <Button size="sm" variant="ghost" onClick={() => { onEdit(libraryTarget(load)) }}>角色与预设</Button>
        <Button size="sm" variant="ghost" disabled={load.kind !== 'ready'} onClick={copy}>复制系统提示词</Button>
        <Button size="sm" variant="ghost" icon={<IconRefreshOutlineRegular size={14} />} onClick={() => { setGeneration(n => n + 1) }}>刷新</Button>
      </div>
      <ViewerBody load={load} bySource={bySource} onEdit={onEdit} />
    </div>
  </Modal>
}

export interface PromptViewerInjected {
  readonly openEditor: OpenEditor
}

export type PromptViewerButtonProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<PromptViewerInjected>

/** 只在 qqbot 会话里出现；标准会话返回 null，不渲染任何东西。 */
export function PromptViewerButton({ sessionId, useSessions, openEditor }: PromptViewerButtonProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const [open, setOpen] = useState(false)
  if (preset !== PRESET_ID) return null
  return <>
    <Tooltip label="提示词查看器" side="bottom">
      <Button size="sm" variant="toolbar" aria-label="提示词查看器" icon={<IconContextInjectionOutlineRegular size={16} />}
        onClick={() => { setOpen(true) }} />
    </Tooltip>
    {open && <ViewerDialog sessionId={sessionId} onClose={() => { setOpen(false) }}
      onEdit={(target) => { setOpen(false); openEditor(target) }} />}
  </>
}
