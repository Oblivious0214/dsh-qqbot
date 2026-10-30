/**
 * [qq] 分段回复的显示：qqbot 会话里把助手回复中的 [qq] 块拆成一段段气泡，依次出现。
 * 标准会话原样交给 DSH 自带的渲染器。
 *
 * 计时和打断的行为迁移自 dsh-qq-skin（MIT，lispking）的 src/client/segments/，按本插件重写：
 * - 只处理 [qq] 块；没有 [qq] 块的回复整条作为一个气泡显示，不按标点自动拆分。
 *   提示词让模型"无需分段时直接正常回复"，这时就是一条消息。
 * - 段落间隔优先由外部插件提供，兜底按字数计算（ui-types.ts 的 segmentDelay）。
 * - 外面包一层 REPLY_ATTRIBUTE 节点，带上这一轮回复时角色的头像或首字（`/role` 换人后旧消息不变），样式见 qq-style.ts。
 *   没有角色的回复不加 ROLE_ATTRIBUTE，不画头像。
 * - 历史消息直接全部显示；只有本页打开后生成的回复才按间隔逐段出现。计时在 reply-clock.ts，流式时第一段一闭合就显示。
 * - 其他插件通过 ctx.qqbotSegments（segments-service.ts）改写停留时间、收到段落显示的通知、暂停显示。
 * - 用户在逐段显示途中发了新消息，没显示的段落不再出现（和 QQ 里打断对方一样）。只在内存里记，刷新后完整显示。
 * - 这一轮的角色选了音色、语音开着时，已经出现的段落显示成语音条（voice-cards.tsx）。
 */

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentType, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, PresentationInjected } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { FactoryComponentPropsOf, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Interruptions, chatActivity, submissionActivity } from '../vendor/dialogue-timing/interruptions.js'
import { stripTimedReply, type TimedStream } from '../vendor/dialogue-timing/protocol.js'
import { segmentDelay } from '../ui-types.ts'
import { speechText } from '../voice-types.ts'
import { decodeReply } from './decode.ts'
import { imageUrl, REPLY_ATTRIBUTE, ROLE_ATTRIBUTE } from './qq-style.ts'
import { ReplyClock } from './reply-clock.ts'
import { SegmentsService } from './segments-service.ts'
import { SegmentAnnotations, useSegmentAnnotations } from './segment-annotations.tsx'
import type { SessionRole, UiState } from './ui-state.ts'
import { useVoiceCards, type VoiceBubble } from './voice-cards.tsx'
import type { VoicePlayer } from './voice-player.ts'
import type { VoiceState } from './voice-state.ts'

/** 语音条用到的共享状态，index.tsx 创建。 */
export interface SegmentVoice {
  readonly state: VoiceState
  readonly player: VoicePlayer
}

type ViewProps = ChatNodeViewProps<'assistant-step'> & InjectFace<PresentationInjected>
type NativeProps = ViewProps & Pick<PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'>, 'renderSlot'>

/** 判断会话是不是 qqbot 预设；subscribe 在会话列表变化时通知。 */
export interface QqbotSessionFilter {
  readonly subscribe: (listener: () => void) => () => void
  readonly isQqbot: (sessionId: string) => boolean
}

/** 插件自己的显示状态：计时、打断、已显示的段落。不写会话，不改消息。 */
class SegmentModel {
  readonly annotations = new SegmentAnnotations()
  readonly openedAt = Date.now()
  readonly clock: ReplyClock
  private interruptions = new Interruptions()
  private displays = new Map<string, { session: string; blocks: readonly AssistantBlock[]; frozen: boolean }>()
  private version = 0
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version

  constructor(delay: (text: string) => number, onError: (error: unknown) => void) {
    this.clock = new ReplyClock({ delay, onError, onChange: () => { this.notify() } })
  }

