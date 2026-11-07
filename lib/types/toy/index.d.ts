/**
 * dsh-toy-buttplug host 层入口：设置和会话接入状态的接口，以及（装了 dsh-qqbot 时）向 qqbot 登记设备规则。
 *
 * 隔离：本插件不注册任何 systemPrompt section，不进任何预设。没装或停用 dsh-qqbot 时什么提示词也不出现；
 * 装了时规则只进已接入的 qqbot 会话（`qqbot:ext:toy`），状态只进 `qqbot:runtime`。
 * 设备连接和运动都在浏览器里，host 不碰设备。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ToyView } from './api-types.ts';
import { type ProactivityTexts } from './core/rules.ts';
import { SessionStates } from './sessions.ts';
import { SettingsStore } from './settings.ts';
import { ActionLibraryStore } from './motion-library/store.ts';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'qqbot-toy-climax': {
            kind: 'qqbot-toy-climax';
            form: 'notice';
            summary: string;
        };
    }
}
/** 向会话投递高潮消息；没有 agents 服务时为空。 */
export interface ClimaxPrompter {
    send(session: string, text: string, summary: string): void;
    /** 撤回还没开始处理的高潮／温存消息。 */
    cancel(session: string): void;
}
export type { ToyAction, ToySessionView, ToySettings, ToyView } from './api-types.ts';
export declare const name = "toy-buttplug";
export declare const inject: string[];
/** dsh-qqbot 登记服务中本插件用到的部分。只按结构使用，不依赖 dsh-qqbot 的包。 */
interface QqbotRegistry {
    content?: {
        roles: {
            list(): readonly {
                name: string;
                motionActions?: readonly string[];
            }[];
        };
    };
    extension(entry: {
        name: string;
        text: string | ((session: {
            id: string;
        }) => string);
    }): () => void;
    runtime(name: string, text: string | ((session: {
        id: string;
    }) => string)): () => void;
    /**
     * 0.1.5 起有。角色卡的 proactivity 写 follow / situational / high，没写时为空。
     * motionActions、motionRanges 同版起有：偏好的动作和范围，名称和本插件一致。
     */
    role?(session: {
        id: string;
    }): {
        name: string;
        proactivity?: string;
        proactivityTexts?: ProactivityTexts;
        motionActions?: readonly string[];
        motionRanges?: readonly string[];
    } | undefined;
}
/** 请求格式不对，和"操作本身失败"区分开。 */
export declare class BadRequest extends Error {
}
export declare class ToyHost {
    private readonly legacyActive;
    readonly settings: SettingsStore;
    readonly sessions: SessionStates;
    readonly actionLibrary: ActionLibraryStore;
    /** dsh-qqbot 的登记服务在场。 */
    qqbot: boolean;
    prompter: ClimaxPrompter | undefined;
    private roles;
    private registration;
    private registry;
    private conflict;
    private revision;
    private controlEpoch;
    private disposed;
    private readonly listeners;
    private changed;
    /** 长轮询只传设置与停用状态；不驱动设备，不产生模型消息。 */
    watch(after: number, signal: AbortSignal): Promise<void>;
    refreshRegistration(): void;
    /** 撤回授权并通知全部客户端停止；不连接设备。 */
    reset(resetLibrary?: boolean): void;
    dispose(): void;
    constructor(dir: string, warn: (message: string) => void, legacyActive?: () => boolean);
    /** 会话当前的角色。未设置或不认识的档位按低自主性处理，不认识的偏好丢掉。 */
    private roleOf;
    view(session: string | undefined): ToyView;
    /** 原子领取首次介绍，多个页面同时打开时仅有一个页面展示。 */
    openPromotion(): ToyView;
    /** 执行一个操作，返回操作涉及的会话 id。格式错误抛 BadRequest，操作失败抛 Error。 */
    apply(body: unknown): string | undefined;
    /** 向 qqbot 登记规则和状态，返回撤销函数。 */
    register(qqbot: QqbotRegistry): () => void;
}
interface LoaderEntry {
    readonly options: {
        readonly name: string;
    };
    readonly disabled: boolean;
    readonly fiber?: {
        readonly state: number;
    };
}
/** Cordis FiberState 的 LOADING=1 / ACTIVE=2 / UNLOADING=5；卸载完成前也让出槽位。 */
export declare function standaloneToyActive(entries: Iterable<LoaderEntry>): boolean;
export declare function apply(ctx: Context): void;
