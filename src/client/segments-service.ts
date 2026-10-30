/**
 * 浏览器端 `ctx.qqbotSegments`：其他插件接入 [qq] 分段显示时钟的可选服务（例如设备插件按段落动作）。
 * 只有 qqbot 会话的实时回复会触发回调；标准会话和历史回复不触发。
 *
 * 是 cordis Service：方法里的 this.ctx 是调用方的 Context，登记和暂停都随调用方插件停用自动撤销。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ReplyClock, SegmentHooks } from './reply-clock.ts'
import type { ComponentType } from 'react'
import type { SegmentAnnotations, SegmentAnnotationProps } from './segment-annotations.tsx'

export type { SegmentEndReason, SegmentHooks, SegmentStage } from './reply-clock.ts'

/** 外部插件用 `ctx.inject(['qqbotSegments'], ...)` 可选接入的接口。 */
export interface QqbotSegments {
  /** 只读气泡旁显示组件。随调用方停用撤销，不改变消息正文或设备行为。 */
  annotate(component: ComponentType<SegmentAnnotationProps>): () => void
  /** 登记回调，返回撤销函数。调用方插件停用时自动撤销。 */
  register(hooks: SegmentHooks): () => void
  /** 暂停这个会话的逐段显示，返回恢复函数。调用方插件停用时自动恢复。 */
  pause(session: string): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qqbotSegments: QqbotSegments
  }
}

export class SegmentsService extends Service implements QqbotSegments {
  private readonly clock: ReplyClock
  private readonly annotations: SegmentAnnotations | undefined

  constructor(ctx: Context, config: { clock: ReplyClock; annotations?: SegmentAnnotations }) {
    super(ctx, 'qqbotSegments')
    this.clock = config.clock
    this.annotations = config.annotations
  }

  annotate(component: ComponentType<SegmentAnnotationProps>): () => void {
    const annotations = this.annotations
    return this.ctx.effect(() => annotations?.register(component) ?? (() => {}), 'qqbotSegments: annotation')
  }

  register(hooks: SegmentHooks): () => void {
    const clock = this.clock
    return this.ctx.effect(() => clock.register(hooks), 'qqbotSegments: hooks')
  }

  pause(session: string): () => void {
    const clock = this.clock
    return this.ctx.effect(() => clock.pause(session), 'qqbotSegments: pause')
  }
}
