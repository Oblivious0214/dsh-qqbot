import type { SocketLike } from '../client/buttplug.ts'
import { RemoteExecutor } from './executor.ts'
import { decode, remoteAddress, string } from './protocol.ts'

export interface Credentials { token?: string; pairCode?: string }
/** 主动 WSS；不自动重连，用户重新接入时申请全新租约。 */
export class RemoteConnector {
  private socket: SocketLike | undefined
  private epoch = 0
  private timeout: ReturnType<typeof setTimeout> | undefined
  status = '未接入'
  invalidated(): void {
    const epoch = this.epoch
    queueMicrotask(() => { if (epoch === this.epoch && !this.executor.online) this.disconnect() })
  }
  constructor(private readonly executor: RemoteExecutor,
    private readonly saveToken: (token: string) => void = () => {},
    private readonly createSocket: (url: string) => SocketLike = url => new WebSocket(url) as unknown as SocketLike,
    private readonly allowLoopback = false) {}
  connect(address: string, name: string, credentials: Credentials): void {
    const url = remoteAddress(address, this.allowLoopback)
    if (Boolean(credentials.token) === Boolean(credentials.pairCode)) throw new Error('请提供配对码')
    string(name, 80)
    this.disconnect()
    this.executor.arm()
    const token = ++this.epoch
    const socket = this.createSocket(url)
    this.socket = socket; this.status = '正在接入'
    const current = () => this.epoch === token && this.socket === socket
    this.timeout = setTimeout(() => { if (current()) this.fail('连接超时') }, 10000)
    socket.addEventListener('open', () => {
      if (!current()) return
      socket.send(JSON.stringify({ v: 1, type: 'hello', name, ...credentials }))
    })
    socket.addEventListener('message', event => {
      if (!current()) return
      try {
        if (typeof event.data !== 'string') throw new Error('invalid-frame')
        const frame = decode(event.data)
        if (frame.type === 'paired') {
          if (!credentials.pairCode || this.executor.activeLeaseId) throw new Error('unexpected-pairing')
          this.saveToken(string(frame.token, 200)); return
        }
        if (frame.type === 'error') throw new Error('server-rejected')
        const ack = this.executor.receive(frame)
        if (ack && current()) socket.send(JSON.stringify(ack))
        if (this.executor.online) { clearTimeout(this.timeout); this.status = '已接入' }
      } catch { this.fail('连接已停止，请重新接入') }
    })
    socket.addEventListener('error', () => { if (current()) this.fail('连接失败') })
    socket.addEventListener('close', () => { if (current()) this.fail('已断开') })
  }
  pause(): void {
    const leaseId = this.executor.activeLeaseId
    this.executor.pause()
    try { if (leaseId && this.socket?.readyState === 1) this.socket.send(JSON.stringify({ v: 1, type: 'paused', leaseId })) } catch { /* 本地停止已完成。 */ }
    this.disconnect(); this.status = '已暂停'
  }
  disconnect(): void {
    ++this.epoch
    clearTimeout(this.timeout)
    const socket = this.socket; this.socket = undefined
    this.executor.disconnect()
    socket?.close()
    this.status = '未接入'
  }
  private fail(message: string): void { this.disconnect(); this.status = message }
}
