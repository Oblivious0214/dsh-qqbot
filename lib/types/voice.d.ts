/**
 * 语音：引擎（连接哪家服务）、音色（角色卡选的就是它）和朗读设置存 `<数据目录>/voice.json`。
 * API key 存 DSH 的凭据库（`ctx.credentials`，记录键 `dsh-qqbot/tts-<引擎 id>`），不进 voice.json，GET 也不返回。
 * 接口：VOICE_PATH 读写设置，SPEAK_PATH 合成一句返回音频。都走 DSH 的认证，只有 owner 能访问。
 * 语音由浏览器端朗读气泡；仅可用状态进入 qqbot 的 runtime，不改稳定提示词。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Warn } from './storage.ts';
import { type Audio, type Fetch } from './voice-engines.ts';
import { type VoiceEngine, type VoiceEntry, type VoiceParams, type VoiceSettings, type VoiceView } from './voice-types.ts';
export declare const name = "qqbot-voice";
/** 存 key 的地方。生产环境是 DSH 凭据库，测试用内存。 */
export interface KeyStore {
    read(engine: string): Promise<string | undefined>;
    /** null 表示删掉。 */
    write(engine: string, key: string | null): Promise<void>;
}
/** ctx.credentials 里本插件用到的部分。记录键是带品牌的字符串，这里只按字符串传，不引入凭据包的运行时。 */
interface CredentialRecords {
    readRecord(key: never): Promise<{
        readonly kind: string;
        readonly key?: string;
    } | undefined>;
    modifyRecord(key: never, mutate: (current: unknown) => Promise<{
        kind: 'api-key';
        key: string;
    } | undefined>): Promise<unknown>;
    deleteRecord(key: never): Promise<void>;
}
export declare function credentialKeyStore(credentials: CredentialRecords): KeyStore;
export declare function validateVoiceSettings(value: unknown): VoiceSettings;
export declare class VoiceStore {
    readonly dir: string;
    private readonly warn;
    private cache;
    private actions;
    constructor(dir: string, warn: Warn);
    /** 同一份资料的界面写操作排队，凭据写入期间不被另一页面覆盖。 */
    action<T>(run: () => Promise<T>): Promise<T>;
    clearCache(): void;
    private get file();
    private get data();
    private write;
    get settings(): VoiceSettings;
    get engines(): readonly VoiceEngine[];
    get voices(): readonly VoiceEntry[];
    engine(id: string): VoiceEngine | undefined;
    voice(id: string): VoiceEntry | undefined;
    /** 和浏览器 playable() 使用相同条件，不请求上游服务，也不读取或暴露密钥、地址和音色内部键。 */
    promptStatus(id: string | undefined): string;
    saveSettings(value: unknown): void;
    /** 新建或修改引擎，返回 id。修改时不能换类型：音色参数按类型解释，换了就对不上。 */
    saveEngine(value: unknown): VoiceEngine;
    /** 仅校验并分配内部键；凭据成功保存后才提交配置。 */
    draftEngine(value: unknown): VoiceEngine;
    commitEngine(engine: VoiceEngine): VoiceEngine;
    /** 还有音色用它时不能删，免得角色的音色悄悄失效。 */
    removeEngine(id: string): void;
    /** 校验音色草稿，不保存。试听没保存的音色时也用它。 */
    draftVoice(value: unknown): Omit<VoiceEntry, 'id'> & {
        readonly id?: string;
    };
    saveVoice(value: unknown): VoiceEntry;
    /** 选了这个音色的角色之后显示文字；角色卡里的 voice 字段留着，同 id 的音色不会再生成。 */
    removeVoice(id: string): void;
}
/** 编辑器要的全部数据。hasKey 逐个问凭据库，key 本身不出 host。 */
export declare function voiceView(store: VoiceStore, keys: KeyStore | undefined, saved?: string): Promise<VoiceView>;
/** 执行一个操作，保存引擎或音色时返回 id。格式错误抛 BadRequest，操作失败抛 Error。 */
export declare function applyVoiceAction(store: VoiceStore, keys: KeyStore | undefined, body: unknown): Promise<string | undefined>;
/** 合成过的句子留在内存里：同一个气泡反复点、换会话再回来都不用再花钱。重启后清空。 */
export declare class AudioCache {
    private readonly maxEntries;
    private readonly maxBytes;
    private readonly entries;
    private bytes;
    constructor(maxEntries?: number, maxBytes?: number);
    static key(engine: VoiceEngine, params: VoiceParams, text: string, tone?: string): string;
    clear(): void;
    get(key: string): Audio | undefined;
    set(key: string, audio: Audio): void;
}
export declare class Speaker {
    private readonly store;
    private readonly keys;
    private readonly cache;
    private readonly fetchImpl?;
    private running;
    private lifetime;
    clearCache(): void;
    constructor(store: VoiceStore, keys: () => KeyStore | undefined, cache?: AudioCache, fetchImpl?: Fetch | undefined);
    /**
     * body：`{ voice: <id>, text, tone? }` 读已保存的音色；`{ draft: <音色草稿>, text }` 试听还没保存的音色。
     * 格式错误抛 BadRequest，合成失败抛 SynthError。
     */
    speak(body: unknown, signal?: AbortSignal): Promise<Audio>;
}
export declare function audioResponse(audio: Audio): Response;
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export {};
