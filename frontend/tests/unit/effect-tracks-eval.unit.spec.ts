import { describe, it, expect } from 'vitest'
import { evaluateDialTrack, type EffectDialTrack } from '~/lib/motion/effectTracks'
import { easeInOutQuad, linear } from '~/lib/motion/easing'
import { mixHex } from '~/lib/color/mix'

/**
 * F8 Task 2 · `evaluateDialTrack` — the pure keyframe interpolator for effect dials.
 * Mirrors `evaluateKeyframes` (evaluate.ts): sort-by-t, clamp before-first / after-last,
 * ease INTO the next keyframe with the FROM keyframe's ease (default easeInOut). Numbers
 * lerp, hex colours mix via `mixHex`, everything else STEPS to the FROM value.
 */

const track = (kfs: EffectDialTrack['keyframes'], space?: EffectDialTrack['space']): EffectDialTrack => ({
  target: 'layers.L1.effects.e1.amount',
  keyframes: kfs,
  space,
})

describe('evaluateDialTrack — numbers', () => {
  const num = track([
    { t: 0, v: 0 },
    { t: 1, v: 10 },
  ])

  it('returns the first value at t=0', () => {
    expect(evaluateDialTrack(num, 0)).toBe(0)
  })

  it('returns the last value at t=1 (end)', () => {
    expect(evaluateDialTrack(num, 1)).toBe(10)
  })

  it('easeInOut (default) matches evaluateKeyframes easing at a mid-bracket point', () => {
    const t = 0.25
    const p = easeInOutQuad((t - 0) / 1)
    expect(evaluateDialTrack(num, t)).toBeCloseTo(0 + (10 - 0) * p, 10)
  })

  it('linear ease matches a straight lerp and DIFFERS from easeInOut at the same t', () => {
    const lin = track([
      { t: 0, v: 0, ease: 'linear' },
      { t: 1, v: 10 },
    ])
    const t = 0.25
    const linearVal = evaluateDialTrack(lin, t)
    expect(linearVal).toBeCloseTo(0 + (10 - 0) * linear(t), 10)
    // The default (easeInOut) value at the same t is different from the linear one.
    expect(evaluateDialTrack(num, t)).not.toBeCloseTo(linearVal as number, 6)
  })

  it('holds past the end and before the first keyframe', () => {
    expect(evaluateDialTrack(num, 5)).toBe(10)
    expect(evaluateDialTrack(num, -5)).toBe(0)
  })

  it('a single keyframe holds its value at every t', () => {
    const one = track([{ t: 2, v: 7 }])
    expect(evaluateDialTrack(one, -10)).toBe(7)
    expect(evaluateDialTrack(one, 2)).toBe(7)
    expect(evaluateDialTrack(one, 99)).toBe(7)
  })

  it('sorts unsorted keyframes without mutating the input', () => {
    const kfs: EffectDialTrack['keyframes'] = [
      { t: 1, v: 10 },
      { t: 0, v: 0 },
    ]
    const tr = track(kfs)
    expect(evaluateDialTrack(tr, 0)).toBe(0)
    expect(evaluateDialTrack(tr, 1)).toBe(10)
    // input order preserved
    expect(kfs[0].t).toBe(1)
    expect(kfs[1].t).toBe(0)
  })
})

describe('evaluateDialTrack — colours', () => {
  it('returns EXACTLY the endpoints at t=0 and t=1 (mixHex exact-endpoint property)', () => {
    const col = track([
      { t: 0, v: '#ff0000' },
      { t: 1, v: '#0000ff' },
    ])
    expect(evaluateDialTrack(col, 0)).toBe(mixHex('#ff0000', '#0000ff', 0, 'oklch'))
    expect(evaluateDialTrack(col, 1)).toBe(mixHex('#ff0000', '#0000ff', 1, 'oklch'))
    // and those are the picked colours, byte for byte
    expect((evaluateDialTrack(col, 0) as string).slice(0, 7)).toBe('#ff0000')
    expect((evaluateDialTrack(col, 1) as string).slice(0, 7)).toBe('#0000ff')
  })

  it('mixes at mid-t between the endpoints (srgb space, per-channel between)', () => {
    const col = track(
      [
        { t: 0, v: '#000000' },
        { t: 1, v: '#ffffff' },
      ],
      'srgb',
    )
    const mid = evaluateDialTrack(col, 0.5) as string
    // grey between black and white in srgb
    const r = parseInt(mid.slice(1, 3), 16)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(255)
    // track.space 'srgb' maps to mixHex's 'rgb'; eased fraction is easeInOut(0.5) at t=0.5
    expect(mid).toBe(mixHex('#000000', '#ffffff', easeInOutQuad(0.5), 'rgb'))
  })

  it('picks the right bracket in a 3-stop colour track', () => {
    const col = track([
      { t: 0, v: '#ff0000' },
      { t: 1, v: '#00ff00' },
      { t: 2, v: '#0000ff' },
    ])
    // at t=1.5 it should mix green→blue, not red→green
    expect(evaluateDialTrack(col, 1.5)).toBe(mixHex('#00ff00', '#0000ff', easeInOutQuad(0.5), 'oklch'))
  })
})

describe('evaluateDialTrack — step fallback and edge cases', () => {
  it('mismatched number/string bracket holds the FROM value (no crash, no NaN)', () => {
    const mixed = track([
      { t: 0, v: 5 },
      { t: 1, v: '#ff0000' },
    ])
    const out = evaluateDialTrack(mixed, 0.5)
    expect(out).toBe(5)
    expect(Number.isNaN(out)).toBe(false)
  })

  it('a non-hex string steps to the FROM value', () => {
    const enumish = track([
      { t: 0, v: 'screen' },
      { t: 1, v: 'multiply' },
    ])
    expect(evaluateDialTrack(enumish, 0.5)).toBe('screen')
  })

  it('empty keyframes → undefined', () => {
    expect(evaluateDialTrack(track([]), 0.5)).toBeUndefined()
  })

  it('is deterministic — same inputs give the same output', () => {
    const num = track([
      { t: 0, v: 0 },
      { t: 1, v: 10 },
    ])
    const a = evaluateDialTrack(num, 0.37)
    const b = evaluateDialTrack(num, 0.37)
    expect(a).toBe(b)
  })
})
