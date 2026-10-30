/**
 * 浏览器端的语音状态：从 VOICE_PATH 读设置、连接和音色，供语音条、角色表单和"语音"页共用。
 * 只在页面内存里，刷新后重新读取。key 不会到浏览器，只知道有没有存。
 */

import {
  DEFAULT_VOICE_SETTINGS, SPEAK_PATH, VOICE_PATH,
  type VoiceAction, type VoiceDraft, type VoiceEngineView, type VoiceEntry, type VoiceSettings, type VoiceView,
} from '../voice-types.ts'

async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined) as { message?: string } | undefined
  return new Error(body?.message ?? `请求失败（${response.status}）`)
}

/** 相对路径：DSH 可能挂在子路径下（与提示词查看器一致）。 */
export async function requestVoice(action?: VoiceAction, signal?: AbortSignal): Promise<VoiceView> {
  const init: RequestInit = action === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(VOICE_PATH.slice(1), init)
  if (!response.ok) throw await failure(response)
  return await response.json() as VoiceView
}

/** 合成一句。voice 是已保存音色的 id，或一份还没保存的音色（试听）。 */
export async function requestSpeech(voice: string | VoiceDraft, text: string, signal?: AbortSignal): Promise<Blob> {
  const body = typeof voice === 'string' ? { voice, text } : { draft: voice, text }
  const init: RequestInit = { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(SPEAK_PATH.slice(1), init)
  if (!response.ok) throw await failure(response)
  return await response.blob()
}

const EMPTY: VoiceView = { settings: DEFAULT_VOICE_SETTINGS, engines: [], voices: [], keyStore: true }

export class VoiceState {
  private view: VoiceView = EMPTY
  private loaded = false
  private readonly listeners = new Set<() => void>()
  private version = 0
  private disposed = false

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version

  get settings(): VoiceSettings { return this.view.settings }
  get engines(): readonly VoiceEngineView[] { return this.view.engines }
  get voices(): readonly VoiceEntry[] { return this.view.voices }
  get keyStore(): boolean { return this.view.keyStore }
  /** 还没读到时为 false：这段时间里角色回复先显示文字。 */
  get ready(): boolean { return this.loaded }

  voice(id: string | undefined): VoiceEntry | undefined {
    return id === undefined ? undefined : this.view.voices.find(item => item.id === id)
  }

  engine(id: string): VoiceEngineView | undefined {
    return this.view.engines.find(item => item.id === id)
  }

  /**
   * 角色能不能朗读：语音开着，音色和它的连接都还在。返回区分缓存用的键：
   * 改了音色或连接设置，键就变了，不会播旧的音频。
   */
  playable(id: string | undefined): { readonly voice: string; readonly revision: string } | undefined {
    if (!this.view.settings.enabled) return undefined
    const voice = this.voice(id)
    const engine = voice === undefined ? undefined : this.engine(voice.engine)
    if (voice === undefined || engine === undefined) return undefined
    return { voice: voice.id, revision: JSON.stringify([engine.kind, engine.config, voice.params]) }
  }

  reload(): Promise<void> {
    return requestVoice().then((view) => { if (!this.disposed) this.adopt(view) })
  }

  adopt(view: VoiceView): void {
    const { saved: _, ...rest } = view
    this.view = rest
    this.loaded = true
    this.version++
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}
