/**
 * 抚物 V0 蓝牙协议的纯编码部分：设备 UUID、D0 应答解析、速度编码。
 * 迁移自 dsh-serveu 的 bluetooth.js；字段依据见 NOTICE（AstrBot ServeU 插件 device.js、ServeUCentral DeviceService.cs）。
 */

import { HARD_LIMITS, type HardwareLimits } from './config.ts'

export interface BleProfile {
  readonly name: string
  readonly service: string
  readonly tx: string
  readonly rx: string
}

export const BLE_DEVICES: readonly BleProfile[] = Object.freeze([
  { name: 'ServeU', service: '31bb1111-33e3-4f3c-a7fb-104288e7cb77', tx: '31bb2222-33e3-4f3c-a7fb-104288e7cb77', rx: '31bb3333-33e3-4f3c-a7fb-104288e7cb77' },
  { name: 'VorzePiston', service: '40ee1111-63ec-4b7f-8ce7-712efd55b90e', tx: '40ee2222-63ec-4b7f-8ce7-712efd55b90e', rx: '40ee3333-63ec-4b7f-8ce7-712efd55b90e' },
])

export interface DeviceInfo extends HardwareLimits {
  readonly hardwareVersion: number
  readonly softwareVersion: number
}

/**
 * 解析 D0 的 11 或 12 字节 `S` 应答，双字节字段大端：硬件版本（1）、软件版本（3）、
 * 行程上限 /100（5）、行程下限 /100（7）、速度上限（9）。行程向内取整，速度不超过 500。
 */
export function decodeDeviceInfo(value: DataView): DeviceInfo {
  if (![11, 12].includes(value.byteLength) || value.getUint8(0) !== 83) throw new Error('D0 设备信息格式无效')
  const min = value.getUint16(7) / 100
  const max = value.getUint16(5) / 100
  const info: DeviceInfo = {
    hardwareVersion: value.getUint16(1),
    softwareVersion: value.getUint16(3),
    minPosition: Math.ceil(min),
    maxPosition: Math.floor(max),
    maxSpeed: Math.min(HARD_LIMITS.maxSpeed, value.getUint16(9)),
  }
  if (min < 0 || max > 100 || info.minPosition >= info.maxPosition || info.maxSpeed < HARD_LIMITS.minSpeed) {
    throw new Error('D0 机内限制无效')
  }
  return Object.freeze(info)
}

/** 速度 → 一字节速度码：0–50 段按 floor(speed/2)，50–500 段按 floor((speed-50)/4)+25。 */
export function speedCode(speed: number): number {
  if (!Number.isFinite(speed) || speed < HARD_LIMITS.minSpeed || speed > HARD_LIMITS.maxSpeed) {
    throw new Error('蓝牙速度须为 2–500 unit/s')
  }
  return speed <= 50 ? Math.floor(speed / 2) : Math.floor((speed - 50) / 4) + 25
}

/** 速度码对应的实际速度，不大于编码前的速度。 */
export function decodedSpeed(code: number): number {
  return code <= 25 ? code * 2 : (code - 25) * 4 + 50
}

/** 蓝牙的速度量化，用于 motionPackets 的 profile。 */
export const bluetoothQuantize = (speed: number): number => decodedSpeed(speedCode(speed))
