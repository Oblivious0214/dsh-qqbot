import { describe, expect, it } from 'vitest'
import { VoicePlayer, type AudioLike, type Clip } from '../src/client/voice-player.ts'
import { VoiceState } from '../src/client/voice-state.ts'
import { DEFAULT_VOICE_SETTINGS, type VoiceView } from '../src/voice-types.ts'

/** 假的音频：设 src 后马上给出时长，play() 后等 finish() 才算播完。 */
class FakeAudio extends EventTarget implements AudioLike {
  static all: FakeAudio[] = []
  src = ''
  preload = ''
  volume = 1
  currentTime = 0
  duration = Number.NaN
  playing = false
  constructor(private readonly length: number) { super(); FakeAudio.all.push(this) }
  load() { queueMicrotask(() => { this.duration = this.length; this.dispatchEvent(new Event('loadedmetadata')) }) }
  play() { this.playing = true; return Promise.resolve() }
  pause() { this.playing = false }
  removeAttribute() { this.src = '' }
  finish() { this.playing = false; this.dispatchEvent(new Event('ended')) }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const clip = (text: string): Clip => ({ key: `r\n${text}`, voice: 'v-00000001', text })

function setup(synth?: (voice: string, text: string, signal: AbortSignal) => Promise<Blob>) {
  FakeAudio.all = []
  const requests: string[] = []
  const player = new VoicePlayer(() => 0.5, synth ?? ((_, text) => { requests.push(text); return Promise.resolve(new Blob(['x'])) }), () => new FakeAudio(2.4))
  return { player, requests }
}

describe('voice player', () => {
  it('keeps revealed bubbles across player recreation and cache cleanup, but resets all data', () => {
    const values = new Map<string, string>()
    const storage: Storage = {
      get length() { return values.size },
      key: index => [...values.keys()][index] ?? null,
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: key => { values.delete(key) },
      clear: () => { values.clear() },
    }
    const first = new VoicePlayer(() => 1, undefined, undefined, storage)
    first.reveal('session:turn:step:0')
    first.clearCache()
    expect(first.isRevealed('session:turn:step:0')).toBe(true)
    first.dispose()
    const reopened = new VoicePlayer(() => 1, undefined, undefined, storage)
    expect(reopened.isRevealed('session:turn:step:0')).toBe(true)
    expect(reopened.isRevealed('another-session:turn:step:0')).toBe(false)
    storage.setItem('other-plugin', 'keep')
    reopened.clearReadState()
    expect(reopened.isRevealed('session:turn:step:0')).toBe(false)
    expect(storage.getItem('other-plugin')).toBe('keep')
    reopened.dispose()
  })

  it('clears generated audio and pending jobs without disposing the player', async () => {
    const { player, requests } = setup()
    let notifications = 0
    const stop = player.subscribe(() => { notifications++ })
    await player.prepare(clip('a'))
    player.clearCache()
    expect(player.status(clip('a').key)).toEqual({ state: 'idle' })
    const before = notifications
    await player.prepare(clip('a'))
    expect(requests).toEqual(['a', 'a'])
    expect(notifications).toBeGreaterThan(before)
    stop(); player.dispose()
  })

  it('generates each sentence once and reports its duration', async () => {
    const { player, requests } = setup()
    await Promise.all([player.prepare(clip('a')), player.prepare(clip('a'))])
    await player.prepare(clip('a'))
    expect(requests).toEqual(['a'])
    expect(player.status(clip('a').key)).toEqual({ state: 'ready', duration: 2.4 })
  })

  it('plays from the clicked sentence to the end of the reply', async () => {
    const { player } = setup()
    const clips = [clip('a'), clip('b'), clip('c')]
    const done = player.playFrom('reply-1', clips, 1, ['x:0', 'x:1', 'x:2'])
    await tick()
    expect(player.isActive('reply-1', clips[1]!.key)).toBe(true)
    expect(player.status(clips[1]!.key).state).toBe('playing')
    expect(FakeAudio.all[0]!.volume).toBe(0.5)
    FakeAudio.all[0]!.finish()
    await tick()
    expect(player.isActive('reply-1', clips[2]!.key)).toBe(true)
    FakeAudio.all[1]!.finish()
    await done
    expect(player.isActive('reply-1', clips[2]!.key)).toBe(false)
    expect([player.isRevealed('x:0'), player.isRevealed('x:1'), player.isRevealed('x:2')]).toEqual([false, true, true])
  })

  it('stops when the reply leaves the page or another one starts', async () => {
    const { player } = setup()
    void player.playFrom('reply-1', [clip('a'), clip('b')], 0, [])
    await tick()
    const first = FakeAudio.all[0]!
    expect(first.playing).toBe(true)
    player.leave('reply-2')
    expect(first.playing).toBe(true)
    player.leave('reply-1')
    expect(first.playing).toBe(false)
    expect(player.status(clip('a').key).state).toBe('ready')
    // 停下后不会接着播下一句。
    await tick()
    expect(player.isActive('reply-1', clip('b').key)).toBe(false)
  })

  it('shows the error on the card and retries on the next click', async () => {
    let fail = true
    const { player } = setup((_, text) => fail ? Promise.reject(new Error('连不上 GPT-SoVITS')) : Promise.resolve(new Blob([text])))
    await player.playFrom('reply-1', [clip('a')], 0, [])
    expect(player.status(clip('a').key)).toEqual({ state: 'error', message: '连不上 GPT-SoVITS' })
    fail = false
    void player.playFrom('reply-1', [clip('a')], 0, [])
    await tick()
    expect(player.status(clip('a').key).state).toBe('playing')
  })

  it('cancels a sentence still being generated when stopped', async () => {
    let signal: AbortSignal | undefined
    const { player } = setup((_, __, s) => { signal = s; return new Promise(() => {}) })
    void player.playFrom('reply-1', [clip('a')], 0, [])
    await tick()
    expect(player.status(clip('a').key).state).toBe('loading')
    player.stop()
    expect(signal?.aborted).toBe(true)
    await tick()
    expect(player.status(clip('a').key).state).toBe('idle')
  })
})

describe('voice state', () => {
  const view: VoiceView = {
    settings: DEFAULT_VOICE_SETTINGS,
    engines: [{ id: 'e-00000001', name: 'Fish', kind: 'fish', config: { baseUrl: '', model: 'm' }, hasKey: true }],
    voices: [{ id: 'v-00000001', name: '小雅', engine: 'e-00000001', params: { reference: 'r', promptText: '', promptLang: 'zh', textLang: 'zh' } }],
    keyStore: true,
  }

  it('plays only roles whose voice and connection still exist, and changes the key when settings change', () => {
    const state = new VoiceState()
    expect(state.playable('v-00000001')).toBeUndefined()
    state.adopt(view)
    const first = state.playable('v-00000001')
    expect(first?.voice).toBe('v-00000001')
    expect(state.playable('v-00000002')).toBeUndefined()
    expect(state.playable(undefined)).toBeUndefined()
    state.adopt({ ...view, voices: [{ ...view.voices[0]!, params: { ...view.voices[0]!.params, reference: 'r2' } }] })
    expect(state.playable('v-00000001')?.revision).not.toBe(first?.revision)
    state.adopt({ ...view, settings: { ...DEFAULT_VOICE_SETTINGS, enabled: false } })
    expect(state.playable('v-00000001')).toBeUndefined()
    state.adopt({ ...view, engines: [] })
    expect(state.playable('v-00000001')).toBeUndefined()
  })
})
