/**
 * 语音条的生成和播放：每句话合成一次，音频留在页面内存里；点一条从它开始依次播完这条回复。
 * 排队和连续播放的做法迁移自 dsh-qq-skin（MIT，lispking）的 src/client/fish-voice.ts，按本插件重写：
 * 不扫描整个页面，由每条回复自己交来要朗读的句子；合成走本插件的 SPEAK_PATH，不经过 dsh-fish-tts。
 */

import { requestSpeech } from './voice-state.ts'

/** 一句要朗读的话。key 区分音频：同一音色、同一设置、同一句话、同一语气共用一份。 */
export interface Clip {
  readonly key: string
  readonly voice: string
  readonly text: string
  readonly tone?: string
}

export type ClipStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly duration: number }
  | { readonly state: 'playing'; readonly duration: number }
  | { readonly state: 'error'; readonly message: string }

/** 只用到 HTMLAudioElement 的这些部分，测试时可以换成假的。 */
export interface AudioLike extends EventTarget {
  src: string
  preload: string
  volume: number
  currentTime: number
  readonly duration: number
  play(): Promise<void>
  pause(): void
  load(): void
  removeAttribute(name: string): void
}

interface Entry extends Clip {
  duration?: number
  error?: string
  request?: AbortController
  promise?: Promise<void>
  audio?: AudioLike
  url?: string
}

/** 同时合成几句。按字数计费的服务和本地显卡都经不起一次全发。 */
const CONCURRENCY = 2
/** 页面里最多留多少句的音频，多了先丢最久没用的。 */
const ENTRY_LIMIT = 200
const METADATA_TIMEOUT_MS = 15_000
const READ_PREFIX = 'dsh-qqbot:voice-read:'
function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

const abortError = () => new DOMException('已取消', 'AbortError')
export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 读音频时长；读不到说明返回的不是能播的音频。 */
function readDuration(audio: AudioLike, url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, duration?: number) => {
      clearTimeout(timer)
      audio.removeEventListener('loadedmetadata', ready)
      audio.removeEventListener('durationchange', ready)
      audio.removeEventListener('error', failed)
      signal.removeEventListener('abort', cancel)
      if (error === undefined) resolve(duration!)
      else reject(error)
    }
    const ready = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) finish(undefined, audio.duration) }
    const failed = () => { finish(new Error('这段音频放不了，点击重试')) }
    const cancel = () => { finish(abortError()) }
    const timer = setTimeout(failed, METADATA_TIMEOUT_MS)
    audio.addEventListener('loadedmetadata', ready)
    audio.addEventListener('durationchange', ready)
    audio.addEventListener('error', failed)
    signal.addEventListener('abort', cancel, { once: true })
    audio.preload = 'metadata'
    audio.src = url
    audio.load()
  })
}

export class VoicePlayer {
  private readonly entries = new Map<string, Entry>()
  private readonly revealed = new Set<string>()
  private readonly jobs: (() => void)[] = []
  private busy = 0
  /** 每次开始或停止播放加一，旧的播放流程看到变了就退出。 */
  private generation = 0
  private active: { readonly owner: string; readonly key: string } | undefined
  private release: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(
    private readonly volume: () => number,
    private readonly synth: (voice: string, text: string, signal: AbortSignal, tone?: string) => Promise<Blob> = requestSpeech,
    private readonly makeAudio: () => AudioLike = () => new Audio(),
    private readonly storage: Storage | undefined = browserStorage(),
  ) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getVersion = () => this.version

