import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MAX_HOLD_MS, ReplyClock, type ClockTimers, type SegmentEndReason, type SegmentHooks, type SegmentStage } from '../src/client/reply-clock.ts'
import { SegmentsService, type QqbotSegments } from '../src/client/segments-service.ts'
import { SegmentAnnotations } from '../src/client/segment-annotations.tsx'
import { decodeReply, INVALID_REPLY } from '../src/client/decode.ts'
import { parseTimedReply, parseTimedStream, salvageTimedReply } from '../src/vendor/dialogue-timing/protocol.js'

/** 假时钟：advance(ms) 按时间顺序执行到点的计时器。 */
function fakeTimers() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: ClockTimers = {
    now: () => now,
    set: (callback, ms) => { pending.set(++seq, { at: now + ms, callback }); return seq },
    clear: (handle) => { pending.delete(handle as number) },
  }
  const advance = (ms: number) => {
    const end = now + ms
    while (true) {
      const next = [...pending].filter(([, t]) => t.at <= end).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0]
      if (next === undefined) break
      pending.delete(next[0])
      now = next[1].at
      next[1].callback()
    }
    now = end
  }
  return { timers, advance, pending: () => pending.size }
}

type Event = [string, ...unknown[]]

function setup(delay = 1000) {
  const fake = fakeTimers()
  const errors: unknown[] = []
  let changes = 0
  const clock = new ReplyClock({ delay: () => delay, onChange: () => { changes++ }, onError: (e) => { errors.push(e) }, timers: fake.timers })
  const events: Event[] = []
  const hooks: SegmentHooks = {
    revealed: (session, reply, index, stage, hold) => { events.push(['revealed', session, reply, index, stage.text, hold]) },
    ended: (session, reply, reason) => { events.push(['ended', session, reply, reason]) },
  }
  const off = clock.register(hooks)
  return { clock, fake, events, errors, off, changes: () => changes }
}

const stages = (...texts: string[]): SegmentStage[] => texts.map(text => ({ text }))

describe('parseTimedStream', () => {
  it('reads closed stages while streaming and the full block once closed', () => {
    expect(parseTimedStream('前言[qq]{"version":1,"stages":[{"text":"a\\"}{["},{"text":"b')).toEqual({ stages: [{ text: 'a"}{[' }], complete: false })
    expect(parseTimedStream('[qq]{"version":1,"stages":[{"text":"a"')).toBeNull()
    expect(parseTimedStream('[qq]{"stages":[{"text":"a"}')).toEqual({ stages: [{ text: 'a' }], complete: false })
    expect(parseTimedStream('普通回复')).toBeNull()
    expect(parseTimedStream('[qq]{"version":1,"stages":[{"text":"a","seconds":20}]}[/qq]')).toEqual({ stages: [{ text: 'a' }], complete: true })
    expect(parseTimedStream('[qq]{"version":1,"stages":[{"text":""},')).toBeNull()
    expect(parseTimedStream('[qq]{"version":1,"stages":[{"text":"a","durationMs":500,"emotion":"happy"}]}[/qq]')).toEqual({ stages: [{ text: 'a' }], complete: true })
    // 段落停留由显示时钟决定：模型写的 seconds、cycles 都丢掉，其余照常。
    expect(parseTimedStream('[qq]{"version":1,"stages":[{"text":"a","seconds":4},{"text":"b","seconds":"20","motion":{"stop":true}},{"text":"c","seconds":121},{"text":"d","seconds":12.5},{"text":"e","cycles":3},{"text":"f"'))
      .toEqual({ stages: [{ text: 'a' }, { text: 'b', motion: { stop: true } }, { text: 'c' }, { text: 'd' }, { text: 'e' }], complete: false })
    expect(parseTimedStream('[qq]{"version":1,"stages":[{"text":"a"}],"extra":1}[/qq]')).toEqual({ stages: [{ text: 'a' }], complete: true })
    expect(() => parseTimedStream('[qq]{"version":1,"stages":[{"text":"a"}]}[/qq][qq]{}[/qq]')).toThrow()
  })

  it('drops a duration written inside motion', () => {
    const motion = { range: 'full', tier: 'low', action: '稳定节奏' }
    const reply = (stage: object) => parseTimedReply(`[qq]${JSON.stringify({ version: 1, stages: [{ text: 'a', ...stage }] })}[/qq]`)!.stages[0]
    expect(reply({ motion: { ...motion, seconds: 20 } })).toEqual({ text: 'a', motion })
    expect(reply({ motion: { ...motion, cycles: 4 } })).toEqual({ text: 'a', motion })
    expect(reply({ motion: { ...motion, cycles: 4, seconds: 200 } })).toEqual({ text: 'a', motion })
    expect(reply({ seconds: 15, motion: { ...motion, seconds: 30 } })).toEqual({ text: 'a', motion })
    expect(reply({ motion: { stop: true, seconds: 10 } })).toEqual({ text: 'a', motion: { stop: true } })
    // 流式读到的闭合段落同样处理。
    expect(parseTimedStream(`[qq]{"version":1,"stages":[{"text":"a","motion":${JSON.stringify({ ...motion, seconds: 20 })}},{"text":"b`)!.stages)
      .toEqual([{ text: 'a', motion }])
  })
})

