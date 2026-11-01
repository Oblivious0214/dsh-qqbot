/**
 * 浏览器端的语音状态：从 VOICE_PATH 读设置、连接和音色，供语音条、角色表单和"语音"页共用。
 * 只在页面内存里，刷新后重新读取。key 不会到浏览器，只知道有没有存。
 */

import { writeHeaders } from './cleanup-epoch.ts'
import {
  DEFAULT_VOICE_SETTINGS, SPEAK_PATH, VOICE_PATH,
  type VoiceAction, type VoiceDraft, type VoiceEngineView, type VoiceEntry, type VoiceSettings, type VoiceView,
} from '../voice-types.ts'
import type { Context } from '@deepseek-ai/cordis'
import { createVoiceGuide, type VoiceGuide } from './voice-guide.ts'

async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined) as { message?: string } | undefined
  return new Error(body?.message ?? `请求失败（${response.status}）`)
}

/** 相对路径：DSH 可能挂在子路径下（与提示词查看器一致）。 */
export async function requestVoice(action?: VoiceAction, signal?: AbortSignal): Promise<VoiceView> {
  const init: RequestInit = action === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: writeHeaders(), body: JSON.stringify(action) }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(VOICE_PATH.slice(1), init)
  if (!response.ok) throw await failure(response)
  return await response.json() as VoiceView
}

/** 合成一句。voice 是已保存音色的 id，或一份还没保存的音色（试听）；tone 是段落的语气描述。 */
export async function requestSpeech(voice: string | VoiceDraft, text: string, signal?: AbortSignal, tone?: string): Promise<Blob> {
  const extra = tone === undefined || tone === '' ? {} : { tone }
  const body = typeof voice === 'string' ? { voice, text, ...extra } : { draft: voice, text, ...extra }
  const init: RequestInit = { method: 'POST', cache: 'no-store', headers: writeHeaders(), body: JSON.stringify(body) }
  if (signal !== undefined) init.signal = signal
  const response = await fetch(SPEAK_PATH.slice(1), init)
  if (!response.ok) throw await failure(response)
  return await response.blob()
}

const EMPTY: VoiceView = { settings: DEFAULT_VOICE_SETTINGS, engines: [], voices: [], keyStore: true }

export class VoiceState {
  guide: VoiceGuide | undefined
  private view: VoiceView = EMPTY
  private loaded = false
  private readonly listeners = new Set<() => void>()
  private version = 0
  private disposed = false
  private generation = 0
  private writes: Promise<unknown> = Promise.resolve()
  private preferenceTask: Promise<void> | undefined
  private preferenceRevision = 0
  private preferenceDraft: VoiceSettings | undefined
  private requestedSettings: VoiceSettings | undefined
  settingsSaving = false
  settingsError = ''
  settingsStatus = ''
  invalidate(): void { this.generation++; this.loaded = false; this.view = EMPTY; this.preferenceDraft = undefined; this.requestedSettings = undefined; this.settingsError = ''; this.settingsStatus = ''; this.changed() }
  private changed(): void { this.version++; for (const listener of this.listeners) listener() }
  get draftSettings(): VoiceSettings { return this.preferenceDraft ?? this.settings }
  get settingsDirty(): boolean { return this.preferenceDraft !== undefined && JSON.stringify(this.preferenceDraft) !== JSON.stringify(this.settings) }
  discardSettings(): void {
    if (this.settingsSaving) return
    this.preferenceDraft = undefined; this.requestedSettings = undefined; this.settingsError = ''; this.settingsStatus = ''; this.changed()
  }

  /** Serialize object saves and preferences so their full response snapshots cannot overtake one another. */
  act(action: VoiceAction): Promise<VoiceView> {
    const generation = this.generation
    const task = this.writes.then(async () => {
      if (this.disposed || generation !== this.generation) throw new Error('设置已更新，请重新打开。')
      const view = await requestVoice(action)
      if (this.disposed || generation !== this.generation) throw new Error('设置已更新，请重新打开。')
      this.adopt(view)
      return view
    })
    this.writes = task.catch(() => {})
    return task
  }
  editSettings(patch: Partial<VoiceSettings>): void {
    this.preferenceDraft = { ...this.draftSettings, ...patch }; this.preferenceRevision++; this.settingsStatus = ''; this.changed()
  }
  saveSettings(patch?: Partial<VoiceSettings>): Promise<void> {
    if (patch) this.editSettings(patch)
    this.requestedSettings = this.draftSettings
    if (this.preferenceTask) return this.preferenceTask
    this.settingsSaving = true; this.settingsError = ''; this.settingsStatus = '保存中…'; this.changed()
    const generation = this.generation
    this.preferenceTask = (async () => {
      while (this.requestedSettings && generation === this.generation) {
        const revision = this.preferenceRevision, settings = this.requestedSettings
        this.requestedSettings = undefined
        await this.act({ action: 'settings.save', settings })
        if (generation !== this.generation) return
        if (revision === this.preferenceRevision) this.preferenceDraft = undefined
      }
      if (generation === this.generation) this.settingsStatus = ''
    })().catch((error: unknown) => {
      if (generation === this.generation) { this.settingsError = error instanceof Error ? error.message : String(error); this.settingsStatus = '' }
    }).finally(() => { this.preferenceTask = undefined; this.settingsSaving = false; this.changed() })
    return this.preferenceTask
  }

  /** 在客户端入口已有 ctx 和关闭编辑器回调处接入，不增加全局服务。 */
  bindGuide(ctx: Context, closeEditor: () => void): void {
    this.guide?.dispose()
    this.guide = createVoiceGuide(ctx, closeEditor)
  }

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
    const generation = this.generation
    const version = this.version
    return requestVoice().then((view) => { if (!this.disposed && generation === this.generation && version === this.version) this.adopt(view) })
  }

  adopt(view: VoiceView): void {
    const { saved: _, ...rest } = view
    this.view = rest
    this.loaded = true
    this.changed()
  }

  dispose(): void {
    this.disposed = true
    this.guide?.dispose()
    this.listeners.clear()
  }
}
