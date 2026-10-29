/**
 * [qq] 分段回复的显示：qqbot 会话里把助手回复中的 [qq] 块拆成一段段气泡，按 durationMs 依次出现。
 * 标准会话原样交给 DSH 自带的渲染器。
 *
 * 计时和打断的行为迁移自 dsh-qq-skin（MIT，lispking）的 src/client/segments/，按本插件重写：
 * - 只处理 [qq] 块；没有 [qq] 块的回复整条作为一个气泡显示，不按标点自动拆分。
 *   提示词让模型"无需分段时直接正常回复"，这时就是一条消息。
 * - 没写 durationMs 的段落按界面设置的间隔（ui-types.ts 的 segmentDelay）。
 * - 外面包一层 REPLY_ATTRIBUTE 节点，带上这一轮回复时角色的头像或首字（`/role` 换人后旧消息不变），样式见 qq-style.ts。
 * - 历史消息直接全部显示；只有本页打开后生成的回复才按间隔逐段出现。
 * - 用户在逐段显示途中发了新消息，没显示的段落不再出现（和 QQ 里打断对方一样）。只在内存里记，刷新后完整显示。
 */

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps, PresentationInjected } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { FactoryComponentPropsOf, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Interruptions, chatActivity, submissionActivity } from '../vendor/dialogue-timing/interruptions.js'
import { parseTimedReply, stripTimedReply, type TimedReply } from '../vendor/dialogue-timing/protocol.js'
import { segmentDelay } from '../ui-types.ts'
import { imageUrl, REPLY_ATTRIBUTE } from './qq-style.ts'
import type { SessionRole, UiState } from './ui-state.ts'

type ViewProps = ChatNodeViewProps<'assistant-step'> & InjectFace<PresentationInjected>
type NativeProps = ViewProps & Pick<PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'>, 'renderSlot'>

/** 判断会话是不是 qqbot 预设；subscribe 在会话列表变化时通知。 */
export interface QqbotSessionFilter {
  readonly subscribe: (listener: () => void) => () => void
  readonly isQqbot: (sessionId: string) => boolean
}

/** 每条回复的计时。存在组件外，React 重新挂载（滚动、切换会话）后接着走，不从头开始。 */
class ReplyClocks {
  readonly openedAt = Date.now()
  private rows = new Map<string, { source: string; start: number; deadlines: number[]; done: boolean }>()

  /** 返回现在该显示几段，以及多久后显示下一段（全部显示完为 null）。 */
  project(key: string, source: string, reply: TimedReply, live: boolean, delay: (text: string) => number): { count: number; next: number | null } {
    let row = this.rows.get(key)
    if (row === undefined || row.source !== source) {
      let elapsed = 0
      const deadlines = reply.stages.map((stage) => {
        const at = elapsed
        elapsed += stage.durationMs ?? delay(stage.text)
        return at
      })
      row = { source, start: Date.now(), deadlines, done: !live }
      this.rows.set(key, row)
      if (this.rows.size > 500) this.rows.delete(this.rows.keys().next().value!)
    }
    if (row.done) return { count: reply.stages.length, next: null }
    const elapsed = Date.now() - row.start
    const count = row.deadlines.filter(at => at <= elapsed).length
    const next = row.deadlines[count]
    if (next === undefined) row.done = true
    return { count, next: next === undefined ? null : Math.max(1, next - elapsed) }
  }

  clear(): void { this.rows.clear() }
}

/** 插件自己的显示状态：计时、打断、已显示的段落。不写会话，不改消息。 */
class SegmentModel {
  readonly clocks = new ReplyClocks()
  private interruptions = new Interruptions()
  private displays = new Map<string, { session: string; blocks: readonly AssistantBlock[]; frozen: boolean }>()
  private version = 0
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version

  /** 用户发了新消息：这个会话里正在逐段显示的回复停在当前进度。 */
  observeInput(session: string, chat: string, submissions: string): void {
    if (!this.interruptions.observe(session, chat, submissions)) return
    for (const row of this.displays.values()) if (row.session === session) row.frozen = true
    this.version++
    for (const listener of this.listeners) listener()
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
    this.clocks.clear()
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

function createView(model: SegmentModel, filter: QqbotSessionFilter, ui: UiState, Native: ComponentType<NativeProps>) {
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
    const isLive = !reducedMotion() && (live.current || (final?.time ?? 0) > model.clocks.openedAt)

    const decoded = useMemo(() => {
      try { return { reply: parseTimedReply(source), error: '' } }
      catch { return { reply: null, error: '分段回复格式无效，请让 AI 重试。' } }
    }, [source])
    const reply = decoded.reply
    const progress = reply !== null && !running
      ? model.clocks.project(`${props.sessionId}:${final?.messageId ?? displayKey}`, source, reply, isLive, text => segmentDelay(text, ui.settings))
      : null

    const [, tick] = useState(0)
    useEffect(() => {
      if (frozen !== undefined || progress?.next == null) return
      const timer = setTimeout(() => { tick(n => n + 1) }, progress.next)
      return () => { clearTimeout(timer) }
    }, [frozen, source, progress?.count, progress?.next])

    // 流式输出时 [qq] 块还没闭合，先不显示 JSON；块外的文字照常显示。
    const wrapped = /\[(?:qq\]|q?$)/.test(source)
    const blocks = useMemo((): readonly AssistantBlock[] => {
      const others = data.blocks.filter(block => block.kind !== 'text')
      if (reply !== null) {
        const shown = running ? 0 : progress?.count ?? reply.stages.length
        return [...others, ...reply.stages.slice(0, shown).map(stage => ({ kind: 'text' as const, text: stage.text }))]
      }
      if (!wrapped) return data.blocks
      const text = stripTimedReply(source)
      return [...others, { kind: 'text' as const, text: text !== '' || running ? text : decoded.error || '分段回复没有完整生成，请重试。' }]
    }, [data.blocks, reply, running, progress?.count, wrapped, source, decoded.error])

    const projected = frozen ?? blocks
    if (frozen === undefined) model.remember(displayKey, props.sessionId, projected)
    const node = projected === data.blocks ? props.node : { ...props.node, data: { ...data, blocks: projected } }
    return <div {...{ [REPLY_ATTRIBUTE]: '' }} style={avatarStyle(ui, role)}>
      {createElement(Native, { ...props, node, renderSlot: renderSlotFor(props) })}
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
export function installSegments(ctx: Context, filter: QqbotSessionFilter, ui: UiState): void {
  const model = new SegmentModel()
  ctx.effect(() => () => { model.dispose() }, 'qqbot: segment model')

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
      }, createView(model, filter, ui, Native))
    }
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', refresh)
    refresh()
    return () => { unsubscribe(); remove?.() }
  })
}