describe('salvage', () => {
  // 段落之间缺逗号，修复也读不出，只能抢救文字。
  const broken = '[qq]{"version":1,"stages":[{"text":"他说"你好"","motion":{"range":"full","tier":"high","action":"steady"}}{"text":"第二\n行\\n","seconds":20}]}[/qq]'

  it('keeps only text from a block whose JSON cannot be repaired', () => {
    expect(salvageTimedReply(broken)).toEqual({ version: 1, stages: [
      { text: '他说"你好"', salvaged: true }, { text: '第二\n行\n', salvaged: true },
    ] })
    // 能读出的块按正常规则，不救；抽不出文字也不救。
    expect(salvageTimedReply('[qq]{"version":1,"stages":[{"text":"a"}],"extra":1}[/qq]')).toBeNull()
    expect(salvageTimedReply('[qq]{"version":1,"stages":[{"txt":"a"}[/qq]')).toBeNull()
    expect(salvageTimedReply('普通回复')).toBeNull()
  })

  it('waits while streaming, then shows salvaged text after the stages already read', () => {
    const head = parseTimedStream('[qq]{"version":1,"stages":[{"text":"他说"},{"text":"x')!
    expect(head.stages).toEqual([{ text: '他说' }])
    const tail = '[qq]{"version":1,"stages":[{"text":"他说"}{"text":"坏"引号"}]}[/qq]'
    expect(decodeReply(tail, true, head)).toEqual({ stream: { stages: head.stages, complete: false }, error: '' })
    expect(decodeReply(tail, false, head)).toEqual({ stream: { stages: [{ text: '他说' }, { text: '坏"引号', salvaged: true }], complete: true }, error: '' })
    // 和已显示的对不上，或抽不出来时显示错误。
    expect(decodeReply(tail, false, { stages: [{ text: '别的' }], complete: false })).toEqual({ stream: null, error: INVALID_REPLY })
    expect(decodeReply('[qq]{"version":1,"stages":[{"txt":"a"}]}[/qq]', false, null)).toEqual({ stream: null, error: INVALID_REPLY })
  })
})

