import { describe, it, expect } from 'vitest'
import type { EffectDialTrack } from '~/lib/motion/effectTracks'
import { evaluateDialTrack, isGradientValue, addDialTrack } from '~/lib/motion/effectTracks'

const A = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
const B = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]

describe('isGradientValue', () => {
  it('recognises a stop array', () => {
    expect(isGradientValue(A)).toBe(true)
    expect(isGradientValue(3)).toBe(false)
    expect(isGradientValue('#fff')).toBe(false)
    expect(isGradientValue([{ pos: 0 }])).toBe(false)
  })
})

describe('evaluateDialTrack gradient values', () => {
  const track = (mode: 'crossfade' | 'travel'): EffectDialTrack => ({
    target: 'layers.L1.effects.fx.stops', mode, blendSpace: 'oklab',
    keyframes: [{ t: 0, v: A }, { t: 1, v: B }],
  })
  it('clamps to endpoints', () => {
    expect(evaluateDialTrack(track('crossfade'), 0)).toEqual(A)
    expect(evaluateDialTrack(track('crossfade'), 1)).toEqual(B)
  })
  it('crossfade returns a resolved stop array between the two at mid', () => {
    const mid = evaluateDialTrack(track('crossfade'), 0.5) as any[]
    expect(Array.isArray(mid)).toBe(true)
    expect(mid.length).toBeGreaterThan(2) // sampled crossfade (n stops)
    expect(isGradientValue(mid)).toBe(true)
  })
  it('travel returns paired stops at mid', () => {
    const mid = evaluateDialTrack(track('travel'), 0.5) as any[]
    expect(isGradientValue(mid)).toBe(true)
  })
  it('still lerps numbers', () => {
    const n: EffectDialTrack = { target: 't', keyframes: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }
    expect(evaluateDialTrack(n, 0.5)).toBeCloseTo(5, 6)
  })
})

describe('addDialTrack gradient seeding', () => {
  it('addDialTrack stores mode/blendSpace for a gradient track', () => {
    const [tr] = addDialTrack(undefined, 'layers.L1.fill', 0, A, undefined, { mode: 'travel', blendSpace: 'hybrid' })
    expect(tr.mode).toBe('travel')
    expect(tr.blendSpace).toBe('hybrid')
    expect(tr.keyframes[0].v).toEqual(A)
  })
})
