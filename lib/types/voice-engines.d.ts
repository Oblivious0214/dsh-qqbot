/**
 * 调用各家语音合成接口，返回音频字节。只在 host 端运行：key 不进浏览器，本地服务的地址也不用对浏览器开放。
 * 请求格式：
 * - fish：POST https://api.fish.audio/v1/tts，`model` 放在请求头（参考 dsh-fish-tts，MIT，MaRi23333 的 synthesize()）。
 * - openai：POST `<baseUrl>/audio/speech`，`{ model, input, voice, response_format }`；连接打开了语气支持时加 `instructions`。
 * 段落的 tone：Fish 写成台词前的 `[tone]`，兼容接口放进 `instructions`，GPT-SoVITS 不支持。
 * - gpt-sovits：POST `<baseUrl>/tts`，api_v2.py 的请求体。
 * fish 可以单独指定 HTTP 代理（`config.proxy`）；没开时用 Node 的全局 fetch，DSH 的全局代理设置照常生效。
 */
import { type VoiceEngine, type VoiceParams } from './voice-types.ts';
export declare const FISH_API_URL = "https://api.fish.audio/v1/tts";
/** 合成一句一般几秒；本地 GPT-SoVITS 第一次加载模型会慢一些。 */
export declare const SYNTH_TIMEOUT_MS = 60000;
export declare const AUDIO_BYTE_LIMIT: number;
export type AudioType = 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac';
export declare const AUDIO_CONTENT_TYPES: Record<AudioType, string>;
export interface Audio {
    readonly type: AudioType;
    readonly bytes: Uint8Array;
}
/** 合成失败，message 可以直接展示给用户。 */
export declare class SynthError extends Error {
}
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export interface SynthRequest {
    readonly engine: VoiceEngine;
    readonly apiKey: string | undefined;
    readonly params: VoiceParams;
    readonly text: string;
    /** 段落的语气描述，已清理；服务不支持时由 synthesize 忽略。 */
    readonly tone?: string;
    readonly signal?: AbortSignal;
}
/** 实际会发出去的语气：服务不支持时为空，缓存键也用它，避免同一句因无效语气重复合成。 */
export declare function effectiveTone(engine: VoiceEngine, tone: string | undefined): string;
/** 用户填的地址：只认 http/https，不带账号密码，去掉末尾的斜杠。不合规时抛出可以展示的错误。 */
export declare function normalizeBaseUrl(raw: string): string;
/** 同时接受服务根地址和完整合成接口，避免粘贴文档地址后重复追加路径。 */
export declare function speechEndpoint(kind: 'openai' | 'gpt-sovits', raw: string): string;
/** 代理地址：只认 HTTP 代理，可以省掉 http://，必须带端口。不合规时抛出可以展示的错误。 */
export declare function normalizeProxyUrl(raw: string): string;
/** 按文件头认音频格式，不信任响应声明的类型（有的服务出错时也返回 200 和一段 JSON）。 */
export declare function sniffAudio(bytes: Uint8Array): AudioType | undefined;
/** 合成一句。失败时抛 SynthError；调用方取消时抛 AbortError。开了代理时不用 fetchImpl。 */
export declare function synthesize(request: SynthRequest, fetchImpl?: Fetch): Promise<Audio>;
