/**
 * 抚物 V0 蓝牙直连（ServeU、VorzePiston），用浏览器的 Web Bluetooth。
 *
 * 迁移自 dsh-serveu 的 bluetooth.js（BluetoothConnection）。协议依据见旧仓库 docs/bluetooth-v0.md 和 NOTICE：
 * - 连接时只写 ASCII `D0`，读出机内行程和速度上限；没有有效 D0 就断开，不允许控制。
 * - 运动包 `[0x01, position, speedCode]`，无回应写入。
 * - 停止只取消还没发出的包，已发出的那一包会走完；不发停止包，不写机内设置，不切广播模式，不升级固件。
 */

import { BLE_DEVICES, bluetoothQuantize, decodeDeviceInfo, decodedSpeed, speedCode, type DeviceInfo } from '../core/bluetooth-codec.ts'
import { HARD_LIMITS } from '../core/config.ts'
import { checkMove, Listeners, type MoveLimits, type MoveResult, type Transport, type TransportState } from './transport.ts'

/** Web Bluetooth 里用到的部分（lib.dom 没有这些类型）。 */
export interface BleCharacteristic {
  readonly properties?: { readonly read?: boolean }
  addEventListener(type: 'characteristicvaluechanged', listener: (event: { target: { value: DataView } }) => void): void
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: { target: { value: DataView } }) => void): void
  startNotifications(): Promise<unknown>
  writeValueWithoutResponse(value: Uint8Array): Promise<void>
  readValue(): Promise<DataView>
}
export interface BleDevice {
  readonly name?: string
  readonly gatt: {
    connect(): Promise<{ getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<BleCharacteristic> }> }>
    disconnect(): void
  }
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void
}
export interface BleApi {
  requestDevice(options: { filters: { name: string }[]; optionalServices: string[] }): Promise<BleDevice>
}

/** 当前页面能不能用蓝牙；能用时返回空串。 */
export function bluetoothUnavailable(): string {
  if (!globalThis.isSecureContext) return '蓝牙连接需要 HTTPS'
  if ((globalThis.navigator as { bluetooth?: unknown } | undefined)?.bluetooth === undefined) return '当前浏览器不支持蓝牙'
  return ''
}

export interface BluetoothOptions {
  readonly bluetooth?: () => BleApi | undefined
  readonly availability?: () => string
  readonly timeoutMs?: number
  readonly now?: () => number
}

export class BluetoothConnection implements Transport {
  readonly kind = 'bluetooth'
  readonly profile = { quantize: bluetoothQuantize }
  state: TransportState = Object.freeze({ phase: 'disconnected', message: '未连接', error: '' })

  private readonly bluetooth: () => BleApi | undefined
  private readonly availability: () => string
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly listeners = new Listeners<TransportState>()
  /** 每次停止、断开加一，作废还在排队的包。 */
  private serial = 0
  /** 每次连接、断开加一，作废迟到的写入结果。 */
  private epoch = 0
  private queue: Promise<unknown> = Promise.resolve()
  private connecting: Promise<TransportState> | undefined
  private device: BleDevice | undefined
  private lost: (() => void) | undefined
  private tx: BleCharacteristic | undefined
  private info: DeviceInfo | undefined
  private lastMotion: { position: number; until: number } | undefined
  private wake: (() => void) | undefined

  constructor(options: BluetoothOptions = {}) {
    this.bluetooth = options.bluetooth ?? (() => (globalThis.navigator as { bluetooth?: BleApi } | undefined)?.bluetooth)
    this.availability = options.availability ?? bluetoothUnavailable
    this.timeoutMs = options.timeoutMs ?? 5000
    this.now = options.now ?? (() => performance.now())
  }

  subscribe(listener: (state: TransportState) => void): () => void {
    return this.listeners.add(listener, this.state)
  }

  private setState(phase: TransportState['phase'], message: string, error = ''): void {
    this.state = Object.freeze({ phase, message, error, ...this.info === undefined ? {} : { hardware: this.info } })
    this.listeners.emit(this.state)
  }