  private notify(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  status(key: string): ClipStatus {
    const entry = this.entries.get(key)
    if (entry === undefined) return { state: 'idle' }
    if (entry.error !== undefined && entry.promise === undefined) return { state: 'error', message: entry.error }
    if (entry.duration !== undefined) return this.active?.key === key && this.release !== undefined ? { state: 'playing', duration: entry.duration } : { state: 'ready', duration: entry.duration }
    if (entry.promise !== undefined) return { state: 'loading' }
    return { state: 'idle' }
  }

  /** 这条语音是不是正在播放或等着播放。 */
  isActive(owner: string, key: string): boolean {
    return this.active?.owner === owner && this.active.key === key
  }

  /** 点开过的语音条显示文字（"语音条，点开显示文字"）。按气泡记，不按句子：两个气泡说了同一句话也分开。 */
  isRevealed(bubble: string): boolean {
    try { if (this.storage?.getItem(READ_PREFIX + bubble) === '1') this.revealed.add(bubble) } catch { /* 内存记录仍可用。 */ }
    return this.revealed.has(bubble)
  }

  reveal(bubble: string): void {
    this.revealed.add(bubble)
    try { this.storage?.setItem(READ_PREFIX + bubble, '1') } catch { /* 存储不可用时保留本页状态。 */ }
    this.notify()
  }

  clearReadState(): void {
    this.revealed.clear()
    if (this.storage !== undefined) {
      for (let index = this.storage.length - 1; index >= 0; index--) {
        const key = this.storage.key(index)
        if (key?.startsWith(READ_PREFIX)) this.storage.removeItem(key)
      }
    }
    this.notify()
  }

  private entry(clip: Clip): Entry {
    let entry = this.entries.get(clip.key)
    if (entry === undefined) {
      entry = { ...clip }
      this.entries.set(clip.key, entry)
      this.trim()
    } else {
      // 最近用过的挪到最后，丢的时候从前面丢。
      this.entries.delete(clip.key)
      this.entries.set(clip.key, entry)
    }
    return entry
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= ENTRY_LIMIT) return
      if (entry.promise !== undefined || this.active?.key === key) continue
      this.drop(entry)
      this.entries.delete(key)
    }
  }

  private drop(entry: Entry): void {
    entry.request?.abort()
    entry.audio?.pause()
    entry.audio?.removeAttribute('src')
    if (entry.url !== undefined) URL.revokeObjectURL(entry.url)
    delete entry.audio
    delete entry.url
    delete entry.duration
  }

  private pump(): void {
    while (this.busy < CONCURRENCY && this.jobs.length > 0) this.jobs.shift()!()
  }

  /** 生成这句的音频（已经有了就直接返回）。失败时状态变成 error，并抛出；后台预先生成时调用方自己吞掉。 */
  prepare(clip: Clip): Promise<void> {
    const entry = this.entry(clip)
    if (entry.audio !== undefined) return Promise.resolve()
    if (entry.promise !== undefined) return entry.promise
    const request = new AbortController()
    entry.request = request
    delete entry.error
    const task = new Promise<void>((resolve, reject) => {
      const job = () => {
        if (request.signal.aborted) { reject(abortError()); return }
        this.busy++
        this.load(entry, request.signal).then(resolve, reject).finally(() => { this.busy--; this.pump() })
      }
      this.jobs.push(job)
      request.signal.addEventListener('abort', () => {
        const index = this.jobs.indexOf(job)
        if (index >= 0) { this.jobs.splice(index, 1); reject(abortError()) }
      }, { once: true })
    })
    entry.promise = task.catch((error: unknown) => {
      if (!request.signal.aborted) entry.error = messageOf(error)
      throw error
    }).finally(() => {
      delete entry.promise
      delete entry.request
      this.notify()
    })
    this.notify()
    this.pump()
    return entry.promise
  }

  private async load(entry: Entry, signal: AbortSignal): Promise<void> {
    // 取消后立刻放手，不等请求自己结束：语音条马上回到可以再点的状态。
    const aborted = new Promise<never>((_, reject) => { signal.addEventListener('abort', () => { reject(abortError()) }, { once: true }) })
    const blob = await Promise.race([this.synth(entry.voice, entry.text, signal, entry.tone), aborted])
    const url = URL.createObjectURL(blob)
    const audio = this.makeAudio()
    try {
      entry.duration = await readDuration(audio, url, signal)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
    entry.audio = audio
    entry.url = url
  }

  /** 从第 start 句开始依次播完。owner 是这条回复，用来在回复消失时停下。 */
  async playFrom(owner: string, clips: readonly Clip[], start: number, bubbles: readonly string[]): Promise<void> {
    this.stop()
    const token = this.generation
    for (let index = start; index < clips.length; index++) {
      const clip = clips[index]!
      const bubble = bubbles[index]
      if (bubble !== undefined) this.reveal(bubble)
      this.active = { owner, key: clip.key }
      delete this.entry(clip).error
      this.notify()
      try {
        await this.prepare(clip)
        if (token !== this.generation) return
        if (!await this.playOne(this.entry(clip), token)) return
      } catch (error) {
        if (token !== this.generation) return
        const entry = this.entries.get(clip.key)
        if (entry !== undefined && !isAbort(error)) entry.error = messageOf(error)
        this.active = undefined
        this.notify()
        return
      }
    }
    if (token === this.generation) {
      this.active = undefined
      this.notify()
    }
  }

  /** 播一句，自然播完返回 true，被停下返回 false。 */
  private async playOne(entry: Entry, token: number): Promise<boolean> {
    const audio = entry.audio!
    audio.currentTime = 0
    audio.volume = Math.min(1, Math.max(0, this.volume()))
    const finished = new Promise<boolean>((resolve, reject) => {
      const cleanup = () => { audio.removeEventListener('ended', ended); audio.removeEventListener('error', failed) }
      const ended = () => { cleanup(); resolve(true) }
      const failed = () => { cleanup(); reject(new Error('播放失败，点击重试')) }
      this.release = () => { cleanup(); resolve(false) }
      audio.addEventListener('ended', ended)
      audio.addEventListener('error', failed)
    })
    try {
      await audio.play()
    } catch (error) {
      this.release?.()
      this.release = undefined
      throw error instanceof DOMException && error.name === 'NotAllowedError' ? new Error('浏览器不让播放声音，再点一次') : error
    }
    if (token !== this.generation) return false
    this.notify()
    try {
      return await finished
    } finally {
      if (token === this.generation) this.release = undefined
    }
  }

  /** 停下正在播的；还在生成的那句不再等（后台预先生成的其他句子照常）。 */
  stop(): void {
    this.generation++
    this.release?.()
    this.release = undefined
    const active = this.active === undefined ? undefined : this.entries.get(this.active.key)
    this.active = undefined
    if (active !== undefined) {
      active.audio?.pause()
      if (active.audio === undefined) active.request?.abort()
    }
    this.notify()
  }

  /** 回复离开页面（换会话、刷新历史）时，停下它正在播的语音。 */
  leave(owner: string): void {
    if (this.active?.owner === owner) this.stop()
  }

  clearCache(): void {
    this.stop()
    for (const entry of this.entries.values()) this.drop(entry)
    this.entries.clear()
    this.jobs.length = 0
    this.notify()
  }

  dispose(): void {
    this.clearCache()
    this.listeners.clear()
  }
}
