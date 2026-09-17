import { describe, it, expect } from 'vitest'
import { hexToOklab, hexToRgb, rgbToHex } from '~/lib/color/convert'
import { blendHex, sampleRamp, buildLUT, resampleStops, pairStops, crossfadeLUT, travelStops, scrollLUT } from '~/lib/color/gradientTween'
import { mixHex } from '~/lib/color/mix'
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
  it('is byte-exact at the endpoints for positions that do not round-trip', () => {
    const FROM2: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]
    const TO2: GradientStop[] = [{ pos: 0, color: '#010101' }, { pos: 0.1, color: '#808080' }, { pos: 1, color: '#fefefe' }]
    const [A, B] = pairStops(FROM2, TO2)
    expect(travelStops(FROM2, TO2, 0)).toEqual(A)
    expect(travelStops(FROM2, TO2, 1)).toEqual(B) // fails pre-fix: 0.5+(0.1-0.5) !== 0.1
  })
})

const WHEEL: GradientStop[] = [
  { pos: 0, color: '#1436ff' },   // blue
  { pos: 0.5, color: '#ff2d2d' },  // red
  { pos: 1, color: '#ffd21f' },    // yellow
]

describe('scrollLUT', () => {
  it('loops seamlessly (phase 0 == phase 1)', () => {
    expect(Array.from(scrollLUT(WHEEL, 0))).toEqual(Array.from(scrollLUT(WHEEL, 1)))
  })
  it('advances the wheel by one stop at phase = 1/n', () => {
    // at phase 0 the LUT starts on blue; at phase 1/3 (n=3) it starts on red.
    const base = scrollLUT(WHEEL, 0)
    const oneStep = scrollLUT(WHEEL, 1 / 3)
    const startBase = [base[0], base[1], base[2]]
    const startStep = [oneStep[0], oneStep[1], oneStep[2]]
    // blue ≈ (20,54,255); red ≈ (255,45,45)
    expect(startStep[0]).toBeGreaterThan(startBase[0]) // more red channel
    expect(startStep[2]).toBeLessThan(startBase[2])    // less blue channel
  })
})

function dE(h1: string, h2: string): number {
  const A = hexToOklab(h1), B = hexToOklab(h2)
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2])
}
function lutHex(lut: Uint8ClampedArray, i: number): string {
  return rgbToHex(lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2])
}
// worst jump between ADJACENT positions within a frame (a hue seam), swept over t.
function worstSpatial(from: GradientStop[], to: GradientStop[], make: (t: number) => Uint8ClampedArray): number {
  let worst = 0
  for (let f = 0; f <= 40; f++) {
    const lut = make(f / 40)
    for (let i = 1; i < 256; i++) worst = Math.max(worst, dE(lutHex(lut, i - 1), lutHex(lut, i)))
  }
  return worst
}
// an OKLCH crossfade built directly, for contrast only (not a shipped path).
function oklchCrossfade(from: GradientStop[], to: GradientStop[], t: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const u = i / 255
    const c = mixHex(sampleRamp(from, u), sampleRamp(to, u), t, 'oklch')
    const [r, g, b] = hexToRgb(c)
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b
  }
  return lut
}

describe('crossfade smoothness (OKLab beats OKLCH)', () => {
  const EMBER: GradientStop[] = [{ pos: 0, color: '#120000' }, { pos: 0.6, color: '#c9370e' }, { pos: 1, color: '#ffcf7a' }]
  const OCEAN: GradientStop[] = [{ pos: 0, color: '#01121f' }, { pos: 0.28, color: '#043a5b' }, { pos: 0.55, color: '#1f8fa8' }, { pos: 0.8, color: '#7fe0c9' }, { pos: 1, color: '#f6ffe8' }]

  it('oklab has no spatial seam', () => {
    expect(worstSpatial(EMBER, OCEAN, t => crossfadeLUT(EMBER, OCEAN, t, 'oklab'))).toBeLessThan(0.05)
  })
  it('oklch would seam (documents why it is not the default)', () => {
    expect(worstSpatial(EMBER, OCEAN, t => oklchCrossfade(EMBER, OCEAN, t))).toBeGreaterThan(0.1)
  })
})
