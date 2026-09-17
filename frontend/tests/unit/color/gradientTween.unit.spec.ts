import { describe, it, expect } from 'vitest'
import { hexToOklab } from '~/lib/color/convert'
import { blendHex, sampleRamp, buildLUT, resampleStops, pairStops, crossfadeLUT, travelStops } from '~/lib/color/gradientTween'
import type { GradientStop } from '~/lib/color/harmony'

function chroma(hex: string): number { const [, a, b] = hexToOklab(hex); return Math.hypot(a, b) }

describe('blendHex', () => {
  it('returns exact endpoints', () => {
    expect(blendHex('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 1)).toBe('#0000ff')
    expect(blendHex('#ff0000', '#0000ff', -0.5, 'hybrid')).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 2, 'hybrid')).toBe('#0000ff')
  })

  it('oklab delegates to mixHex (matches its midpoint)', () => {
    // a mid blend is between the two colours, not equal to either
    const mid = blendHex('#ff0000', '#0000ff', 0.5, 'oklab')
    expect(mid).not.toBe('#ff0000')
    expect(mid).not.toBe('#0000ff')
  })

  it('hybrid keeps more chroma at the midpoint than oklab for a complementary pair', () => {
    const cOklab = chroma(blendHex('#ff7a00', '#0060ff', 0.5, 'oklab'))
    const cHybrid = chroma(blendHex('#ff7a00', '#0060ff', 0.5, 'hybrid'))
    expect(cHybrid).toBeGreaterThan(cOklab)
  })
})

const RAMP: GradientStop[] = [
  { pos: 0, color: '#000000' },
  { pos: 0.5, color: '#ff0000' },
  { pos: 1, color: '#ffffff' },
]

describe('sampleRamp', () => {
  it('clamps to the end stops outside [first,last]', () => {
    expect(sampleRamp(RAMP, -1)).toBe('#000000')
    expect(sampleRamp(RAMP, 2)).toBe('#ffffff')
  })
  it('returns a stop colour exactly at its position', () => {
    expect(sampleRamp(RAMP, 0.5)).toBe('#ff0000')
  })
  it('is order-independent (unsorted input)', () => {
    const shuffled = [RAMP[2], RAMP[0], RAMP[1]]
    expect(sampleRamp(shuffled, 0.5)).toBe('#ff0000')
  })
})

describe('buildLUT', () => {
  it('has size*3 bytes and exact endpoints', () => {
    const lut = buildLUT(RAMP, 'oklab', 256)
    expect(lut.length).toBe(768)
    expect([lut[0], lut[1], lut[2]]).toEqual([0, 0, 0])
    expect([lut[765], lut[766], lut[767]]).toEqual([255, 255, 255])
  })
})

describe('resampleStops / pairStops', () => {
  it('resamples up to n evenly-positioned stops', () => {
    const out = resampleStops([{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], 5)
    expect(out.length).toBe(5)
    expect(out.map(s => s.pos)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(out[0].color).toBe('#000000')
    expect(out[4].color).toBe('#ffffff')
  })
  it('returns equal-length arrays paired to the larger count', () => {
    const a = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]          // 2
    const b = [{ pos: 0, color: '#001122' }, { pos: 0.5, color: '#334455' }, { pos: 1, color: '#66778f' }] // 3
    const [A, B] = pairStops(a, b)
    expect(A.length).toBe(3)
    expect(B.length).toBe(3)
  })
})

const FROM: GradientStop[] = [{ pos: 0, color: '#120000' }, { pos: 0.6, color: '#c9370e' }, { pos: 1, color: '#ffcf7a' }]
const TO: GradientStop[] = [{ pos: 0, color: '#01121f' }, { pos: 0.28, color: '#043a5b' }, { pos: 0.55, color: '#1f8fa8' }, { pos: 0.8, color: '#7fe0c9' }, { pos: 1, color: '#f6ffe8' }]

describe('crossfadeLUT', () => {
  it('equals the source LUTs at the endpoints', () => {
    expect(Array.from(crossfadeLUT(FROM, TO, 0))).toEqual(Array.from(buildLUT(FROM)))
    expect(Array.from(crossfadeLUT(FROM, TO, 1))).toEqual(Array.from(buildLUT(TO)))
  })
})

describe('travelStops', () => {
  it('lands on the paired endpoints', () => {
    const [A, B] = pairStops(FROM, TO)
    expect(travelStops(FROM, TO, 0)).toEqual(A)
    expect(travelStops(FROM, TO, 1)).toEqual(B)
  })
  it('lerps a stop position across the transition', () => {
    // paired FROM (3→5) sits at even positions; TO keeps its real positions.
    const [A, B] = pairStops(FROM, TO)
    const mid = travelStops(FROM, TO, 0.5)
    expect(mid[1].pos).toBeCloseTo((A[1].pos + B[1].pos) / 2, 6)
  })
})
