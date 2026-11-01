/**
 * Buttplug v3 客户端，只控制一台单轴位移设备（例如 ServeUCentral 的 Intiface 模式）。
 * 没有扫描循环、心跳、重试或自动重连；连接出错就断开，由用户手动重连。
 *
 * 迁移自 dsh-serveu 的 device.js（ButtplugConnection）。协议依据见旧仓库 DEVICE-PROTOCOL.md：
 * 握手 RequestServerInfo（MessageVersion 3）→ RequestDeviceList；位移用 LinearCmd，停止用 StopDeviceCmd。
 * 改动：设备的 StepCount 精度检查从运动生成移到选设备时；时钟可注入，便于测试。
 */

import { HARD_LIMITS } from '../core/config.ts'
import { checkMove, Listeners, type MoveLimits, type MoveResult, type Transport, type TransportState } from './transport.ts'

export const DEFAULT_ADDRESS = 'ws://127.0.0.1:12345'
/** 上一包剩余不到这么多毫秒时视为已经走完。 */
const FINISH_TOLERANCE_MS = 10

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void
}

export interface ButtplugOptions {
  readonly createSocket?: (url: string) => SocketLike
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** 规整服务地址：只接受 ws:// 或 wss://，不带用户名密码。 */
export function normalizeAddress(raw: string): string {
  const text = raw.trim()
  if (text === '') throw new Error('请填写服务地址')
  let url: URL
  try {
    url = new URL(text.includes('://') ? text : `ws://${text}`)
  } catch {
    throw new Error('服务地址无效')
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.hostname === '' || url.username !== '' || url.password !== '') {
    throw new Error('服务地址须为 ws:// 或 wss:// 地址')
  }
  return url.href.replace(/\/$/, '')
}

type DeviceMessages = Record<string, unknown> & { LinearCmd?: { ActuatorType?: unknown; StepCount?: unknown }[] }

interface Pending {
  readonly expected: string
  readonly resolve: (body: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export class ButtplugConnection implements Transport {
  readonly kind = 'buttplug'
  readonly profile = {}
  state: TransportState = Object.freeze({ phase: 'disconnected', message: '未连接', error: '' })
  /** 当前服务地址；未连接时为空串。 */
  address = ''

  private readonly createSocket: (url: string) => SocketLike
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly listeners = new Listeners<TransportState>()
  private socket: SocketLike | undefined
  private connecting: Promise<TransportState> | undefined
  private cancelOpen: ((reason: Error) => void) | undefined
  private readonly pending = new Map<number, Pending>()
  /** 只保存近期指令类别用于拒绝提示，不保存设备名或命令内容。 */
  private readonly sentCommands = new Map<number, string>()
  private readonly devices = new Map<number, DeviceMessages | undefined>()
  private target: number | undefined
  private handshaken = false
  private nextId = 1
  /** 上一包的终点和预计结束时间。没有位置反馈，只能靠它估算下一包的最短时长。 */
  private lastMotion: { position: number; until: number } | undefined

  constructor(options: ButtplugOptions = {}) {
    this.createSocket = options.createSocket ?? (url => new WebSocket(url) as unknown as SocketLike)
    this.timeoutMs = options.timeoutMs ?? 5000
    this.now = options.now ?? (() => Date.now())
  }

  subscribe(listener: (state: TransportState) => void): () => void {
    return this.listeners.add(listener, this.state)
  }

  private setState(phase: TransportState['phase'], message: string, error = ''): void {
    this.state = Object.freeze({ phase, message, error })
    this.listeners.emit(this.state)
  }

  connect(raw: string = DEFAULT_ADDRESS): Promise<TransportState> {
    let address: string
    try { address = normalizeAddress(raw) } catch (error) { return Promise.reject(error) }
    if (this.socket !== undefined) {
      if (address !== this.address) return Promise.reject(new Error('请先断开当前连接，再更换服务地址'))
      return this.connecting ?? Promise.resolve(this.state)
    }
    this.address = address
    this.setState('connecting', '正在连接…')
    let socket: SocketLike
    try {
      socket = this.createSocket(address)
    } catch {
      this.address = ''
      this.setState('disconnected', '连接失败', '无法打开 WebSocket，请检查地址及浏览器权限')
      return Promise.reject(new Error(this.state.error))
    }
    this.socket = socket
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      try { this.receive(event.data) } catch { this.end(socket, '服务端返回了无效的 Buttplug 消息') }
    })
    socket.addEventListener('error', () => { this.end(socket, '连接失败，请检查服务是否启动、IP/端口及浏览器权限') })
    socket.addEventListener('close', () => { this.end(socket, '服务连接已断开，请手动重新连接') })
    const opening = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.end(socket, '连接超时，请检查服务地址') }, this.timeoutMs)
      this.cancelOpen = (reason) => { clearTimeout(timer); reject(reason) }
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        if (this.socket !== socket) return
        this.cancelOpen = undefined
        resolve()
      }, { once: true })
    })
    const work = (async () => {
      try {
        await opening
        const info = await this.request('RequestServerInfo', { ClientName: 'DSH buttplug', MessageVersion: 3 }, 'ServerInfo')
        if (info['MessageVersion'] !== 3) throw new Error('服务端未接受 Buttplug v3')
        const ping = info['MaxPingTime']
        if (!Number.isInteger(ping) || (ping as number) < 0) throw new Error('服务端未提供有效的心跳要求')
        if (ping !== 0) throw new Error(`服务端要求每 ${String(ping)} 毫秒发送心跳；本客户端不发送心跳，请在服务端关闭后重连`)
        await this.request('RequestDeviceList', {}, 'DeviceList')
        this.handshaken = true
        this.select()
        return this.state
      } catch (error) {
        this.end(socket, error instanceof Error ? error.message : String(error))
        throw error
      } finally {
        if (this.socket === socket) this.connecting = undefined
      }
    })()
    this.connecting = work
    return work
  }

  private request(type: string, fields: Record<string, unknown>, expected = 'Ok'): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) return Promise.reject(new Error('服务尚未连接'))
    const Id = this.nextId++
    return new Promise((resolve, reject) => {
      const label = type === 'RequestServerInfo' ? '服务握手' : '读取设备列表'
      const timer = setTimeout(() => { this.end(socket, `${label}响应超时，连接已关闭；请检查设备服务后重连`) }, this.timeoutMs)
      this.pending.set(Id, { expected, resolve, reject, timer })
      try { socket.send(JSON.stringify([{ [type]: { Id, ...fields } }])) } catch { this.end(socket, '指令发送失败，连接已关闭') }
    })
  }

  private receive(raw: unknown): void {
    const messages: unknown = JSON.parse(String(raw))
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Invalid envelope')
    for (const message of messages) {
      if (message === null || typeof message !== 'object' || Object.keys(message).length !== 1) throw new Error('Invalid message')
      const [type, body] = Object.entries(message as Record<string, Record<string, unknown>>)[0]!
      const id = body?.['Id']
      if (body === null || typeof body !== 'object' || !Number.isInteger(id) || (id as number) < 0) throw new Error('Invalid id')
      const request = this.pending.get(id as number)
      const sentType = this.sentCommands.get(id as number)
      if (type === 'Ok' || type === 'Error') this.sentCommands.delete(id as number)
      if (id !== 0 && request === undefined && type !== 'Error') continue
      if (request !== undefined && type !== request.expected && type !== 'Error') throw new Error('Unexpected response')
      if (type === 'DeviceList') {
        if (!Array.isArray(body['Devices'])) throw new Error('Invalid devices')
        this.devices.clear()
        for (const device of body['Devices'] as Record<string, unknown>[]) this.addDevice(device)
      } else if (type === 'DeviceAdded' && id === 0) this.addDevice(body)
      else if (type === 'DeviceRemoved' && id === 0) this.devices.delete(body['DeviceIndex'] as number)
      if (['DeviceList', 'DeviceAdded', 'DeviceRemoved'].includes(type) && this.handshaken) this.select()
      if (request !== undefined) {
        this.pending.delete(id as number)
        clearTimeout(request.timer)
        if (type === 'Error') {
          // 不回显服务端文字：可能含设备名或不可信内容。
          const code = Number.isInteger(body['ErrorCode']) ? String(body['ErrorCode']) : '未知'
          const error = new Error(`服务端拒绝了请求（错误码 ${code}）`)
          this.setState(this.state.phase, this.state.message, error.message)
          request.reject(error)
        } else request.resolve(body)
      } else if (type === 'Error') {
        const code = Number.isInteger(body['ErrorCode']) ? String(body['ErrorCode']) : '未知'
        const label = sentType === 'LinearCmd' ? '运动指令' : sentType === 'StopDeviceCmd' ? '停止指令' : '连接或未能定位的指令'
        this.end(this.socket, `服务端拒绝了${label}（错误码 ${code}），连接已关闭；${sentType === 'StopDeviceCmd' ? '无法确认设备已停止，请在设备端停止并检查服务' : '请检查设备服务后手动重连'}`)
      }
    }
  }

  private addDevice(device: Record<string, unknown>): void {
    const index = device['DeviceIndex']
    if (!Number.isInteger(index) || (index as number) < 0) throw new Error('Invalid device')
    // 设备名不保存也不显示。
    this.devices.set(index as number, device['DeviceMessages'] as DeviceMessages | undefined)
  }

  private select(): void {
    const linear = [...this.devices].filter(([, messages]) => Array.isArray(messages?.LinearCmd) && messages.LinearCmd.length > 0)
    if (linear.length === 0) return this.selectTarget(undefined, this.target === undefined ? '服务已连接，等待可用位移轴' : '原位移设备已移除或不再提供位移轴')
    const [index, messages] = linear[0]!
    const axes = messages!.LinearCmd!
    if (linear.length !== 1 || axes.length !== 1) {
      return this.selectTarget(undefined, '服务已连接', '检测到多个位移设备或多个轴，无法唯一确定；请让服务端只提供一个单轴设备')
    }
    if (axes[0]!.ActuatorType !== 'Position' || !Object.hasOwn(messages!, 'StopDeviceCmd')) {
      return this.selectTarget(undefined, '服务已连接', '设备未声明兼容的位移轴或停止指令')
    }
    const steps = axes[0]!.StepCount
    if (!Number.isInteger(steps) || (steps as number) < 100 || (steps as number) % 100 !== 0) {
      return this.selectTarget(undefined, '服务已连接', '位移轴精度不足：StepCount 须为 100 的整数倍')
    }
    this.selectTarget(index, '')
  }

  private selectTarget(target: number | undefined, message: string, error = ''): void {
    if (target !== this.target) {
      // 丢掉目标之前停止仍在场的旧设备；进入 waiting 后播放器已无法再向它发停止。
      if (this.target !== undefined && this.devices.has(this.target)) {
        try { this.send('StopDeviceCmd', { DeviceIndex: this.target }) } catch { return }
      }
      this.lastMotion = undefined
      this.target = target
    }
    // 无关设备的上下线不改变所选轴，也不能清掉它的已知终点。
    this.setState(target === undefined ? 'waiting' : 'ready', message, error)
  }

  async move(position: number, durationMs: number, limits: MoveLimits): Promise<MoveResult> {
    if (this.state.phase !== 'ready' || this.target === undefined) throw new Error('没有可用的单个位移轴')
    checkMove(position, durationMs, limits)
    // 没有位置反馈：上一包还没走完，或停止之后，按 0–100 全程的最坏距离算最短时长。
    const now = this.now()
    // 计时器可能比预定时间早一两毫秒触发，留一点余量，否则会误判为上一包没走完。
    const distance = this.lastMotion !== undefined && this.lastMotion.until <= now + FINISH_TOLERANCE_MS
      ? Math.abs(position - this.lastMotion.position)
      : Math.max(position - HARD_LIMITS.minPosition, HARD_LIMITS.maxPosition - position)
    const minimum = Math.max(1, Math.ceil(distance * 1000 / limits.maxSpeed))
    if (durationMs < minimum) throw new Error(`当前速度上限要求时长至少 ${minimum} 毫秒（未读取实际位置）`)
    this.send('LinearCmd', { DeviceIndex: this.target, Vectors: [{ Index: 0, Duration: durationMs, Position: position / 100 }] })
    this.lastMotion = { position, until: now + durationMs }
    return { remainingMs: durationMs }
  }

  async stop(): Promise<void> {
    this.lastMotion = undefined
    if (this.state.phase !== 'ready' || this.target === undefined) throw new Error('没有可用的单个位移轴')
    this.send('StopDeviceCmd', { DeviceIndex: this.target })
  }

  /** 运动和停止发出即返回，不等服务端的 Ok；连接出错时由 close/error 事件断开。 */
  private send(type: string, fields: Record<string, unknown>): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) throw new Error('服务尚未连接')
    try {
      const Id = this.nextId++
      this.sentCommands.set(Id, type)
      if (this.sentCommands.size > 256) this.sentCommands.delete(this.sentCommands.keys().next().value!)
      socket.send(JSON.stringify([{ [type]: { Id, ...fields } }]))
    } catch {
      const label = type === 'StopDeviceCmd' ? '停止指令' : '运动指令'
      this.end(socket, `${label}发送失败，连接已关闭`)
      throw new Error(`${label}发送失败`)
    }
  }

  disconnect(): void {
    this.end(this.socket, '')
  }

  private end(socket: SocketLike | undefined, error: string): void {
    if (socket !== this.socket) return
    this.socket = undefined
    const reason = new Error(error === '' ? '连接已关闭' : error)
    this.cancelOpen?.(reason)
    this.cancelOpen = undefined
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason) }
    this.pending.clear()
    this.sentCommands.clear()
    this.devices.clear()
    this.target = undefined
    this.lastMotion = undefined
    this.handshaken = false
    this.connecting = undefined
    this.address = ''
    try { socket?.close() } catch { /* 已经关了 */ }
    this.setState('disconnected', error === '' ? '未连接' : '连接不可用', error)
  }
}
