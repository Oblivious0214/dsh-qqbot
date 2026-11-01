/**
 * dsh-qqbot host 层入口：提供 `ctx.qqbot` 登记服务、提示词查看器接口、角色/破限预设编辑接口、QQ 界面设置接口和语音接口。
 * 本插件不注册任何提示词，不写 agent-preset-registry 的设置；
 * 提示词由 qqbot 预设内的 dsh-qqbot/prompt 组装。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { QqbotData } from './content.ts';
import { MemoryCoordinator } from './memory-coordinator.ts';
import { QqbotRegistryStore, type QqbotExtensionEntry, type QqbotRegistry, type QqbotRoleInfo, type QqbotSession, type QqbotText } from './registry.ts';
import * as ui from './ui.ts';
import * as voice from './voice.ts';
import * as maintenance from './maintenance.ts';
export type { QqbotExtensionEntry, QqbotRegistry, QqbotRoleInfo, QqbotSession, QqbotText } from './registry.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        qqbot: QqbotService;
    }
}
/**
 * `ctx.qqbot`：外部插件只用 QqbotRegistry 部分；其余成员供本插件的预设内组件和查看器读取。
 * 是 cordis Service，所以方法里的 `this.ctx` 是调用方的 Context，登记时能记下来源插件。
 */
export declare class QqbotService extends Service implements QqbotRegistry {
    readonly store: QqbotRegistryStore;
    readonly maintenance: maintenance.Maintenance;
    /** 角色库、会话绑定和破限预设，数据在 `<DSH_HOME>/qqbot/`。 */
    readonly content: QqbotData;
    /** QQ 界面设置、角色头像和聊天背景，只给浏览器端显示用，不进提示词。 */
    readonly ui: ui.UiStore;
    /** 语音引擎、音色和朗读设置。API key 不在这里，在 DSH 凭据库。 */
    readonly voice: voice.VoiceStore;
    /** 角色记忆整理的调度。会话由预设内的 memory-agent 登记。 */
    readonly memory: MemoryCoordinator;
    /**
     * 每个 agent 上一次真实组装出的系统提示词，供查看器对比"上一轮发出的"和"下一轮要发的"。
     * 以 agent 对象为键，agent 释放后自动回收；重启后为空。
     */
    lastPrompt: WeakMap<object, string>;
    constructor(ctx: Context);
    extension(entry: QqbotExtensionEntry): () => void;
    runtime(name: string, text: QqbotText): () => void;
    role(session: QqbotSession): QqbotRoleInfo | undefined;
}
export declare const name = "qqbot";
export declare function apply(ctx: Context): void;
