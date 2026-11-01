/**
 * 登记到 qqbot 的设备规则（`qqbot:ext:toy`）和运行时状态行。
 *
 * 缓存：规则只随这几件事变化：用户改互动规则、改高速范围偏好、有人设时切换主动性档位（含角色上限变化）或改当前档的说明、
 * 换角色或改角色卡的偏好动作和范围（换角色时角色设定在更前面，已经失效，这一行不多造成失效）。
 * 行程、速度上限和分界不进提示词，拖滑条不会让前缀失效；坐标换算、限速、升速过渡和越界拒绝都由程序做。
 * 接入、断开和暂停走 runtime context，不改规则。
 */
import type { MotionConfig } from './config.ts';
import { type RangeName } from './config.ts';
import { type Proactivity, type ProactivityKey } from './safety.ts';
export declare const MAX_BEHAVIOR_LENGTH = 6000;
/** 用户可编辑的互动规则的默认内容。和档位无关，档位另有固定段落。 */
export declare const DEFAULT_BEHAVIOR = "\u914D\u5408\u5F53\u524D\u6BB5\u843D\u7684\u8BED\u6C14\u548C\u8282\u594F\u5B89\u6392\u52A8\u4F5C\u3001\u53D8\u5316\u6216\u505C\u987F\uFF1B\u6CA1\u6709\u5FC5\u8981\u65F6\u5EF6\u7EED\u5F53\u524D\u52A8\u4F5C\uFF0C\u4E0D\u5F3A\u884C\u589E\u52A0\u52A8\u4F5C\u3002\n\u8868\u8FBE\u65B9\u5F0F\u6CBF\u7528\u5F53\u524D\u4EBA\u8BBE\uFF0C\u4E0D\u5411\u7528\u6237\u89E3\u91CA\u63A7\u5236\u534F\u8BAE\u3002";
/** 档位名，固定写在用户文本前面，用户改文本也不会丢掉"现在是哪一档"。 */
export declare const PROACTIVITY_LABELS: Record<ProactivityKey, string>;
export declare const MAX_PROACTIVITY_TEXT_LENGTH = 2000;
/** 各档默认说明；在 QQbot 角色编辑器中分别改写，设备槽位仍由本插件组装。 */
export declare const DEFAULT_PROACTIVITY_TEXTS: Record<ProactivityKey, string>;
export type ProactivityTexts = Partial<Record<ProactivityKey, string>>;
/** 某一档实际用的说明：用户改写过用改写的，否则用默认。 */
export declare function proactivityText(texts: ProactivityTexts | undefined, level: Proactivity): string;
/** 角色卡写的偏好。 */
export interface RolePreference {
    readonly name: string;
    /** 动作库里的动作名称。 */
    readonly actions?: readonly string[];
    readonly ranges?: readonly RangeName[];
}
export interface RuleInput {
    readonly motion: Pick<MotionConfig, 'tiers'>;
    readonly behavior: string;
    readonly proactivity: Proactivity;
    readonly proactivityTexts?: ProactivityTexts;
    readonly role?: RolePreference;
}
/** 角色偏好一行；没有偏好时为空串。只说倾向，用户的话优先。 */
export declare function preferenceLine(role: RolePreference | undefined): string;
/** 设备规则全文。无人设时用叫停一行代替主动性段落；有人设且说明清空时只留档位名。 */
export declare function deviceRules(input: RuleInput): string;
/** 浏览器上报的设备状态。 */
export declare const DEVICE_STATUSES: readonly ["ready", "paused", "disconnected"];
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
/** `qqbot:runtime` 里的一行（不含名称前缀）。每次变化都会在历史里多一条 context，状态只在用户操作时变。 */
export declare function runtimeLine(status: DeviceStatus): string;
