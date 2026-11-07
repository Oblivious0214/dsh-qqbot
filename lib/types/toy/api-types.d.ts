/**
 * 浏览器和 host 共用的接口类型：`/api/toy-buttplug/state`。
 * GET 返回 ToyView；POST 提交一个 ToyAction，成功时也返回 ToyView。
 * 走 DSH 的 /api 认证，只有 owner 能读写。
 */
import type { ClimaxPrompts } from './climax-prompt.ts';
import type { MotionConfig, RangeName } from './core/config.ts';
import type { DeviceStatus, ProactivityTexts } from './core/rules.ts';
import type { Proactivity } from './core/safety.ts';
import type { ActionLibrary } from './motion-library/config.ts';
import type { SafetyWords } from './core/safety-words.ts';
import type { MotionPacing } from './core/pacing.ts';
export declare const STATE_PATH = "/api/qqbot/toy/state";
/** 右栏高潮按钮的设置（内部沿用 burst 命名）。由用户按下才开始，暂停按钮和快捷键随时可停。 */
export interface BurstSettings {
    /** 刺激阶段：程序从高潮动作池随机选预设，持续这么多秒。 */
    readonly seconds: number;
    /** 刺激速度：中速／高速档，或自己填的 unit/s；缺省为高速。 */
    readonly speed?: BurstSpeed;
    /** 刺激结束后：进入温存或停止。 */
    readonly after: 'aftercare' | 'stop';
    readonly aftercareSeconds: number;
}
export type BurstSpeed = 'medium' | 'high' | number;
export declare const DEFAULT_BURST: BurstSettings;
/** 刺激和温存秒数的范围；与段落 seconds 相同。 */
export declare const BURST_SECONDS: {
    readonly min: 5;
    readonly max: 120;
};
/** 持久化的设置，存在 `<DSH_HOME>/toy-buttplug/settings.json`。 */
export interface ToySettings {
    /** 功能总开关。新设置默认关闭，旧设置缺省为开启；不代表授权、连接或接入。 */
    readonly enabled?: boolean;
    /** 首次进入 QQ Bot 设置时的图文弹窗已展示，跨页面和重启保留。 */
    readonly deviceIntroSeen?: boolean;
    /** 曾有设备连接就绪；之后永久隐藏设置内的推广。 */
    readonly deviceConnected?: boolean;
    /** 只读气泡旁显示。默认隐藏两项，从关闭切到开启联动时显示两项一次。 */
    readonly display?: {
        readonly actions: boolean;
        readonly countdown: boolean;
    };
    /** 首次授权。撤回时所有会话立即退出联动。 */
    readonly authorized: boolean;
    readonly motion: MotionConfig;
    readonly behavior: string;
    /** 用户改写过的档位说明。没改的档不出现，用内置默认，内置默认以后更新时也能跟着更新。 */
    readonly proactivityTexts?: ProactivityTexts;
    /** 暂停快捷键（core/hotkey.ts 的写法）；空串表示不设，这是默认值（输入栏按钮仍在）。推荐 Ctrl+M。 */
    readonly hotkey: string;
    /** 恢复快捷键，可选；必须和暂停键不同。没有时只能点"继续"恢复。 */
    readonly resumeHotkey?: string;
    /** 没保存过时用 DEFAULT_BURST。 */
    readonly burst?: BurstSettings;
    /** 用户改写过的高潮／温存提示词；没改的不出现，用内置默认。 */
    readonly climaxPrompts?: ClimaxPrompts;
    readonly safetyWords?: SafetyWords;
    /** 设备在动、段落没写 seconds 时的停留时间；没保存过时用 DEFAULT_PACING。 */
    readonly pacing?: MotionPacing;
}
/** 一个会话的联动状态。只存在内存里，DSH 重启后所有会话都回到未接入。 */
/** 会话当前角色：名称、自主性档位和偏好动作、范围（没写的为空）。没装 dsh-qqbot 或没有角色时整体为空。 */
export interface SessionRole {
    readonly name: string;
    readonly proactivityTexts?: ProactivityTexts;
    readonly proactivity?: Proactivity;
    /** 动作库里的动作名称。 */
    readonly actions?: readonly string[];
    readonly ranges?: readonly RangeName[];
}
export interface ToySessionView {
    readonly attached: boolean;
    readonly status?: DeviceStatus;
    /** 角色卡的自主性档位；没有设置时为低自主性。 */
    readonly proactivity: Proactivity;
    /** 当前角色（装了 dsh-qqbot 且会话有角色时）。actions、ranges 是偏好，没写时为空。 */
    readonly role?: SessionRole;
    /** 登记给 qqbot 的规则全文；未接入时为空。 */
    readonly rules: string;
}
export interface ToyView {
    /** 仅首次设置入口请求返回本次是否展示介绍，不属于持久化状态。 */
    readonly showDeviceIntro?: boolean;
    readonly actionLibrary?: ActionLibrary;
    readonly revision?: number;
    /** 服务重启或联动关闭后改变，防止其他页面错过快速关开仍继续运动。 */
    readonly controlEpoch?: string;
    readonly conflict?: string;
    readonly settings: ToySettings;
    /** 供角色编辑器读取的三档默认说明，包含本插件旧版已保存的自定义值。 */
    readonly proactivityDefaults?: Required<ProactivityTexts>;
    /** 装了并启用 dsh-qqbot 时为 true。没有它时规则不进任何提示词。 */
    readonly qqbot: boolean;
    readonly session?: ToySessionView;
}
export type ToyAction = {
    readonly action: 'promotion.open';
} | {
    readonly action: 'device.connected';
} | {
    readonly action: 'library.save';
    readonly library: unknown;
} | {
    readonly action: 'module.enable';
    readonly enabled: boolean;
} | {
    readonly action: 'settings.save';
    readonly settings: unknown;
} | {
    readonly action: 'session.attach';
    readonly session: string;
    readonly status: DeviceStatus;
} | {
    readonly action: 'session.status';
    readonly session: string;
    readonly status: DeviceStatus;
} | {
    readonly action: 'session.detach';
    readonly session: string;
}
/** 高潮按钮：向已接入的 qqbot 会话投一条带来源标记的消息，正文按当前高潮设置生成。 */
 | {
    readonly action: 'session.climax';
    readonly session: string;
}
/** 刺激结束转入温存：再投一条温存消息。 */
 | {
    readonly action: 'session.aftercare';
    readonly session: string;
}
/** 取消高潮／结束温存：撤回还没开始处理的消息。 */
 | {
    readonly action: 'session.climax.cancel';
    readonly session: string;
};
export interface ToyError {
    readonly error: 'bad-request' | 'failed';
    readonly message: string;
}
