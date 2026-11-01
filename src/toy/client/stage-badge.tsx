/** 气泡旁只读标注，参考旧 dsh-serveu 的 client/stage-display.jsx；同一作者，以 MIT 重写。 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ToyController, QqbotSegments } from './controller.ts'
import { countdownLabel, historicalAction, type SegmentAnnotationProps } from './stage-display.ts'

export function StageBadge({ controller, session, reply, stages, index, playback }: SegmentAnnotationProps & { controller: ToyController }) {
  const toy = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [, tick] = useState(0)
  const options = toy.settings?.display ?? { actions: false, countdown: false }
  const state = playback()
  const tail = controller.tailPlayback(session, reply, index)
  const ticking = options.countdown && index === state?.index && (state.status === 'running' && state.remainingMs > 0
    || state.status === 'complete' && tail !== undefined && !tail.paused)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => { tick(value => value + 1) }, 100)
    return () => { clearInterval(timer) }
  }, [ticking])
  const action = options.actions ? controller.stageAction(session, reply, index) ?? historicalAction(stages, index) : undefined
  const timer = options.countdown ? countdownLabel(index, state, tail) : undefined
  if (action === undefined && timer === undefined) return null
  // 生成内容不进入 DOM 文本节点和正文复制源；可访问名称供读屏使用。
  return <span className="dsh-toy-stage-info" role="note" aria-label={`第 ${index + 1} 段：${[action, timer].filter(Boolean).join('；')}`}>
    {action !== undefined && <span aria-hidden="true" data-label={action} />}
    {timer !== undefined && <span aria-hidden="true" data-label={timer} />}
  </span>
}

/** 两项都关闭时撤掉整个插槽，QQbot 随之删除挂点；停用时取消订阅和登记。 */
export function installStageBadges(segments: QqbotSegments, controller: ToyController): () => void {
  const annotate = segments.annotate?.bind(segments)
  if (annotate === undefined) return () => {}
  const Badge = (props: SegmentAnnotationProps) => <StageBadge {...props} controller={controller} />
  let remove: (() => void) | undefined
  const refresh = () => {
    const options = controller.getSnapshot().settings?.display
    const enabled = controller.getSnapshot().enabled && (options?.actions === true || options?.countdown === true)
    if (enabled && remove === undefined) remove = annotate(Badge)
    else if (!enabled && remove !== undefined) { remove(); remove = undefined }
  }
  const unsubscribe = controller.subscribe(refresh)
  refresh()
  return () => { unsubscribe(); remove?.() }
}

export const STAGE_CSS = `
[data-qqbot] [data-qqbot-reply] .dsh-toy-stage-info {
  display: flex; flex-wrap: wrap; gap: 2px 12px; margin: -2px 0 8px; padding: 0 4px;
  color: var(--dsw-alias-text-secondary, #777); font-size: 11px; line-height: 1.6;
  font-variant-numeric: tabular-nums; user-select: none; overflow-wrap: anywhere;
}
[data-qqbot] [data-qqbot-reply] .dsh-toy-stage-info > span::before { content: attr(data-label); }
`