describe('reply clock', () => {
  it('times the wait by the next segment, picks up setting changes for later waits, and lets a device override', () => {
    const fake = fakeTimers()
    let perChar = 100
    const clock = new ReplyClock({ delay: next => next.length * perChar, timers: fake.timers, onChange: () => {}, onError: error => { throw error } })
    clock.feed('s', 'r', stages('一', '二三四五', '六'), true, true)
    fake.advance(0)
    expect(clock.count('s', 'r')).toBe(1)
    perChar = 50
    fake.advance(399)
    expect(clock.count('s', 'r')).toBe(1)
    fake.advance(1)
    expect(clock.count('s', 'r')).toBe(2)
    fake.advance(49)
    expect(clock.count('s', 'r')).toBe(2)
    fake.advance(1)
    expect(clock.count('s', 'r')).toBe(3)
    clock.register({ durations: (_s, _r, all, i) => all[i]?.motion !== undefined ? 3000 : undefined })
    clock.feed('s', 'device', [{ text: '一', motion: { stop: true } }, { text: '二' }], true, true)
    fake.advance(2999)
    expect(clock.count('s', 'device')).toBe(1)
    expect(clock.playback('s', 'device')?.typing).toBe(false)
    fake.advance(1)
    expect(clock.count('s', 'device')).toBe(2)
    clock.dispose()
  })

  it('waits for a streamed next segment, counting typing time from when the previous one appeared', () => {
    const fake = fakeTimers()
    const clock = new ReplyClock({ delay: next => next.length * 100, timers: fake.timers, onChange: () => {}, onError: error => { throw error } })
    clock.feed('s', 'r', stages('a'), false, true)
    fake.advance(0)
    expect(clock.playback('s', 'r')).toEqual({ index: 0, status: 'running', remainingMs: 0, typing: true })
    // 生成比打字慢：下一段一到就显示。
    fake.advance(1000)
    clock.feed('s', 'r', stages('a', 'bb'), false, true)
    fake.advance(0)
    expect(clock.count('s', 'r')).toBe(2)
    // 生成比打字快：从上一段出现起算打字时间。
    fake.advance(100)
    clock.feed('s', 'r', stages('a', 'bb', 'cccc'), true, true)
    fake.advance(299)
    expect(clock.count('s', 'r')).toBe(2)
    expect(clock.playback('s', 'r')?.typing).toBe(true)
    fake.advance(1)
    expect(clock.playback('s', 'r')).toEqual({ index: 2, status: 'complete', remainingMs: 0, typing: false })
    clock.dispose()
  })

  it('keeps the elapsed typing time across a pause while waiting for the next segment', () => {
    const fake = fakeTimers()
    const clock = new ReplyClock({ delay: next => next.length * 100, timers: fake.timers, onChange: () => {}, onError: error => { throw error } })
    clock.feed('s', 'r', stages('x'), false, true)
    fake.advance(100)
    const resume = clock.pause('s')
    expect(clock.playback('s', 'r')?.typing).toBe(false)
    fake.advance(10000)
    clock.feed('s', 'r', stages('x', 'yyyy'), true, true)
    fake.advance(0)
    expect(clock.count('s', 'r')).toBe(1)
    resume()
    fake.advance(299)
    expect(clock.count('s', 'r')).toBe(1)
    fake.advance(1)
    expect(clock.count('s', 'r')).toBe(2)
    clock.dispose()
  })

  it('reveals a complete live reply stage by stage and ends once', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', '1:0', stages('a', 'b', 'c'), true, true)
    expect(clock.count('s', '1:0')).toBe(0)
    fake.advance(0)
    expect(clock.count('s', '1:0')).toBe(1)
    fake.advance(999)
    expect(clock.count('s', '1:0')).toBe(1)
    fake.advance(1)
    expect(clock.count('s', '1:0')).toBe(2)
    fake.advance(1000)
    expect(clock.count('s', '1:0')).toBe(3)
    expect(events).toEqual([
      ['revealed', 's', '1:0', 0, 'a', 1000],
      ['revealed', 's', '1:0', 1, 'b', 1000],
      ['revealed', 's', '1:0', 2, 'c', undefined],
      ['ended', 's', '1:0', 'complete'],
    ])
    expect(fake.pending()).toBe(0)
  })

  it('shows history at once without timers or hooks', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', '1:0', stages('a', 'b'), true, false)
    expect(clock.count('s', '1:0')).toBe(2)
    clock.feed('s', '1:0', stages('a', 'b', 'c'), true, true)
    expect(clock.count('s', '1:0')).toBe(3)
    expect(fake.pending()).toBe(0)
    expect(events).toEqual([])
    expect(clock.count('s', 'unknown')).toBeUndefined()
  })

  it('reveals the first closed stage while streaming and waits for late stages', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', 'r', stages('a'), false, true)
    fake.advance(0)
    expect(clock.count('s', 'r')).toBe(1)
    // 到点了第二段还没生成，等着。
    fake.advance(3000)
    expect(clock.count('s', 'r')).toBe(1)
    clock.feed('s', 'r', stages('a', 'b'), false, true)
    fake.advance(0)
    expect(clock.count('s', 'r')).toBe(2)
    // 第二段的间隔还没到时第三段生成了，按间隔出现。
    clock.feed('s', 'r', stages('a', 'b', 'c'), false, true)
    fake.advance(999)
    expect(clock.count('s', 'r')).toBe(2)
    fake.advance(1)
    expect(clock.count('s', 'r')).toBe(3)
    // 回复完整时最后一段早已显示：补一次 holdMs 为 undefined 的 revealed 再结束。
    clock.feed('s', 'r', stages('a', 'b', 'c'), true, true)
    expect(events.slice(-3)).toEqual([
      ['revealed', 's', 'r', 2, 'c', 1000],
      ['revealed', 's', 'r', 2, 'c', undefined],
      ['ended', 's', 'r', 'complete'],
    ])
    expect(fake.pending()).toBe(0)
  })

  it('takes hook durations first, then the ui delay, clamped', () => {
    const { clock, fake, events, errors } = setup(700)
    const seen: [readonly SegmentStage[], number][] = []
    clock.register({ durations: () => { throw new Error('boom') } })
    clock.register({ durations: (_s, _r, all, index) => { seen.push([all, index]); return index === 0 ? 2500 : index === 1 ? 10 ** 9 : undefined } })
    clock.register({ durations: () => 1 })
    clock.feed('s', 'r', [{ text: 'a', motion: { stop: true } }, { text: 'b' }, { text: 'c' }], true, true)
    fake.advance(0)
    fake.advance(2500)
    fake.advance(MAX_HOLD_MS)
    const holds = events.filter(e => e[0] === 'revealed').map(e => e[5])
    expect(holds).toEqual([2500, MAX_HOLD_MS, undefined])
    expect(seen[0]).toEqual([[{ text: 'a', motion: { stop: true } }, { text: 'b' }, { text: 'c' }], 0])
    expect(errors.length).toBe(3)
  })

  it('falls back to the ui delay when no hook answers', () => {
    const { clock, fake, events } = setup(700)
    clock.register({ durations: () => undefined })
    clock.feed('s', 'r', stages('a', 'b', 'c'), true, true)
    fake.advance(0)
    fake.advance(700)
    expect(events.filter(e => e[0] === 'revealed').map(e => e[5])).toEqual([700, 700])
  })

  it('stops at the current stage when interrupted', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', 'r', stages('a', 'b', 'c'), true, true)
    clock.feed('other', 'r', stages('x', 'y'), true, true)
    fake.advance(0)
    clock.interrupt('s')
    fake.advance(5000)
    expect(clock.count('s', 'r')).toBe(1)
    expect(clock.count('other', 'r')).toBe(2)
    clock.feed('s', 'r', stages('a', 'b', 'c'), true, true)
    fake.advance(5000)
    expect(clock.count('s', 'r')).toBe(1)
    expect(events.filter(e => e[1] === 's')).toEqual([['revealed', 's', 'r', 0, 'a', 1000], ['ended', 's', 'r', 'interrupted']])
  })

  it('pauses the session and resumes with the remaining time', () => {
    const { clock, fake } = setup()
    clock.feed('s', 'r', stages('a', 'b', 'c'), true, true)
    fake.advance(0)
    fake.advance(400)
    const first = clock.pause('s')
    const second = clock.pause('s')
    // 暂停期间新回复也不开始。
    clock.feed('s', 'r2', stages('x'), true, true)
    fake.advance(10000)
    expect([clock.count('s', 'r'), clock.count('s', 'r2')]).toEqual([1, 0])
    first()
    first()
    fake.advance(10000)
    expect(clock.count('s', 'r')).toBe(1)
    second()
    fake.advance(599)
    expect(clock.count('s', 'r')).toBe(1)
    fake.advance(1)
    expect(clock.count('s', 'r')).toBe(2)
    expect(clock.count('s', 'r2')).toBe(1)
  })

  it('completes a fully shown reply only after resume', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', 'r', stages('a'), false, true)
    fake.advance(0)
    const resume = clock.pause('s')
    clock.feed('s', 'r', stages('a'), true, true)
    expect(events.some(e => e[0] === 'ended')).toBe(false)
    resume()
    expect(events.slice(-2)).toEqual([['revealed', 's', 'r', 0, 'a', undefined], ['ended', 's', 'r', 'complete']])
  })

  it('fails a reply that ends unusable or is replaced at the same position', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', 'r', stages('a', 'b'), false, true)
    fake.advance(0)
    clock.fail('s', 'r')
    fake.advance(5000)
    expect(clock.count('s', 'r')).toBe(1)
    clock.feed('s', 'q', stages('a', 'b'), true, true)
    fake.advance(0)
    clock.feed('s', 'q', stages('z', 'b'), true, true)
    fake.advance(0)
    expect(events.filter(e => e[0] === 'ended')).toEqual([['ended', 's', 'r', 'failed'], ['ended', 's', 'q', 'failed']])
    expect(events.at(-1)).toEqual(['revealed', 's', 'q', 0, 'z', 1000])
  })

  it('keeps running and isolates a throwing hook', () => {
    const { clock, fake, errors, changes } = setup()
    clock.register({ revealed: () => { throw new Error('x') } })
    clock.feed('s', 'r', stages('a', 'b'), true, true)
    fake.advance(2000)
    expect(clock.count('s', 'r')).toBe(2)
    expect(errors.length).toBe(2)
    // 两次显示和一次完成状态通知；只读播放状态也需要收到结束更新。
    expect(changes()).toBe(3)
  })

  it('closes unfinished replies and stops calling hooks after dispose', () => {
    const { clock, fake, events, off } = setup()
    clock.feed('s', 'r', stages('a', 'b'), true, true)
    clock.feed('s', 'done', stages('a'), true, true)
    fake.advance(0)
    clock.dispose()
    off()
    fake.advance(5000)
    expect(events.filter(e => e[0] === 'ended').map(e => [e[2], e[3]])).toEqual([['done', 'complete'], ['r', 'closed']])
    expect(fake.pending()).toBe(0)
  })
})