  private timed<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('蓝牙操作超时，请手动重新连接')) }, this.timeoutMs) }),
    ]).finally(() => { clearTimeout(timer) })
  }

  /** 必须在点击事件里同步调用：requestDevice 之前不能有 await，否则浏览器不认用户手势。 */
  connect(): Promise<TransportState> {
    if (this.connecting !== undefined) return this.connecting
    if (this.state.phase === 'ready') return Promise.resolve(this.state)
    const unavailable = this.availability()
    if (unavailable !== '') {
      this.setState('disconnected', '蓝牙不可用', unavailable)
      return Promise.reject(new Error(unavailable))
    }
    const token = ++this.serial
    ++this.epoch
    this.setState('connecting', '正在连接…')
    let selection: Promise<BleDevice>
    try {
      const api = this.bluetooth()
      if (api === undefined) throw new Error('当前浏览器不支持蓝牙')
      selection = api.requestDevice({
        filters: BLE_DEVICES.map(({ name }) => ({ name })),
        optionalServices: BLE_DEVICES.map(({ service }) => service),
      })
    } catch (error) {
      this.setState('disconnected', '连接失败', error instanceof Error ? error.message : String(error))
      return Promise.reject(error)
    }
    const current = () => { if (token !== this.serial) throw new Error('蓝牙连接已取消') }
    const work = (async () => {
      let device: BleDevice | undefined
      let rx: BleCharacteristic | undefined
      let listener: ((event: { target: { value: DataView } }) => void) | undefined
      try {
        device = await selection
        current()
        const profile = BLE_DEVICES.find(item => item.name === device!.name)
        if (profile === undefined) throw new Error('设备不受支持')
        const chosen = device
        this.device = chosen
        this.lost = () => { if (this.device === chosen) this.end('蓝牙已断开，请手动重新连接') }
        chosen.addEventListener('gattserverdisconnected', this.lost)
        const server = await this.timed(Promise.resolve(chosen.gatt.connect()).then((server) => {
          if (this.device !== chosen) { chosen.gatt.disconnect(); throw new Error('蓝牙连接已取消') }
          return server
        }))
        current()
        const service = await this.timed(server.getPrimaryService(profile.service))
        current()
        const tx = await this.timed(service.getCharacteristic(profile.tx))
        current()
        rx = await this.timed(service.getCharacteristic(profile.rx))
        current()
        let resolveInfo!: (info: DeviceInfo) => void
        const response = new Promise<DeviceInfo>((resolve) => { resolveInfo = resolve })
        // 其他通知或格式不对的 D0 直接忽略，绝不自己编机内限制。
        const accept = (value: DataView) => { try { resolveInfo(decodeDeviceInfo(value)) } catch { /* ignore */ } }
        listener = (event) => { accept(event.target.value) }
        rx.addEventListener('characteristicvaluechanged', listener)
        await this.timed(rx.startNotifications())
        current()
        await this.timed(tx.writeValueWithoutResponse(new TextEncoder().encode('D0')))
        current()
        // 有的固件只能读不能通知，读一次。
        if (rx.properties?.read === true) void this.timed(rx.readValue()).then(accept, () => {})
        const info = await this.timed(response)
        current()
        this.info = info
        this.tx = tx
        this.lastMotion = undefined
        this.setState('ready', `已连接 · ${profile.name}`)
        return this.state
      } catch (error) {
        if (token === this.serial) this.end((error as { name?: string }).name === 'NotFoundError' ? '' : error instanceof Error ? error.message : String(error))
        // 选择框或 GATT 连接可能在取消、超时之后才完成。
        if (device !== undefined && this.device !== device) { try { device.gatt.disconnect() } catch { /* 已经断了 */ } }
        throw error
      } finally {
        if (listener !== undefined) rx?.removeEventListener('characteristicvaluechanged', listener)
        if (token === this.serial) this.connecting = undefined
      }
    })()
    this.connecting = work
    return work
  }

  move(position: number, durationMs: number, limits: MoveLimits): Promise<MoveResult> {
    const token = this.serial
    const epoch = this.epoch
    const work = this.queue.catch(() => {}).then(async (): Promise<MoveResult> => {
      if (token !== this.serial) return { remainingMs: 0 }
      if (this.state.phase !== 'ready' || this.info === undefined || this.tx === undefined) throw new Error('蓝牙设备未就绪')
      checkMove(position, durationMs, limits)
      const info = this.info
      // 停止不会打断已发出的包：先等它走完，再发新的。
      while (token === this.serial && this.lastMotion !== undefined && this.lastMotion.until > this.now()) {
        const wait = this.lastMotion.until - this.now()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { this.wake = undefined; resolve() }, wait)
          this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve() }
        })
      }
      if (token !== this.serial) return { remainingMs: 0 }
      const distance = this.lastMotion !== undefined
        ? Math.abs(position - this.lastMotion.position)
        : Math.max(Math.abs(position - HARD_LIMITS.minPosition), Math.abs(HARD_LIMITS.maxPosition - position))
      const cap = Math.min(limits.maxSpeed, info.maxSpeed)
      const code = speedCode(Math.min(cap, Math.max(HARD_LIMITS.minSpeed, distance * 1000 / durationMs)))
      const duration = Math.max(durationMs, Math.ceil(distance * 1000 / decodedSpeed(code)))
      const device = this.device
      const sentAt = this.now()
      try {
        await this.timed(this.tx.writeValueWithoutResponse(Uint8Array.of(1, position, code)))
      } catch (error) {
        if (epoch === this.epoch && this.device === device) this.end(error instanceof Error ? error.message : String(error))
        throw error
      }
      // 写入途中被停止也要记下：这一包已经发出，会走完。
      if (epoch === this.epoch && this.device === device && this.state.phase === 'ready') {
        this.lastMotion = { position, until: sentAt + duration }
      }
      return { remainingMs: Math.max(0, sentAt + duration - this.now()) }
    })
    this.queue = work
    return work
  }

  stop(): Promise<void> {
    ++this.serial
    this.wake?.()
    return Promise.resolve()
  }

  disconnect(): void {
    this.end('')
  }

  private end(error: string): void {
    ++this.serial
    ++this.epoch
    this.wake?.()
    const device = this.device
    this.device = undefined
    this.tx = undefined
    this.info = undefined
    this.lastMotion = undefined
    this.connecting = undefined
    if (device !== undefined) {
      if (this.lost !== undefined) device.removeEventListener('gattserverdisconnected', this.lost)
      try { device.gatt.disconnect() } catch { /* 已经断了 */ }
    }
    this.setState('disconnected', error === '' ? '未连接' : '蓝牙连接不可用', error)
  }
}
