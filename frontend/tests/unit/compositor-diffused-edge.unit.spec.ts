import { describe, it, expect } from 'vitest'
import { diffusedEdgeInPlace, diffusedEdgeGrainField } from '~/lib/compositor/diffusedEdge'
import {
  isChainEffect, defaultPostEffect, POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
} from '~/lib/compositor/postEffects'
import { EFFECT_ORDER, EFFECT_LABELS } from '~/lib/compositor/effectStack'

const RED: [number, number, number] = [200, 30, 40]
const WHITE: [number, number, number] = [255, 255, 255]

/** A w×h opaque red layer, and an "outside" map whose alpha is `edge(x)` — the blurred
 *  outside-of-silhouette mask the pass reads (≈128 right on the edge, 0 deep inside). */
function layer(w: number, h: number, edge: (x: number) => number) {
  const px = new Uint8ClampedArray(w * h * 4)
  const outside = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px.set([...RED, 255], i * 4)
    outside[i * 4 + 3] = edge(i % w)
  }
  return { px, outside }
}
const rgbAt = (px: Uint8ClampedArray, i: number) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]

describe('diffusedEdgeInPlace — the smooth fade', () => {
  const smooth = { strength: 1, fill: WHITE, grain: 0, grainField: null }

  it('turns the far inside to the fill colour and keeps the edge colour', () => {
    const { px, outside } = layer(3, 1, x => [0, 64, 128][x]!)
    diffusedEdgeInPlace(px, outside, smooth)
    expect(rgbAt(px, 0)).toEqual(WHITE)          // deep inside → fill
    expect(rgbAt(px, 2)).toEqual(RED)            // on the edge → own colour
    const mid = rgbAt(px, 1)                     // half way → between the two
    expect(mid[1]).toBeGreaterThan(RED[1]); expect(mid[1]).toBeLessThan(255)
  })

  it('strength scales how far the middle moves toward the fill', () => {
    const { px, outside } = layer(1, 1, () => 0)
    diffusedEdgeInPlace(px, outside, { ...smooth, strength: 0.5 })
    // Half way from (200,30,40) to white = (227.5,142.5,147.5), within a rounding step.
    rgbAt(px, 0).forEach((v, k) => expect(Math.abs(v! - [227.5, 142.5, 147.5][k]!)).toBeLessThanOrEqual(0.5))
  })

  it('is a no-op at strength 0, never touches alpha, skips transparent pixels', () => {
    const { px, outside } = layer(2, 1, () => 0)
    px[7] = 0                                    // second pixel fully transparent
    const before = px.slice()
    diffusedEdgeInPlace(px, outside, { ...smooth, strength: 0 })
    expect(px).toEqual(before)
    diffusedEdgeInPlace(px, outside, smooth)
    expect(px[3]).toBe(255)
    expect(Array.from(px.slice(4, 8))).toEqual(Array.from(before.slice(4, 8)))
  })
})

describe('diffusedEdgeInPlace — grain', () => {
  it('at full grain every pixel is all-or-nothing, in the right share', () => {
    const w = 200, h = 200
    // A constant half-way fade: outside alpha 64 → the smooth fill amount is 0.5.
    const { px, outside } = layer(w, h, () => 64)
    diffusedEdgeInPlace(px, outside, { strength: 1, fill: WHITE, grain: 1, grainField: diffusedEdgeGrainField(w, h, 1) })
    let fill = 0
    for (let i = 0; i < w * h; i++) {
      const c = rgbAt(px, i)
      const isFill = c.every((v, k) => v === WHITE[k]), isOwn = c.every((v, k) => v === RED[k])
      expect(isFill || isOwn).toBe(true)
      if (isFill) fill++
    }
    expect(fill / (w * h)).toBeGreaterThan(0.46)
    expect(fill / (w * h)).toBeLessThan(0.54)
  })

  it('grain 0 ignores the field entirely', () => {
    const a = layer(4, 4, x => x * 40), b = layer(4, 4, x => x * 40)
    diffusedEdgeInPlace(a.px, a.outside, { strength: 1, fill: WHITE, grain: 0, grainField: diffusedEdgeGrainField(4, 4, 1) })
    diffusedEdgeInPlace(b.px, b.outside, { strength: 1, fill: WHITE, grain: 0, grainField: null })
    expect(a.px).toEqual(b.px)
  })
})

describe('diffusedEdgeGrainField', () => {
  const stats = (f: Float32Array) => {
    let lo = 1, hi = 0, sum = 0; const q = [0, 0, 0, 0]
    for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; q[Math.min(3, Math.floor(v * 4))]!++ }
    return { lo, hi, mean: sum / f.length, q: q.map(n => n / f.length) }
  }
  const neighbourCorr = (f: Float32Array, w: number) => {
    let s = 0, n = 0
    for (let i = 0; i < f.length - 1; i++) if ((i + 1) % w) { s += (f[i]! - 0.5) * (f[i + 1]! - 0.5); n++ }
    return s / n / (1 / 12)
  }

  it.each([1, 4])('is an even 0..1 spread at speck size %i', (size) => {
    const s = stats(diffusedEdgeGrainField(160, 160, size))
    expect(s.lo).toBeGreaterThanOrEqual(0); expect(s.hi).toBeLessThanOrEqual(1)
    expect(s.mean).toBeCloseTo(0.5, 1)
    for (const share of s.q) { expect(share).toBeGreaterThan(0.2); expect(share).toBeLessThan(0.3) }
  })

  it('is deterministic, and bigger specks are smoother (neighbours agree)', () => {
    expect(diffusedEdgeGrainField(32, 32, 3)).toEqual(diffusedEdgeGrainField(32, 32, 3))
    const fine = neighbourCorr(diffusedEdgeGrainField(160, 160, 1), 160)
    const big = neighbourCorr(diffusedEdgeGrainField(160, 160, 6), 160)
    expect(Math.abs(fine)).toBeLessThan(0.05)
    expect(big).toBeGreaterThan(0.5)
  })
})

describe('diffused_edge registration', () => {
  it('is a chain pass with defaults inside their clamps, listed with a label', () => {
    expect(isChainEffect({ type: 'diffused_edge' })).toBe(true)
    const d = defaultPostEffect('diffused_edge') as unknown as Record<string, unknown>
    expect(POST_EFFECT_DEFAULTS.diffused_edge.type).toBe('diffused_edge')
    expect(d).toMatchObject({ width: 0.05, strength: 1, grain: 0.8, grainSize: 1.5, color: '#ffffff' })
    for (const [k, [lo, hi]] of Object.entries(POST_FX_PARAM_CLAMP.diffused_edge!)) {
      expect(d[k] as number).toBeGreaterThanOrEqual(lo)
      expect(d[k] as number).toBeLessThanOrEqual(hi)
    }
    expect(EFFECT_ORDER).toContain('diffused_edge')
    expect(EFFECT_LABELS.diffused_edge).toBe('Diffused edge')
  })
})
