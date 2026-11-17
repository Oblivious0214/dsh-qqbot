import { MotionPlayer, realClock, type Clock } from '../client/player.ts'
import type { Transport } from '../client/transport.ts'
import { parseMotion, type MotionConfig } from '../core/config.ts'
import type { ActionLibrary } from '../motion-library/config.ts'
import { parseServerFrame, sameRoute, type Lease, type Command } from './protocol.ts'

export type Ack = { v: 1; type: 'ack'; leaseId: string; commandId: string; status: 'accepted' | 'duplicate' | 'rejected'; code?: string }

/** 单 owner 本地执行端。guard 同时放在每次实际发包前，覆盖休眠后计时器乱序。 */
export class RemoteExecutor {
  readonly player: MotionPlayer
  paused = true
  private lease: Lease | undefined
  private seq = -1
  private generation = 0
  private turn: string | undefined
  private segment = -1
  private seen = new Set<string>()
  private leaseDeadline = 0
  private motionDeadline = 0
  private anchorMono = 0
  private anchorWall = 0
  private serverOffset = 0
  private armedAt = 0
  private timer: unknown

  constructor(private readonly transport: Transport, config: MotionConfig, library: ActionLibrary,
    private readonly clock: Clock = realClock, private readonly wallNow: () => number = Date.now,
    private readonly onInvalidated: () => void = () => {}, private readonly locallyPresent: () => boolean = () => true) {
    const guarded: Transport = {
      kind: transport.kind, get state() { return transport.state }, profile: transport.profile,
      subscribe: listener => transport.subscribe(listener), connect: address => transport.connect(address),
      stop: () => transport.stop(), disconnect: () => transport.disconnect(),
      move: (position, durationMs, limits) => {
        if (!this.live() || this.clock.now() >= this.motionDeadline) {
          this.invalidate()
          return Promise.reject(new Error('remote-deadline'))
        }
        return transport.move(position, durationMs, limits)
      },
    }
    this.player = new MotionPlayer(guarded, {}, clock)
    this.configure(config)
    this.player.configureLibrary(library)
  }
  configure(config: MotionConfig): void {
    // 远端永远不能关掉超时，待机在远程租约外也不自动启动。
    const { standby: _standby, ...bounded } = parseMotion(config)
    this.player.configure({ ...bounded, autoStopSeconds: 30 })
  }
  get activeLeaseId(): string | undefined { return this.lease?.leaseId }
  get online(): boolean { return this.live() }
  arm(): void { this.invalidate(); this.paused = false; this.armedAt = this.clock.now() }
  pause(): void { this.paused = true; this.invalidate() }
  disconnect(): void { this.paused = true; this.invalidate() }
  dispose(): void { this.disconnect(); this.player.dispose() }
  private invalidate(): void {
    const hadLease = this.lease !== undefined
    this.paused = true
    this.lease = undefined
    this.motionDeadline = 0
    this.clock.clear(this.timer)
    this.player.stop('user')
    if (hadLease) this.onInvalidated()
  }
  private live(): boolean {
    return !this.paused && this.transport.state.phase === 'ready' && this.locallyPresent() && this.lease !== undefined && this.clock.now() < this.leaseDeadline
      && Math.abs((this.wallNow() - this.anchorWall) - (this.clock.now() - this.anchorMono)) < 1500
  }
  private watch(): void {
    this.clock.clear(this.timer)
    this.timer = this.clock.set(() => {
      if (!this.live()) { this.invalidate(); return }
      if (this.motionDeadline > 0 && this.clock.now() >= this.motionDeadline) {
        this.motionDeadline = 0
        this.player.stop('timeout')
      }
      this.watch()
    }, Math.max(1, Math.min(250, this.leaseDeadline - this.clock.now(), this.motionDeadline > 0 ? this.motionDeadline - this.clock.now() : Infinity)))
  }
  receive(raw: unknown): Ack | undefined {
    const frame = parseServerFrame(raw)
    if (frame.type === 'lease') {
      if (this.paused || this.transport.state.phase !== 'ready' || this.lease || frame.seq !== 0 || frame.generation !== 0) throw new Error('lease-not-armed')
      // 握手全部耗时作为网络延迟上界；宁可提早到期，不把迟到包校准成新包。
      const handshakeMs = Math.max(0, this.clock.now() - this.armedAt)
      if (handshakeMs >= frame.expiresAt - frame.serverTime) throw new Error('stale-lease')
      this.lease = frame
      this.seq = 0; this.generation = 0; this.turn = undefined; this.segment = -1; this.seen.clear()
      this.anchorMono = this.clock.now(); this.anchorWall = this.wallNow()
      this.serverOffset = frame.serverTime + handshakeMs - this.anchorWall
      this.leaseDeadline = this.clock.now() + frame.expiresAt - frame.serverTime - handshakeMs
      this.watch()
      return
    }
    const reject = (code: string): Ack | undefined => frame.type === 'command' ? this.ack(frame, 'rejected', code) : undefined
    if (!this.live()) { this.invalidate(); return reject('offline') }
    if (frame.leaseId !== this.lease!.leaseId || !sameRoute(frame.route, this.lease!.route)) return reject('owner-mismatch')
    if (frame.type === 'command' && this.seen.has(frame.commandId)) return this.ack(frame, 'duplicate')
    if (frame.seq <= this.seq) return reject('out-of-order')
    this.seq = frame.seq
    if (frame.type === 'heartbeat') {
      const now = this.wallNow() + this.serverOffset
      if (frame.generation !== this.generation || frame.serverTime > now + 1000 || frame.expiresAt <= now) { this.invalidate(); return }
      this.leaseDeadline = this.clock.now() + Math.min(10000, frame.expiresAt - now)
      this.watch(); return
    }
    if (frame.type === 'cancel') {
      if (frame.generation <= this.generation) return
      this.generation = frame.generation; this.turn = undefined; this.segment = -1
      this.motionDeadline = 0; this.player.stop('user'); return
    }
    if (frame.type !== 'command') return
    const now = this.wallNow() + this.serverOffset
    if (frame.generation !== this.generation) return reject('cancelled')
    if (frame.expiresAt <= now || frame.issuedAt > now + 1000) return reject('expired')
    if ((this.turn !== undefined && frame.turnId !== this.turn) || frame.segment <= this.segment) return reject('segment-order')
    if (this.seen.size >= 10000) { this.invalidate(); return reject('renew-required') }
    this.seen.add(frame.commandId); this.turn = frame.turnId; this.segment = frame.segment
    this.motionDeadline = this.clock.now() + frame.holdMs
    this.player.reveal('stop' in frame.motion ? null : frame.motion, frame.holdMs)
    this.watch()
    return this.ack(frame, 'accepted')
  }
  private ack(command: Command, status: Ack['status'], code?: string): Ack {
    return { v: 1, type: 'ack', leaseId: command.leaseId, commandId: command.commandId, status, ...(code ? { code } : {}) }
  }
}
