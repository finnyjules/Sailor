// frontend/tests/unit/studio-moves-ease.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveEase } from '~/lib/motion/easing'
import { DEFAULT_EASE, DEFAULT_PLAY, EASE_NAMES, easeGlyphPath, easeSample, easeToEngineName, mergeEase, mergePlay } from '~/lib/studio/moves/ease'
import type { MoveEase } from '~/lib/studio/moves/types'

describe('studio moves ease', () => {
  it('every named ease resolves with fixed endpoints', () => {
    for (const name of EASE_NAMES) { const fn = resolveEase(easeToEngineName({ kind: 'named', name })); expect(fn(0)).toBeCloseTo(0, 6); expect(fn(1)).toBeCloseTo(1, 6) }
  })
  it('smooth eases out; none is linear', () => {
    expect(easeSample({ kind: 'named', name: 'smooth' }, 0.25)).toBeGreaterThan(0.25)
    expect(easeSample({ kind: 'named', name: 'none' }, 0.4)).toBeCloseTo(0.4, 6)
  })
  it('a bezier ease round-trips through the engine name', () => {
    const ease: MoveEase = { kind: 'bezier', cps: [0.87, 0, 0.13, 1] }
    const fn = resolveEase(easeToEngineName(ease))
    expect(fn(0.25)).toBeLessThan(0.25); expect(fn(0)).toBeCloseTo(0, 4); expect(fn(1)).toBeCloseTo(1, 4)
  })
  it('the glyph path for a monotonic ease is monotone non-increasing in screen-y', () => {
    // y = (1 - easeSample(t)) * h, so a monotonically-increasing ease (smooth)
    // must produce screen-y values that never increase as x increases.
    const ys = [...easeGlyphPath({ kind: 'named', name: 'smooth' }, 40, 20).matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map(m => Number(m[1]))
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1])
  })
  it('swing is a distinct overshoot ease (back.inOut), not a plain quad', () => {
    const swing = (t: number) => easeSample({ kind: 'named', name: 'swing' }, t)
    expect(swing(0)).toBeCloseTo(0, 6)
    expect(swing(1)).toBeCloseTo(1, 6)
    expect(swing(0.25)).toBeLessThan(0)
    expect(swing(0.75)).toBeGreaterThan(1)
  })
  it('mergeEase and mergePlay reject junk and clamp', () => {
    expect(mergeEase(undefined)).toEqual(DEFAULT_EASE)
    expect(mergeEase({ kind: 'bezier', cps: [2, 5, -3, -9] })).toEqual({ kind: 'bezier', cps: [1, 1.6, 0, -0.6] })
    expect(mergePlay(undefined)).toEqual(DEFAULT_PLAY)
    expect(mergePlay({ mode: 'repeat', times: 99 })).toEqual({ mode: 'repeat', times: 20 })
  })
})
