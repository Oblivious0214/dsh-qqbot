import { describe, expect, it } from 'vitest'
import { DEFAULT_PACING, pacingHold, parsePacing } from '../../src/toy/core/pacing.ts'

describe('motion pacing', () => {
  it('holds a new motion for the full tempo regardless of text length', () => {
    expect(pacingHold('好', true, DEFAULT_PACING)).toBe(5000)
    expect(pacingHold('字'.repeat(500), true, DEFAULT_PACING)).toBe(5000)
    expect(pacingHold('好', true, { seconds: 15 })).toBe(15000)
  })

  it('holds a continuation only for reading time, at least 2 seconds and at most the tempo', () => {
    expect(pacingHold('好', false, DEFAULT_PACING)).toBe(2000)
    expect(pacingHold('字'.repeat(30), false, DEFAULT_PACING)).toBe(5000)
    expect(pacingHold('字'.repeat(300), false, DEFAULT_PACING)).toBe(5000)
    expect(pacingHold('one two three four five six seven eight nine', false, DEFAULT_PACING)).toBe(3000)
    expect(pacingHold('好', false, { seconds: 1 })).toBe(1000)
  })

  it('defaults to 5 seconds and accepts custom seconds within the existing limits', () => {
    expect(DEFAULT_PACING).toEqual({ seconds: 5 })
    for (const seconds of [1, 7, 23, 120]) expect(parsePacing({ seconds })).toEqual({ seconds })
  })

  it('validates settings and treats the old min/max shape as default', () => {
    expect(parsePacing({ seconds: 15 })).toEqual({ seconds: 15 })
    expect(parsePacing({ min: 5, max: 20, speed: 143 })).toEqual({ seconds: 5 })
    expect(parsePacing({})).toEqual({ seconds: 5 })
    for (const seconds of [0, 121, 2.5, NaN, null, '8']) expect(() => parsePacing({ seconds })).toThrow('整数秒')
    expect(() => parsePacing(null)).toThrow()
  })
})