describe('qqbotSegments service', () => {
  it('ties registrations and pauses to the calling plugin', async () => {
    const fake = fakeTimers()
    const clock = new ReplyClock({ delay: () => 1000, onChange: () => {}, onError: () => {}, timers: fake.timers })
    const root = new Context()
    const annotations = new SegmentAnnotations()
    await root.plugin(SegmentsService, { clock, annotations })
    const ended: SegmentEndReason[] = []
    const consumer = await root.plugin({
      name: 'consumer',
      inject: ['qqbotSegments'],
      apply: (ctx: Context) => {
        const segments = (ctx as unknown as { qqbotSegments: QqbotSegments }).qqbotSegments
        segments.register({ ended: (_s, _r, reason) => { ended.push(reason) } })
        segments.pause('s')
        segments.annotate(() => null)
      },
    })
    clock.feed('s', 'r', stages('a'), true, true)
    fake.advance(0)
    expect([clock.paused('s'), clock.count('s', 'r')]).toEqual([true, 0])
    expect(annotations.getSnapshot()).toHaveLength(1)
    await consumer.dispose()
    expect(clock.paused('s')).toBe(false)
    expect(annotations.getSnapshot()).toHaveLength(0)
    fake.advance(0)
    expect(clock.count('s', 'r')).toBe(1)
    expect(ended).toEqual([])
  })
})