  private notify(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** 用户发了新消息：这个会话里正在逐段显示的回复停在当前进度。 */
  observeInput(session: string, chat: string, submissions: string): void {
    if (!this.interruptions.observe(session, chat, submissions)) return
    for (const row of this.displays.values()) if (row.session === session) row.frozen = true
    this.clock.interrupt(session)
    this.notify()
  }

  /** 被打断的回复只显示打断时已经出现的段落；打断后才到的旧回复不显示。 */
  frozen(key: string, session: string, reply: { turn?: number; step?: number }): readonly AssistantBlock[] | undefined {
    const row = this.displays.get(key)
    return row?.frozen === true || this.interruptions.blocked(session, reply) ? row?.blocks ?? [] : undefined
  }

  remember(key: string, session: string, blocks: readonly AssistantBlock[]): void {
    if (this.displays.get(key)?.frozen === true) return
    this.displays.set(key, { session, blocks, frozen: false })
    if (this.displays.size > 500) this.displays.delete(this.displays.keys().next().value!)
  }

  dispose(): void {
    this.listeners.clear()
    this.displays.clear()
    this.clock.dispose()
    this.interruptions = new Interruptions()
  }
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** 外层节点的头像变量：有头像图片用图片，没有用角色名首字。没有角色时不显示头像。 */
function avatarStyle(ui: UiState, role: SessionRole | undefined): CSSProperties | undefined {
  if (role === undefined || role === null) return undefined
  const version = ui.avatarVersion(role.id)
  const vars: Record<string, string> = version === undefined
    ? { '--qqbot-initial': JSON.stringify(Array.from(role.name.trim())[0] ?? '') }
    : { '--qqbot-avatar': `url("${imageUrl('avatar', version, role.id)}")` }
  return vars as CSSProperties
}

function createView(model: SegmentModel, filter: QqbotSessionFilter, ui: UiState, voice: SegmentVoice, Native: ComponentType<NativeProps>) {
  // 包装后拿不到原渲染器的子槽位，改用 DSH 默认的内容工厂（和 dsh-qq-skin 相同）。
  const renderSlotFor = (props: ViewProps): NativeProps['renderSlot'] => (key, owner) => {
    if (key === 'conversation.chat.reasoning.body') {
      return props.renderFactorySlot('conversation.chat.reasoning.content', owner as unknown as { text: string; running: boolean })
    }
    return props.renderFactorySlot('conversation.images.content',
      owner as unknown as Pick<FactoryComponentPropsOf<'conversation.images.content'>, 'images' | 'loadImage' | 'align'>)
  }

  function QqbotSegments(props: ViewProps) {
    useSyncExternalStore(model.subscribe, model.getVersion)
    useSyncExternalStore(ui.subscribe, ui.getVersion)
    useSyncExternalStore(voice.state.subscribe, voice.state.getVersion)
    const root = useRef<HTMLDivElement>(null)
    const data = props.node.data
    const running = data.status === 'running'
    const role = ui.roleAt(props.sessionId, data.turn)
    useEffect(() => { ui.noteTurn(props.sessionId, data.turn) }, [props.sessionId, data.turn])
    const final = data.finalNode
    const source = data.blocks.filter(block => block.kind === 'text').map(block => block.text).join('')
    const displayKey = `${props.sessionId}:${data.turn}:${data.step}`
    const frozen = model.frozen(displayKey, props.sessionId, final ?? data)

    // 本页打开期间生成（见过它在流式输出，或完成时间晚于打开时间）的回复才逐段出现。
    const live = useRef(running)
    if (running) live.current = true
    const isLive = !reducedMotion() && (live.current || (final?.time ?? 0) > model.openedAt)
    const replyId = `${data.turn}:${data.step}`

    // 流式时只取已经闭合的段落。生成结束时没写完的（用户停止生成）按已闭合的段落算作完整。
    // JSON 坏了时尽量显示文字，见 decode.ts。
    const lastGood = useRef<{ reply: string; stream: TimedStream } | undefined>(undefined)
    const decoded = useMemo(() => {
      const previous = lastGood.current?.reply === replyId ? lastGood.current.stream : null
      const result = decodeReply(source, running, previous)
      if (result.stream !== null && !result.stream.stages.some(stage => stage.salvaged === true)) lastGood.current = { reply: replyId, stream: result.stream }
      return result
    }, [source, running, replyId])
    const stream = decoded.stream
    const complete = stream !== null && (stream.complete || !running)

    // 段落交给时钟；时钟自己按计时器推进并通知其他插件，组件只读显示几段。被打断的回复不再喂。
    useEffect(() => {
      if (frozen !== undefined) return
      if (stream !== null) model.clock.feed(props.sessionId, replyId, stream.stages, complete, isLive)
      else if (decoded.error !== '' || !running) model.clock.fail(props.sessionId, replyId)
    }, [frozen !== undefined, stream, complete, running, decoded.error, props.sessionId, replyId])
    const count = model.clock.count(props.sessionId, replyId) ?? (isLive ? 0 : undefined)

    // 流式输出时 [qq] 块还没闭合，先不显示 JSON；块外的文字照常显示。
    const wrapped = /\[(?:qq\]|q?$)/.test(source)
    const blocks = useMemo((): readonly AssistantBlock[] => {
      const others = data.blocks.filter(block => block.kind !== 'text')
      if (stream !== null) {
        return [...others, ...stream.stages.slice(0, count ?? stream.stages.length).map(stage => ({ kind: 'text' as const, text: stage.text }))]
      }
      if (!wrapped) return data.blocks
      const text = stripTimedReply(source)
      return [...others, { kind: 'text' as const, text: text !== '' || running ? text : decoded.error || '分段回复没有完整生成，请重试。' }]
    }, [data.blocks, stream, running, count, wrapped, source, decoded.error])

    const projected = frozen ?? blocks
    if (frozen === undefined) model.remember(displayKey, props.sessionId, projected)
    const node = projected === data.blocks ? props.node : { ...props.node, data: { ...data, blocks: projected } }

    // 语音条：只给已经定下来的文字（闭合的段落，或生成结束的整条回复）。流式中没闭合的文字照常显示。
    const playable = role === undefined || role === null ? undefined : voice.state.playable(role.voice)
    const settled = stream !== null || !running
    const items = useMemo((): readonly VoiceBubble[] => {
      if (playable === undefined || !settled) return []
      return projected.flatMap((block, index) => block.kind !== 'text' ? [] : [{
        bubble: `${displayKey}:${index}`,
        clip: (() => {
          const text = speechText(block.text)
          return text === '' ? undefined : { key: `${playable.revision}
${text}`, voice: playable.voice, text }
        })(),
      }])
    }, [playable?.voice, playable?.revision, settled, projected, displayKey])
    const cards = useVoiceCards({
      root, owner: displayKey, items, player: voice.player, display: voice.state.settings.display,
      live: live.current || (final?.time ?? 0) > model.openedAt, pregenerate: voice.state.settings.pregenerate,
    })

    const hasRole = role !== undefined && role !== null
    const annotations = useSegmentAnnotations({ root, registry: model.annotations, session: props.sessionId, reply: replyId,
      stages: stream?.stages ?? [], visible: stream === null ? 0 : projected.filter(block => block.kind === 'text').length,
      playback: () => model.clock.playback(props.sessionId, replyId),
    })
    const salvaged = stream?.stages.some(stage => stage.salvaged === true) === true
    return <div ref={root} {...{ [REPLY_ATTRIBUTE]: '', ...hasRole ? { [ROLE_ATTRIBUTE]: '' } : {} }} style={avatarStyle(ui, role)}
      title={salvaged ? '格式有误，已尽量显示文字' : undefined}>
      {createElement(Native, { ...props, node, renderSlot: renderSlotFor(props) })}
      {cards}
      {annotations}
    </div>
  }

  return function SegmentView(props: ViewProps) {
    const qqbot = useSyncExternalStore(filter.subscribe, () => filter.isQqbot(props.sessionId))
    if (qqbot) return <QqbotSegments {...props} />
    return createElement(Native, { ...props, renderSlot: renderSlotFor(props) })
  }
}

/** 只在 qqbot 会话里看用户什么时候发了新消息，用来打断逐段显示。 */
function createInputObserver(model: SegmentModel, filter: QqbotSessionFilter) {
  function Observe({ sessionId, useChat, useSession }: Pick<PropsRuntime<'conversation.input.left'>, 'sessionId' | 'useChat' | 'useSession'>) {
    const chat = useChat(chatActivity)
    const submissions = useSession(submissionActivity)
    useLayoutEffect(() => { model.observeInput(sessionId, chat, submissions) }, [sessionId, chat, submissions])
    return null
  }
  return function InputObserver(props: PropsRuntime<'conversation.input.left'>) {
    const qqbot = useSyncExternalStore(filter.subscribe, () => filter.isQqbot(props.sessionId))
    return qqbot ? <Observe sessionId={props.sessionId} useChat={props.useChat} useSession={props.useSession} /> : null
  }
}

/**
 * 包装 DSH 自带的 assistant-step 渲染器（按它声明的子槽位认出来），插件关闭时撤掉。
 * 只认自带的那一个，不去包装别的插件的包装，避免两个插件互相重包。
 */
export function installSegments(ctx: Context, filter: QqbotSessionFilter, ui: UiState, voice: SegmentVoice): void {
  const model = new SegmentModel(text => segmentDelay(text), (error) => { ctx.logger.warn('qqbot segments: %s', error) })
  ctx.effect(() => () => { model.dispose() }, 'qqbot: segment model')
  ctx.plugin(SegmentsService, { clock: model.clock, annotations: model.annotations })

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'qqbot-segments-input', order: 100,
  }, createInputObserver(model, filter)))

  ctx.slots.inject('conversation.chat.node', () => {
    let remove: (() => void) | undefined
    let original: unknown
    const refresh = () => {
      const candidate = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === 'assistant-step'
        && entry.locale === 'chat'
        && entry.children?.['conversation.chat.reasoning.body'] !== undefined
        && entry.children?.['conversation.chat.message.images'] !== undefined)
      if (candidate === original) return
      remove?.()
      remove = undefined
      original = candidate
      if (candidate === undefined || candidate.store !== undefined || candidate.inject === undefined) return
      const Native = candidate.component as ComponentType<NativeProps>
      const inject = candidate.inject as unknown as () => PresentationInjected
      remove = ctx.slots.register({
        name: 'conversation.chat.node', key: 'assistant-step', priority: -30, locale: 'chat', inject, registrant: 'dsh-qqbot',
      }, createView(model, filter, ui, voice, Native))
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', refresh)
    refresh()
    return () => { unsubscribe(); remove?.() }
  })
}
