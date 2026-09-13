import { describe, it, expect } from 'vitest'
import {
  applyRoughEdgeToData, applyInkBleedToData,
  ROUGH_EDGE_MAX_W, INK_BLEED_MAX_W,
} from '~/lib/compositor/edgeDistort'
import {
  isChainEffect, defaultPostEffect, POST_EFFECT_DEFAULTS, POST_FX_PARAM_CLAMP,
  type RoughEdgeEffect, type InkBleedEffect,
} from '~/lib/compositor/postEffects'

const W = 100, H = 100
// A hard opaque white square in the middle — a clean silhouette to distort.
const R0 = 30, R1 = 70
function square(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = R0; y < R1; y++) for (let x = R0; x < R1; x++) {
    const o = (y * W + x) * 4
    d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255
  }
  return d
}
const alphaAt = (d: Uint8ClampedArray, x: number, y: number): number => d[(y * W + x) * 4 + 3]!
const coverage = (d: Uint8ClampedArray): number => {
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 8) n++
  return n
}
/** Opaque bounding box of a buffer (or null when fully transparent). */
function bbox(d: Uint8ClampedArray): { minx: number; miny: number; maxx: number; maxy: number } | null {
  let minx = W, miny = H, maxx = -1, maxy = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (alphaAt(d, x, y) > 8) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y }
  }
  return maxx < 0 ? null : { minx, miny, maxx, maxy }
}

const rough = (over: Partial<RoughEdgeEffect> = {}): RoughEdgeEffect =>
  ({ type: 'rough_edge', amount: 1, detail: 8, seed: 1, visible: true, ...over })
const ink = (over: Partial<InkBleedEffect> = {}): InkBleedEffect =>
  ({ type: 'ink_bleed', amount: 1, seed: 1, softness: 0.3, visible: true, ...over })

describe('edge-distort registration', () => {
  it('both kinds are chain effects with type-matching defaults inside their clamp ranges', () => {
    for (const t of ['rough_edge', 'ink_bleed'] as const) {
      expect(isChainEffect(defaultPostEffect(t))).toBe(true)
      expect(POST_EFFECT_DEFAULTS[t].type).toBe(t)
      const d = defaultPostEffect(t) as unknown as Record<string, number>
      for (const [k, [lo, hi]] of Object.entries(POST_FX_PARAM_CLAMP[t]!)) {
        expect(d[k]!, `${t}.${k}`).toBeGreaterThanOrEqual(lo)
        expect(d[k]!, `${t}.${k}`).toBeLessThanOrEqual(hi)
      }
    }
  })
  it('every param is numeric and clamped — seed included, so the agent drives both fully (no Task-8 whitelist)', () => {
    // The generic sanitizer only copies params present in the clamp table; a missing seed would be a
    // dead control through the agent. Every dial of both kinds is here.
    expect(Object.keys(POST_FX_PARAM_CLAMP.rough_edge!).sort()).toEqual(['amount', 'detail', 'seed'])
    expect(Object.keys(POST_FX_PARAM_CLAMP.ink_bleed!).sort()).toEqual(['amount', 'seed', 'softness'])
  })
  it('exposes normalised-to-width outward-reach constants for the pad helper', () => {
    expect(ROUGH_EDGE_MAX_W).toBeGreaterThan(0)
    expect(INK_BLEED_MAX_W).toBeGreaterThan(0)
  })
})

describe('applyRoughEdgeToData', () => {
  it('is a no-op at amount 0 (byte-identical buffer)', () => {
    const a = square(), b = square()
    applyRoughEdgeToData(a, W, H, rough({ amount: 0 }), 1)
    expect([...a]).toEqual([...b])
  })
  it('changes the alpha boundary vs the clean silhouette (edge pixels flip)', () => {
    const clean = square(), out = square()
    applyRoughEdgeToData(out, W, H, rough(), 1)
    // Something on the edge flipped: coverage changed, and the two buffers differ.
    expect([...out]).not.toEqual([...clean])
    expect(coverage(out)).not.toBe(coverage(clean))
    // A deep-interior pixel is untouched (only the boundary band moves).
    expect(alphaAt(out, 50, 50)).toBe(255)
  })
  it('grows the alpha OUTSIDE the original bounds at least somewhere (outward jitter)', () => {
    const out = square()
    applyRoughEdgeToData(out, W, H, rough(), 1)
    const bb = bbox(out)!
    // The amplitude is amount·ROUGH_EDGE_MAX_W·W ≈ 3px, so the jitter must reach past R0/R1 somewhere.
    expect(bb.minx < R0 || bb.miny < R0 || bb.maxx > R1 - 1 || bb.maxy > R1 - 1).toBe(true)
  })
  it('is deterministic: same seed → identical, different seed → different', () => {
    const a = square(), b = square(), c = square()
    applyRoughEdgeToData(a, W, H, rough({ seed: 7 }), 1)
    applyRoughEdgeToData(b, W, H, rough({ seed: 7 }), 1)
    applyRoughEdgeToData(c, W, H, rough({ seed: 8 }), 1)
    expect([...a]).toEqual([...b])
    expect([...a]).not.toEqual([...c])
  })
  it('leaves a fully-transparent buffer untouched', () => {
    const a = new Uint8ClampedArray(W * H * 4), b = new Uint8ClampedArray(W * H * 4)
    applyRoughEdgeToData(a, W, H, rough(), 1)
    expect([...a]).toEqual([...b])
  })
})

describe('applyInkBleedToData', () => {
  it('is a no-op at amount 0 (byte-identical buffer)', () => {
    const a = square(), b = square()
    applyInkBleedToData(a, W, H, ink({ amount: 0 }), 1)
    expect([...a]).toEqual([...b])
  })
  it('adds alpha OUTSIDE the original bounds and never erodes the interior', () => {
    const clean = square(), out = square()
    applyInkBleedToData(out, W, H, ink(), 1)
    // Interior is never touched — coverage only grows.
    expect(coverage(out)).toBeGreaterThan(coverage(clean))
    for (let y = R0; y < R1; y++) for (let x = R0; x < R1; x++) expect(alphaAt(out, x, y)).toBe(255)
    // The spread reaches past the original edge somewhere.
    const bb = bbox(out)!
    expect(bb.minx < R0 || bb.miny < R0 || bb.maxx > R1 - 1 || bb.maxy > R1 - 1).toBe(true)
  })
  it('the grown pixels take the layer edge colour, not black', () => {
    const out = square()
    applyInkBleedToData(out, W, H, ink(), 1)
    // Find a newly-opaque pixel just left of the original edge and check it is white (edge colour).
    let found = false
    for (let y = R0; y < R1 && !found; y++) {
      for (let x = R0 - 1; x >= Math.max(0, R0 - 6); x--) {
        if (alphaAt(out, x, y) > 8) {
          const o = (y * W + x) * 4
          expect(out[o]).toBeGreaterThan(200); expect(out[o + 1]).toBeGreaterThan(200); expect(out[o + 2]).toBeGreaterThan(200)
          found = true; break
        }
      }
    }
    expect(found).toBe(true)
  })
  it('is deterministic: same seed → identical, different seed → different', () => {
    const a = square(), b = square(), c = square()
    applyInkBleedToData(a, W, H, ink({ seed: 3 }), 1)
    applyInkBleedToData(b, W, H, ink({ seed: 3 }), 1)
    applyInkBleedToData(c, W, H, ink({ seed: 4 }), 1)
    expect([...a]).toEqual([...b])
    expect([...a]).not.toEqual([...c])
  })
})
