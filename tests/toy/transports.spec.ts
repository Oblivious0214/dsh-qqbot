import { describe, expect, it, vi } from 'vitest'
import { BluetoothConnection, type BleApi, type BleCharacteristic, type BleDevice } from '../../src/toy/client/bluetooth.ts'
import { ButtplugConnection, normalizeAddress, type SocketLike } from '../../src/toy/client/buttplug.ts'
import { BLE_DEVICES } from '../../src/toy/core/bluetooth-codec.ts'
import { FakeClock, flush } from './fakes.ts'
import { MotionPlayer, type StopCause } from '../../src/toy/client/player.ts'
import { defaultActionLibrary } from '../../src/toy/motion-library/builtins.ts'
import { defaultMotion, RANGES, TIERS } from '../../src/toy/core/config.ts'
import { LAST_STAGE_STOP_MS } from '../../src/toy/core/safety.ts'

const limits = { minPosition: 0, maxPosition: 100, maxSpeed: 500 }

/** 假的 Buttplug 服务端：自动回答握手，记录其余消息。 */
function mockServer(options: { ping?: number; devices?: unknown[]; version?: number } = {}) {
  const sent: Record<string, Record<string, unknown>>[] = []
  const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  const emit = (type: string, data?: unknown) => { for (const listener of listeners.get(type) ?? []) listener({ data }) }
  const reply = (message: unknown) => { queueMicrotask(() => { emit('message', JSON.stringify([message])) }) }
  const socket: SocketLike & { closed: boolean } = {
    readyState: 1,
    closed: false,
    send(data) {
      const [message] = JSON.parse(data) as Record<string, Record<string, unknown>>[]
      sent.push(message!)
      const [type, body] = Object.entries(message!)[0]!
      if (type === 'RequestServerInfo') reply({ ServerInfo: { Id: body['Id'], MessageVersion: options.version ?? 3, MaxPingTime: options.ping ?? 0 } })
      if (type === 'RequestDeviceList') {
        reply({ DeviceList: { Id: body['Id'], Devices: options.devices ?? [stroker(0)] } })
      }
    },
    close() { this.closed = true },
    addEventListener(type, listener) {
      listeners.set(type, [...listeners.get(type) ?? [], listener])
      if (type === 'open') queueMicrotask(() => { listener({}) })
    },
  }
  return { socket, sent, emit, commands: () => sent.filter(m => !('RequestServerInfo' in m) && !('RequestDeviceList' in m)) }
}

const stroker = (index: number, steps = 100) => ({
  DeviceIndex: index, DeviceName: 'secret', DeviceMessages: { LinearCmd: [{ ActuatorType: 'Position', StepCount: steps }], StopDeviceCmd: {} },
})

