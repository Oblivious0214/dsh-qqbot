/** 用户点“怎么做”后才作为新标准会话的普通用户消息发送；不注册为 QQbot 系统提示词。 */
import { type EngineKind } from './voice-types.ts';
export type VoiceGuideRoute = EngineKind | 'auto';
/** 只接受枚举，不接收角色、地址、名称、已有配置或凭据，避免把私密信息拼进会话。 */
export declare function voiceGuidePrompt(kind?: VoiceGuideRoute): string;
