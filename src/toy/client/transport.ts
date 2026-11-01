/**
 * 设备传输层的公共接口：Buttplug（WebSocket）和抚物 V0 蓝牙各实现一份。
 * 一次只控制一台单轴位移设备。传输层只负责发包和最后一道限位检查，节奏由 player.ts 决定。
 */

import { HARD_LIMITS, type HardwareLimits } from '../core/config.ts'
import type { MotionProfile } from '../core/motion.ts'

export type TransportPhase = 'disconnected' | 'connecting' | 'waiting' | 'ready'

export interface TransportState {
  readonly phase: TransportPhase
  /** 给用户看的连接进度或故障说明；就绪时可为空。 */
  readonly message: string
  /** 最近一次错误；没有时为空串。 */
  readonly error: string
  /** 设备报告的机内限制（蓝牙 D0）。Buttplug 没有。 */
  readonly hardware?: HardwareLimits
}

/** 这一包允许的行程和速度。传输层按它做最后一道检查，越界直接拒绝，不修正。 */
export interface MoveLimits {
  readonly minPosition: number
  readonly maxPosition: number
  readonly maxSpeed: number
}

export interface MoveResult {
  /** 从现在起，这一包预计还要走多久。 */
  readonly remainingMs: number
}

export interface Transport {
  readonly kind: 'buttplug' | 'bluetooth'
  readonly state: TransportState
  /** 传输方式对速度的量化，交给 motionPackets。 */
  readonly profile: MotionProfile
  subscribe(listener: (state: TransportState) => void): () => void
  connect(address?: string): Promise<TransportState>
  move(position: number, durationMs: number, limits: MoveLimits): Promise<MoveResult>
  /** 停止。Buttplug 发 StopDeviceCmd；蓝牙只取消还没发出的包，已发出的那一包会走完。 */
  stop(): Promise<void>
  disconnect(): void
}

/** 所有传输共用的参数检查。 */
export function checkMove(position: number, durationMs: number, limits: MoveLimits): void {
  const { minPosition: min, maxPosition: max, maxSpeed: speed } = limits
  if (![min, max, speed].every(Number.isInteger) || min < HARD_LIMITS.minPosition || max > HARD_LIMITS.maxPosition
    || min >= max || speed < HARD_LIMITS.minSpeed || speed > HARD_LIMITS.maxSpeed) {
    throw new Error('请提供有效的行程与速度限制')
  }
  if (!Number.isInteger(position) || position < min || position > max) throw new Error('目标位置超出允许行程')
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 2147483647) throw new Error('运动时长无效')
}

/** 订阅者集合，供各传输实现复用。 */
export class Listeners<T> {
  private readonly set = new Set<(value: T) => void>()
  add(listener: (value: T) => void, current: T): () => void {
    this.set.add(listener)
    listener(current)
    return () => { this.set.delete(listener) }
  }
  emit(value: T): void {
    for (const listener of [...this.set]) listener(value)
  }
}