describe('buttplug', () => {
  it('runs every builtin action through the real player and transport, then stops at the tail deadline', async () => {
    const library = defaultActionLibrary()
    for (const range of RANGES) for (const tier of TIERS) for (const { name: action } of library.library.clips) {
      const clock = new FakeClock()
      const server = mockServer()
      const connection = new ButtplugConnection({ createSocket: () => server.socket, now: () => clock.now() })
      await connection.connect()
      const stops: StopCause[] = []
      const player = new MotionPlayer(connection, { onStop: cause => { stops.push(cause) } }, clock)
      player.configure(defaultMotion())
      player.configureLibrary(library)
      player.reveal({ range, tier, action }, undefined)
      await clock.advance(LAST_STAGE_STOP_MS - 1)
      expect(stops, `${range}/${tier}/${action}`).toEqual([])
      expect(server.commands().length).toBeGreaterThan(1)
      await clock.advance(1)
      expect(stops).toEqual(['timeout'])
      expect(server.commands().at(-1)).toHaveProperty('StopDeviceCmd')
      const count = server.commands().length
      await clock.advance(10000)
      expect(server.commands()).toHaveLength(count)
      player.dispose()
      connection.disconnect()
    }
  })

  it('reports a connection timeout without ever sending movement', async () => {
    vi.useFakeTimers()
    try {
      const socket: SocketLike = { readyState: 0, send: vi.fn(), close: vi.fn(), addEventListener() {} }
      const connection = new ButtplugConnection({ createSocket: () => socket, timeoutMs: 50 })
      const refused = expect(connection.connect()).rejects.toThrow('连接超时')
      await vi.advanceTimersByTimeAsync(50)
      await refused
      expect(connection.state.phase).toBe('disconnected')
      expect(socket.send).not.toHaveBeenCalled()
      expect(socket.close).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('stops playback and disconnects when a motion command is rejected by the server', async () => {
    const clock = new FakeClock()
    const server = mockServer()
    const connection = new ButtplugConnection({ createSocket: () => server.socket, now: () => clock.now() })
    await connection.connect()
    const player = new MotionPlayer(connection, {}, clock)
    player.configure(defaultMotion())
    player.configureLibrary(defaultActionLibrary())
    player.reveal({ range: 'full', tier: 'low', action: '稳定节奏' }, undefined)
    await clock.advance(1)
    const id = server.commands().at(-1)!['LinearCmd']!['Id']
    server.emit('message', JSON.stringify([{ Error: { Id: id, ErrorCode: 1, ErrorMessage: 'secret device name' } }]))
    expect(player.intent).toBeNull()
    expect(connection.state.phase).toBe('disconnected')
    expect(connection.state.error).toContain('拒绝了运动指令（错误码 1）')
    expect(connection.state.error).not.toContain('secret')
    const count = server.commands().length
    await clock.advance(10000)
    expect(server.commands()).toHaveLength(count)
    player.dispose()
  })

  it('reports stop-command rejection without claiming a confirmed stop', async () => {
    const server = mockServer()
    const connection = new ButtplugConnection({ createSocket: () => server.socket })
    await connection.connect()
    await connection.stop()
    const id = server.commands().at(-1)!['StopDeviceCmd']!['Id']
    server.emit('message', JSON.stringify([{ Error: { Id: id, ErrorCode: 4, ErrorMessage: 'secret' } }]))
    expect(connection.state.error).toContain('拒绝了停止指令（错误码 4）')
    expect(connection.state.error).toContain('无法确认设备已停止')
    expect(connection.state.error).not.toContain('secret')
  })

  it('keeps the last position when unrelated device announcements arrive', async () => {
    let now = 0
    const server = mockServer()
    const connection = new ButtplugConnection({ createSocket: () => server.socket, now: () => now })
    await connection.connect()
    await connection.move(50, 500, { ...limits, maxSpeed: 100 })
    now = 500
    server.emit('message', JSON.stringify([{ DeviceAdded: { Id: 0, DeviceIndex: 8, DeviceMessages: {} } }]))
    await expect(connection.move(60, 100, { ...limits, maxSpeed: 100 })).resolves.toEqual({ remainingMs: 100 })
    now = 600
    server.emit('message', JSON.stringify([{ DeviceRemoved: { Id: 0, DeviceIndex: 8 } }]))
    await expect(connection.move(50, 100, { ...limits, maxSpeed: 100 })).resolves.toEqual({ remainingMs: 100 })
    connection.disconnect()
  })

  it('stops the old target before losing unique device selection', async () => {
    const server = mockServer()
    const connection = new ButtplugConnection({ createSocket: () => server.socket })
    await connection.connect()
    await connection.move(50, 1000, limits)
    server.emit('message', JSON.stringify([{ DeviceAdded: { Id: 0, ...stroker(1) } }]))
    expect(connection.state.phase).toBe('waiting')
    expect(server.commands().at(-1)).toMatchObject({ StopDeviceCmd: { DeviceIndex: 0 } })
    await expect(connection.move(50, 1000, limits)).rejects.toThrow()
    connection.disconnect()
  })

  it('normalizes addresses', () => {
    expect(normalizeAddress(' 127.0.0.1:12345 ')).toBe('ws://127.0.0.1:12345')
    for (const bad of ['', 'http://x', 'ws://u:p@x']) expect(() => normalizeAddress(bad)).toThrow()
  })

  it('handshakes, picks the single position axis and sends LinearCmd / StopDeviceCmd', async () => {
    let now = 0
    const server = mockServer({ devices: [stroker(3)] })
    const connection = new ButtplugConnection({ createSocket: () => server.socket, now: () => now })
    await connection.connect('127.0.0.1:12345')
    expect(connection.state.phase).toBe('ready')
    expect(server.sent[0]).toMatchObject({ RequestServerInfo: { ClientName: 'DSH buttplug', MessageVersion: 3 } })
    await connection.move(50, 1000, limits)
    expect(server.commands()[0]).toMatchObject({ LinearCmd: { DeviceIndex: 3, Vectors: [{ Index: 0, Duration: 1000, Position: 0.5 }] } })
    await connection.stop()
    expect(server.commands()[1]).toMatchObject({ StopDeviceCmd: { DeviceIndex: 3 } })
    expect(JSON.stringify(connection.state)).not.toContain('secret')
  })

  it('refuses moves faster than the limit from an unknown position', async () => {
    let now = 0
    const server = mockServer()
    const connection = new ButtplugConnection({ createSocket: () => server.socket, now: () => now })
    await connection.connect()
    // 未知位置按全程最坏距离：到 50 最远 50，限速 100 时至少 500 ms。
    await expect(connection.move(50, 499, { ...limits, maxSpeed: 100 })).rejects.toThrow('至少 500')
    await connection.move(50, 500, { ...limits, maxSpeed: 100 })
    // 上一包还没走完时仍按最坏距离。
    now = 400
    await expect(connection.move(60, 100, { ...limits, maxSpeed: 100 })).rejects.toThrow()
    now = 500
    await connection.move(60, 100, { ...limits, maxSpeed: 100 })
    await expect(connection.move(101, 1000, limits)).rejects.toThrow()
    await expect(connection.move(50, 1000, { ...limits, maxPosition: 40 })).rejects.toThrow('超出')
  })

  it('waits on ambiguous or imprecise devices and rejects heartbeat servers', async () => {
    for (const devices of [[], [stroker(0), stroker(1)], [stroker(0, 50)]]) {
      const server = mockServer({ devices })
      const connection = new ButtplugConnection({ createSocket: () => server.socket })
      await connection.connect()
      expect(connection.state.phase).toBe('waiting')
      await expect(connection.move(50, 1000, limits)).rejects.toThrow()
    }
    const server = mockServer({ ping: 1000 })
    const connection = new ButtplugConnection({ createSocket: () => server.socket })
    await expect(connection.connect()).rejects.toThrow('心跳')
    expect(connection.state.phase).toBe('disconnected')
    expect(server.socket.closed).toBe(true)
  })

  it('drops to waiting when the device is removed and disconnects on close', async () => {
    const server = mockServer()
    const connection = new ButtplugConnection({ createSocket: () => server.socket })
    await connection.connect()
    server.emit('message', JSON.stringify([{ DeviceRemoved: { Id: 0, DeviceIndex: 0 } }]))
    expect(connection.state.phase).toBe('waiting')
    server.emit('close')
    expect(connection.state).toMatchObject({ phase: 'disconnected', error: '服务连接已断开，请手动重新连接' })
  })
})

/** 假的 V0 设备：通知 D0，记录写入。 */
function mockBle(options: { name?: string; d0?: boolean } = {}) {
  const writes: number[][] = []
  let notify: ((event: { target: { value: DataView } }) => void) | undefined
  let lost: (() => void) | undefined
  const info = new DataView(new ArrayBuffer(11))
  info.setUint8(0, 83)
  info.setUint16(5, 8000)
  info.setUint16(7, 2000)
  info.setUint16(9, 300)
  const rx: BleCharacteristic = {
    addEventListener: (_, listener) => { notify = listener },
    removeEventListener: () => { notify = undefined },
    startNotifications: async () => undefined,
    writeValueWithoutResponse: async () => {},
    readValue: async () => info,
  }
  const tx: BleCharacteristic = {
    ...rx,
    writeValueWithoutResponse: async (value) => {
      writes.push([...value])
      if (value.length === 2 && options.d0 !== false) queueMicrotask(() => { notify?.({ target: { value: info } }) })
    },
  }
  const profile = BLE_DEVICES.find(d => d.name === (options.name ?? 'ServeU'))!
  const device: BleDevice & { connected: boolean } = {
    name: options.name ?? 'ServeU',
    connected: false,
    gatt: {
      connect: async () => {
        device.connected = true
        return { getPrimaryService: async (uuid) => {
          expect(uuid).toBe(profile.service)
          return { getCharacteristic: async uuid => uuid === profile.tx ? tx : rx }
        } }
      },
      disconnect: () => { device.connected = false },
    },
    addEventListener: (_, listener) => { lost = listener },
    removeEventListener: () => { lost = undefined },
  }
  const requests: unknown[] = []
  const api: BleApi = { requestDevice: async (request) => { requests.push(request); return device } }
  return { api, device, writes, requests, lose: () => lost?.() }
}

describe('bluetooth', () => {
  it('connects with D0 only and reports device limits', async () => {
    const ble = mockBle()
    const connection = new BluetoothConnection({ bluetooth: () => ble.api, availability: () => '', timeoutMs: 100 })
    await connection.connect()
    expect(connection.state).toMatchObject({ phase: 'ready', hardware: { minPosition: 20, maxPosition: 80, maxSpeed: 300 } })
    expect(ble.writes).toEqual([[68, 48]])
    expect(ble.requests[0]).toMatchObject({ filters: [{ name: 'ServeU' }, { name: 'VorzePiston' }] })
    await connection.stop()
    connection.disconnect()
    expect(ble.writes).toEqual([[68, 48]])
    expect(ble.device.connected).toBe(false)
  })

  it('refuses to arm without a valid D0 reply', async () => {
    const ble = mockBle({ d0: false })
    const connection = new BluetoothConnection({ bluetooth: () => ble.api, availability: () => '', timeoutMs: 30 })
    await expect(connection.connect()).rejects.toThrow('超时')
    expect(connection.state.phase).toBe('disconnected')
    expect(ble.device.connected).toBe(false)
  })

  it('writes [1, position, speedCode] inside the user range and waits for the previous packet', async () => {
    let now = 0
    const ble = mockBle()
    const connection = new BluetoothConnection({ bluetooth: () => ble.api, availability: () => '', timeoutMs: 100, now: () => now })
    await connection.connect()
    await expect(connection.move(10, 1000, { ...limits, minPosition: 20, maxPosition: 80 })).rejects.toThrow('允许行程')
    const first = await connection.move(50, 1000, limits)
    // 未知位置按绝对全程最坏距离 50；机内行程报告不参与控制范围换算。
    expect(ble.writes.at(-1)).toEqual([1, 50, 25])
    expect(first.remainingMs).toBe(1000)
    // 上一包还在走：下一包排队等待；停止作废它，不发停止包。
    const queued = connection.move(60, 1000, limits)
    await flush()
    expect(ble.writes).toHaveLength(2)
    await connection.stop()
    expect(await queued).toEqual({ remainingMs: 0 })
    expect(ble.writes).toHaveLength(2)
    // 上一包走完后再发，距离按已知终点 50 → 60 计算。
    now = 1000
    await connection.move(60, 1000, limits)
    expect(ble.writes.at(-1)).toEqual([1, 60, 5])
    connection.disconnect()
  })

  it('reports a lost device', async () => {
    const ble = mockBle()
    const connection = new BluetoothConnection({ bluetooth: () => ble.api, availability: () => '', timeoutMs: 100 })
    await connection.connect()
    ble.lose()
    await flush()
    expect(connection.state).toMatchObject({ phase: 'disconnected', error: '蓝牙已断开，请手动重新连接' })
  })
})