describe('read-only segment playback', () => {
  it('reads the resolved interval, freezes nested pauses and resumes the remainder', () => {
    const { clock, fake, events } = setup()
    clock.register({ durations: () => 2400 })
    clock.feed('s', 'r', stages('a', 'b'), true, true)
    fake.advance(600)
    expect(clock.playback('s', 'r')).toEqual({ index: 0, status: 'running', remainingMs: 1800, typing: false })
    const resume = clock.pause('s'), resume2 = clock.pause('s')
    fake.advance(10000)
    resume()
    expect(clock.playback('s', 'r')).toEqual({ index: 0, status: 'paused', remainingMs: 1800, typing: false })
    const before = events.length
    for (let i = 0; i < 100; i++) clock.playback('s', 'r')
    expect(events).toHaveLength(before)
    resume2()
    fake.advance(1799)
    expect(clock.playback('s', 'r')?.remainingMs).toBe(1)
    fake.advance(1)
    expect(clock.playback('s', 'r')).toEqual({ index: 1, status: 'complete', remainingMs: 0, typing: false })
  })

  it('reports stream waits, cancellation, failures and history without new timers', () => {
    const { clock, fake, events } = setup()
    clock.feed('s', 'stream', stages('a'), false, true)
    fake.advance(1200)
    expect(clock.playback('s', 'stream')).toEqual({ index: 0, status: 'running', remainingMs: 0, typing: true })
    clock.interrupt('s')
    expect(clock.playback('s', 'stream')?.status).toBe('interrupted')
    clock.feed('s', 'failed', stages('a', 'b'), false, true)
    fake.advance(0)
    clock.fail('s', 'failed')
    expect(clock.playback('s', 'failed')?.status).toBe('failed')
    const before = events.length
    clock.feed('s', 'history', stages('old'), true, false)
    expect(clock.playback('s', 'history')?.status).toBe('history')
    expect(clock.playback('s', 'absent')).toBeUndefined()
    expect(events).toHaveLength(before)
    expect(fake.pending()).toBe(0)
  })
})
