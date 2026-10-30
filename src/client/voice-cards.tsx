/**
 * 回复里的语音条：在每个文字气泡前面插一个语音条气泡，按设置隐藏原来的文字。只在 qqbot 会话的回复里用（segments.tsx）。
 * 语音条是插进 DSH 渲染结果里的节点，用 portal 渲染；文字气泡本身不改，关掉语音或停用插件时去掉插入的节点就复原。
 * 外观迁移自 dsh-qq-skin（MIT，lispking）的 src/client/fish-voice.ts（QQ_FISH_VOICE_CSS 和时长、宽度算法）。
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { VoiceDisplay } from '../voice-types.ts'
import type { Clip, VoicePlayer } from './voice-player.ts'

/** 插进去的语音条节点，和被隐藏的文字气泡。样式见 qq-style.ts。 */
export const VOICE_HOST_ATTRIBUTE = 'data-qqbot-voice'
export const VOICE_HIDDEN_ATTRIBUTE = 'data-qqbot-voice-hidden'

/** 一个文字气泡：bubble 在这条回复里唯一；clip 为空表示这个气泡没有可读的话（例如只有动作描写），照常显示文字。 */
export interface VoiceBubble {
  readonly bubble: string
  readonly clip: Clip | undefined
}

/** 回复里的文字气泡节点，顺序和正文块一致。推理过程不在这一层，不算。 */
function markdownNodes(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(':scope > div > div > [class*="_markdown_"]')]
}

export function voiceWidth(duration: number): number {
  return Math.min(240, 96 + Math.max(0, duration - 1) * 8)
}

function label(state: ReturnType<VoicePlayer['status']>['state'], duration: number | undefined): string {
  if (state === 'loading') return '生成中'
  if (state === 'error') return '重试'
  return duration === undefined ? '语音' : `${Math.max(1, Math.ceil(duration))}"`
}

function VoiceCard({ owner, item, items, player }: {
  readonly owner: string
  readonly item: VoiceBubble & { readonly clip: Clip }
  readonly items: readonly VoiceBubble[]
  readonly player: VoicePlayer
}) {
  useSyncExternalStore(player.subscribe, player.getVersion)
  const status = player.status(item.clip.key)
  const active = player.isActive(owner, item.clip.key)
  const duration = status.state === 'ready' || status.state === 'playing' ? status.duration : undefined
  const state = active ? status.state === 'playing' ? 'playing' : 'pending' : status.state
  const onClick = () => {
    if (active) { player.stop(); return }
    const voiced = items.filter((entry): entry is VoiceBubble & { readonly clip: Clip } => entry.clip !== undefined)
    const start = voiced.findIndex(entry => entry.bubble === item.bubble)
    void player.playFrom(owner, voiced.map(entry => entry.clip), Math.max(0, start), voiced.map(entry => entry.bubble))
  }
  return <>
    <button type="button" data-state={state} style={{ width: `${voiceWidth(duration ?? 0)}px` }}
      aria-label={active ? '停止播放' : '播放语音，接着播放本条回复的其他语音'} onClick={onClick}>
      <span aria-hidden="true">{state === 'playing' ? 'Ⅱ' : state === 'pending' ? '…' : '▶'}</span>
      <span data-wave aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</span>
      <span data-duration>{label(status.state, duration)}</span>
    </button>
    {status.state === 'error' && !active && <div data-error role="status">{status.message}</div>}
  </>
}

/**
 * 给一条回复挂语音条。每次渲染后对一遍：文字气泡和 items 一一对应时，在每个有 clip 的气泡前面放一个语音条；
 * 对不上（例如正在流式输出、推理过程单独成组）或 items 为空时，去掉插入的节点，文字照常显示。
 * live：这条回复是本页打开后生成的；pregenerate 开着时在后台把每句先生成好。
 */
export function useVoiceCards({ root, owner, items, player, display, live, pregenerate }: {
  readonly root: RefObject<HTMLElement | null>
  readonly owner: string
  readonly items: readonly VoiceBubble[]
  readonly player: VoicePlayer
  readonly display: VoiceDisplay
  readonly live: boolean
  readonly pregenerate: boolean
}): ReactNode {
  const [hosts, setHosts] = useState<readonly HTMLElement[]>([])
  const inserted = useRef(new Map<string, HTMLElement>())
  useSyncExternalStore(player.subscribe, player.getVersion)

  useLayoutEffect(() => {
    const element = root.current
    const nodes = element === null ? [] : markdownNodes(element)
    const usable = items.some(item => item.clip !== undefined) && nodes.length === items.length
    const next: HTMLElement[] = []
    const keep = new Set<HTMLElement>()
    if (usable) {
      items.forEach((item, index) => {
        const node = nodes[index]!
        if (item.clip === undefined) {
          node.removeAttribute(VOICE_HIDDEN_ATTRIBUTE)
          next.push(node)
          return
        }
        let host = inserted.current.get(item.bubble)
        if (host === undefined) {
          host = document.createElement('div')
          host.setAttribute(VOICE_HOST_ATTRIBUTE, '')
          inserted.current.set(item.bubble, host)
        }
        if (host.nextElementSibling !== node) node.before(host)
        keep.add(host)
        next.push(host)
        const hidden = display === 'voice-only' || (display === 'voice' && !player.isRevealed(item.bubble))
        if (hidden !== node.hasAttribute(VOICE_HIDDEN_ATTRIBUTE)) node.toggleAttribute(VOICE_HIDDEN_ATTRIBUTE, hidden)
      })
    } else {
      for (const node of nodes) node.removeAttribute(VOICE_HIDDEN_ATTRIBUTE)
    }
    for (const [bubble, host] of inserted.current) {
      if (!keep.has(host)) { host.remove(); inserted.current.delete(bubble) }
    }
    setHosts(previous => previous.length === next.length && previous.every((host, index) => host === next[index]) ? previous : next)
  })

  // 回复离开页面时停下它的语音，去掉插入的节点。
  useEffect(() => () => {
    player.leave(owner)
    for (const host of inserted.current.values()) host.remove()
    inserted.current.clear()
  }, [player, owner])

  const pending = live && pregenerate ? items.flatMap(item => item.clip === undefined ? [] : [item.clip]) : []
  const pendingKey = pending.map(clip => clip.key).join('\n')
  useEffect(() => {
    // 失败时状态已经记下，语音条上显示"重试"。
    for (const clip of pending) player.prepare(clip).catch(() => {})
  }, [player, pendingKey])

  return hosts.map((host, index) => {
    const item = items[index]
    if (item?.clip === undefined || !host.hasAttribute(VOICE_HOST_ATTRIBUTE)) return null
    return createPortal(<VoiceCard owner={owner} item={item as VoiceBubble & { readonly clip: Clip }} items={items} player={player} />, host, item.bubble)
  })
}
