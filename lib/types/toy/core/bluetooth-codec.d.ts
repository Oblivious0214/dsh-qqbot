/**
 * 抚物 V0 蓝牙协议的纯编码部分：设备 UUID、D0 应答解析、速度编码。
 * 迁移自 dsh-serveu 的 bluetooth.js；字段依据见 NOTICE（AstrBot ServeU 插件 device.js、ServeUCentral DeviceService.cs）。
 */
import { type HardwareLimits } from './config.ts';
export interface BleProfile {
    readonly name: string;
    readonly service: string;
    readonly tx: string;
    readonly rx: string;
}
export declare const BLE_DEVICES: readonly BleProfile[];
export interface DeviceInfo extends HardwareLimits {
    readonly hardwareVersion: number;
    readonly softwareVersion: number;
}
/**
 * 解析 D0 的 11 或 12 字节 `S` 应答，双字节字段大端：硬件版本（1）、软件版本（3）、
 * 行程上限 /100（5）、行程下限 /100（7）、速度上限（9）。行程向内取整，速度不超过 500。
 */
export declare function decodeDeviceInfo(value: DataView): DeviceInfo;
/** 速度 → 一字节速度码：0–50 段按 floor(speed/2)，50–500 段按 floor((speed-50)/4)+25。 */
export declare function speedCode(speed: number): number;
/** 速度码对应的实际速度，不大于编码前的速度。 */
export declare function decodedSpeed(code: number): number;
/** 蓝牙的速度量化，用于 motionPackets 的 profile。 */
export declare const bluetoothQuantize: (speed: number) => number;
