import { describe, it, expect } from 'vitest'
import {
  samplePointsFromStroke, layerAffine, invertAffine, applyAffine,
  luminanceToAlpha, alphaBounds, cutoutPlacement, pickSamSegments, wiredImageAffine, wiredCutoutPlacement,
  unionSelectedMasks, pickClickMask,
  type Pt, type MaskCandidate, type WiredXform,
} from '~/lib/compositor/smartSelect'

describe('samplePointsFromStroke', () => {
  it('returns the single point for a click', () => {
    expect(samplePointsFromStroke([{ x: 10, y: 20 }])).toEqual([{ x: 10, y: 20 }])
  })
  it('spreads ≤ max points evenly along a long stroke', () => {
    const stroke: Pt[] = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 0 }))
    const pts = samplePointsFromStroke(stroke, { max: 8 })
    expect(pts.length).toBe(8)
    // Even arc-length coverage: first sample in the first eighth, last in the last eighth.
    expect(pts[0]!.x).toBeLessThan(200 / 8)
    expect(pts[7]!.x).toBeGreaterThan(200 - 200 / 8)
    // Strictly increasing (no bunching/backtracking on a monotone stroke).
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.x).toBeGreaterThan(pts[i - 1]!.x)
  })
  it('drops samples closer than minDist (tiny scribble → fewer points)', () => {
    const stroke: Pt[] = Array.from({ length: 50 }, (_, i) => ({ x: i * 0.1, y: 0 })) // 4.9px long
    const pts = samplePointsFromStroke(stroke, { max: 8, minDist: 6 })
    expect(pts.length).toBe(1)
  })
})

describe('affine (artboard ↔ image)', () => {
  // Layer centered at (0.5, 0.5) of a 1000×800 artboard, box 400×300 artboard px
  // (w,h width-normalized: 0.4, 0.3), rotated 30°, image capped at 1024×768.
  const layer = { x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 30 }
  const m = layerAffine(layer, 1000, 800, 1024, 768)
  it('maps the layer center to the image center', () => {
    const p = applyAffine(m, { x: 500, y: 400 })
    expect(p.x).toBeCloseTo(512, 6)
    expect(p.y).toBeCloseTo(384, 6)
  })
  it('round-trips through the inverse', () => {
    const inv = invertAffine(m)
    const q = applyAffine(inv, applyAffine(m, { x: 123, y: 456 }))
    expect(q.x).toBeCloseTo(123, 6)
    expect(q.y).toBeCloseTo(456, 6)
  })
  it('matches runRegionFill for the unrotated case: layer top-left corner → image (0,0)', () => {
    const m0 = layerAffine({ x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 0 }, 1000, 800, 1024, 768)
    const p = applyAffine(m0, { x: 500 - 200, y: 400 - 150 })
    expect(p.x).toBeCloseTo(0, 6)
    expect(p.y).toBeCloseTo(0, 6)
  })
})

describe('luminanceToAlpha', () => {
  it('white → opaque white, black → transparent, gray → partial', () => {
    //                     white          black        mid gray (opaque source alpha)
    const d = new Uint8ClampedArray([255,255,255,255,  0,0,0,255,  128,128,128,255])
    luminanceToAlpha(d)
    expect([d[0], d[1], d[2], d[3]]).toEqual([255, 255, 255, 255])
    expect(d[7]).toBe(0)
    expect(d[11]).toBeGreaterThan(100)
    expect(d[11]).toBeLessThan(160)
    // RGB forced white so the mask composites as a pure silhouette.
    expect([d[4], d[5], d[6]]).toEqual([255, 255, 255])
  })
})

describe('alphaBounds', () => {
  it('finds the tight bbox of alpha above threshold', () => {
    const w = 4, h = 3
    const d = new Uint8ClampedArray(w * h * 4)
    const set = (x: number, y: number, a: number) => { d[(y * w + x) * 4 + 3] = a }
    set(1, 0, 255); set(2, 2, 255); set(3, 1, 10) // 10 is below default thresh 20
    expect(alphaBounds(d, w, h)).toEqual({ minX: 1, minY: 0, maxX: 2, maxY: 2 })
  })
  it('returns null when empty', () => {
    expect(alphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull()
  })
})

describe('cutoutPlacement', () => {
  it('a full-image bbox reproduces the source layer transform', () => {
    const layer = { x: 0.3, y: 0.6, w: 0.4, h: 0.3, rotation: 25 }
    const p = cutoutPlacement({ minX: 0, minY: 0, maxX: 1023, maxY: 767 }, layer, 1024, 768, 1000, 800)
    expect(p.x).toBeCloseTo(0.3, 6)
    expect(p.y).toBeCloseTo(0.6, 6)
    expect(p.w).toBeCloseTo(0.4, 6)
    expect(p.h).toBeCloseTo(0.3, 6)
    expect(p.rotation).toBe(25)
  })
  it('an unrotated quarter crop lands at the right sub-position', () => {
    // Layer: center (500,400)px, box 400×300 artboard px. Crop = top-left quadrant
    // of the 1024×768 image → its center is at artboard (500-100, 400-75).
    const layer = { x: 0.5, y: 0.5, w: 0.4, h: 0.3, rotation: 0 }
    const p = cutoutPlacement({ minX: 0, minY: 0, maxX: 511, maxY: 383 }, layer, 1024, 768, 1000, 800)
    expect(p.x).toBeCloseTo(400 / 1000, 6)
    expect(p.y).toBeCloseTo(325 / 800, 6)
    expect(p.w).toBeCloseTo(0.2, 6)
    expect(p.h).toBeCloseTo(0.15, 6)
  })
})

describe('pickSamSegments', () => {
  /** Build a tiny opaque RGBA mask; `isWhite(x,y)` decides white vs black per pixel. */
  function mkMask(w: number, h: number, whitePixels: Array<[number, number]> | ((x: number, y: number) => boolean)): MaskCandidate {
    const data = new Uint8ClampedArray(w * h * 4)
    const isWhite = typeof whitePixels === 'function'
      ? whitePixels
      : (x: number, y: number) => whitePixels.some(([wx, wy]) => wx === x && wy === y)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const white = isWhite(x, y)
      data[o] = white ? 255 : 0
      data[o + 1] = white ? 255 : 0
      data[o + 2] = white ? 255 : 0
      data[o + 3] = 255
    }
    return { data, w, h }
  }

  // Probe trio: mask_0 = background (~84% white, with a black hole where the
  // object sits), mask_1 = the object (~16% white), mask_2 = a tiny subpart
  // inside the object (1 pixel).
  const w = 10, h = 10
  function probeTrio() {
    const object = mkMask(w, h, (x, y) => x >= 3 && x <= 6 && y >= 3 && y <= 6)
    const background = mkMask(w, h, (x, y) => !(x >= 3 && x <= 6 && y >= 3 && y <= 6))
    const subpart = mkMask(w, h, [[5, 5]])
    return [background, object, subpart]
  }

  it('assigns a fg point on the object body (outside the subpart) to the object segment', () => {
    const idxs = pickSamSegments(probeTrio(), [{ x: 3, y: 3 }], [], w, h)
    expect(idxs).toEqual([1])
  })

  it('a fg point landing inside the subpart too unions both (smallest wins per point)', () => {
    const idxs = pickSamSegments(probeTrio(), [{ x: 3, y: 3 }, { x: 5, y: 5 }], [], w, h)
    expect(idxs).toEqual([1, 2])
  })

  it('a stray fg point only the (oversized) background contains contributes nothing', () => {
    // (9,9) is white only in the background segment, which exceeds maxWhiteFrac
    // and is never assignable — the point is simply ignored.
    const idxs = pickSamSegments(probeTrio(), [{ x: 3, y: 3 }, { x: 9, y: 9 }], [], w, h)
    expect(idxs).toEqual([1])
  })

  it('a bg point removes the segment it claims from the fg-selected set', () => {
    const idxs = pickSamSegments(probeTrio(), [{ x: 3, y: 3 }], [{ x: 4, y: 4 }], w, h)
    expect(idxs).toEqual([])
  })

  it('unions two disjoint object segments hit by different fg points', () => {
    const segA = mkMask(w, h, (x, y) => x >= 0 && x <= 1 && y >= 0 && y <= 1)
    const segB = mkMask(w, h, (x, y) => x >= 8 && x <= 9 && y >= 8 && y <= 9)
    const idxs = pickSamSegments([segA, segB], [{ x: 0, y: 0 }, { x: 9, y: 9 }], [], w, h)
    expect(idxs).toEqual([0, 1])
  })

  it('returns [] for empty fgPoints', () => {
    const idxs = pickSamSegments(probeTrio(), [], [], w, h)
    expect(idxs).toEqual([])
  })

  it('maps points fractionally when a candidate has a different resolution than the prompt image', () => {
    // Prompt image is 10x10; point (5,5) is the exact center (fraction 0.5,0.5).
    // Candidate is 20x20 — the same fractional center is pixel (10,10).
    const cand = mkMask(20, 20, (x, y) => x >= 6 && x <= 14 && y >= 6 && y <= 14)
    const idxs = pickSamSegments([cand], [{ x: 5, y: 5 }], [], 10, 10)
    expect(idxs).toEqual([0])
  })
})

describe('wiredImageAffine', () => {
  // 1000×800 artboard, image 1600×1200 (iAspect 1.333 > cAspect 1.25 → fitW=1000, fitH=750),
  // centered (x=0,y=0), scale 1, no rotation, capped to 1024×768.
  const base = { x: 0, y: 0, scale: 1, rotation: 0 }
  it('maps the image center to the capped-image center', () => {
    const m = wiredImageAffine(base, 1000, 800, 1600, 1200, 1024, 768)
    const p = applyAffine(m, { x: 500, y: 400 }) // artboard center
    expect(p.x).toBeCloseTo(512, 4)
    expect(p.y).toBeCloseTo(384, 4)
  })
  it('maps the fit-box top-left corner to capped-image (0,0)', () => {
    const m = wiredImageAffine(base, 1000, 800, 1600, 1200, 1024, 768)
    // fitW=1000,fitH=750 centered → top-left at artboard (500-500, 400-375) = (0, 25)
    const p = applyAffine(m, { x: 0, y: 25 })
    expect(p.x).toBeCloseTo(0, 3)
    expect(p.y).toBeCloseTo(0, 3)
  })
  it('round-trips through the inverse', () => {
    const m = wiredImageAffine({ x: 0.1, y: -0.2, scale: 1.3, rotation: 22 }, 1000, 800, 1600, 1200, 1024, 768)
    const q = applyAffine(invertAffine(m), applyAffine(m, { x: 321, y: 234 }))
    expect(q.x).toBeCloseTo(321, 3)
    expect(q.y).toBeCloseTo(234, 3)
  })
  it('handles the tall-image fit branch (iAspect < cAspect)', () => {
    // image 600×1200 (iAspect .5 < 1.25) → fitH=800, fitW=400; centered.
    const m = wiredImageAffine(base, 1000, 800, 600, 1200, 512, 1024)
    const p = applyAffine(m, { x: 500, y: 400 })
    expect(p.x).toBeCloseTo(256, 4)
    expect(p.y).toBeCloseTo(512, 4)
  })
})

describe('wiredCutoutPlacement', () => {
  it('a full-image bbox reproduces the wired image\'s own placement', () => {
    // Same setup as wiredImageAffine's tests: 1000×800 artboard, image 1600×1200
    // (iAspect 1.333 > cAspect 1.25 → fitW=1000, fitH=750), capped 1024×768.
    const layer: WiredXform = { x: 0.1, y: -0.05, scale: 1.2, rotation: 15 }
    const p = wiredCutoutPlacement({ minX: 0, minY: 0, maxX: 1023, maxY: 767 }, layer, 1600, 1200, 1024, 768, 1000, 800)
    expect(p.x).toBeCloseTo(0.5 + layer.x, 6)
    expect(p.y).toBeCloseTo(0.5 + layer.y, 6)
    expect(p.w).toBeCloseTo(1000 * layer.scale / 1000, 6) // fitW=1000
    expect(p.h).toBeCloseTo(750 * layer.scale / 1000, 6)  // fitH=750
    expect(p.rotation).toBe(15)
  })
})

describe('unionSelectedMasks', () => {
  /** Opaque white-on-black mask; `whitePixels(x,y)` decides white per pixel. */
  function mkMask(w: number, h: number, whitePixels: (x: number, y: number) => boolean): MaskCandidate {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const v = whitePixels(x, y) ? 255 : 0
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255
    }
    return { data, w, h }
  }
  const white = (buf: Uint8ClampedArray, w: number, x: number, y: number) => buf[(y * w + x) * 4]! > 127

  it('unions selected segments as white and leaves the rest opaque black', () => {
    const segA = mkMask(4, 4, (x, y) => x <= 1 && y <= 1) // top-left quadrant
    const segB = mkMask(4, 4, (x, y) => x >= 2 && y >= 2) // bottom-right quadrant
    const buf = unionSelectedMasks([segA, segB], [0, 1], 4, 4)
    expect(white(buf, 4, 0, 0)).toBe(true)   // from segA
    expect(white(buf, 4, 3, 3)).toBe(true)   // from segB
    expect(white(buf, 4, 3, 0)).toBe(false)  // neither
    // Background stays opaque (max(RGB)→alpha consumers need alpha 255 black).
    for (let p = 0; p < 16; p++) expect(buf[p * 4 + 3]).toBe(255)
  })

  it('resamples a higher-res candidate down to the requested (w,h)', () => {
    // 20x20 candidate white in the central 6..14 block → at 10x10 output the
    // center is white, the corner is black.
    const cand = mkMask(20, 20, (x, y) => x >= 6 && x <= 14 && y >= 6 && y <= 14)
    const buf = unionSelectedMasks([cand], [0], 10, 10)
    expect(white(buf, 10, 5, 5)).toBe(true)
    expect(white(buf, 10, 0, 0)).toBe(false)
  })

  it('an empty selection produces an all-black opaque mask', () => {
    const seg = mkMask(4, 4, () => true)
    const buf = unionSelectedMasks([seg], [], 4, 4)
    for (let p = 0; p < 16; p++) { expect(buf[p * 4]).toBe(0); expect(buf[p * 4 + 3]).toBe(255) }
  })
})

describe('pickClickMask', () => {
  function mkMask(w: number, h: number, isWhite: (x: number, y: number) => boolean): MaskCandidate {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const v = isWhite(x, y) ? 255 : 0
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255
    }
    return { data, w, h }
  }
  const w = 10, h = 10
  const object = (x: number, y: number) => x >= 3 && x <= 6 && y >= 3 && y <= 6
  const trio = () => [mkMask(w, h, (x, y) => !object(x, y)), mkMask(w, h, object), mkMask(w, h, (x, y) => x === 5 && y === 5)]

  it('a click on the object body yields a white-on-black mask over that segment', () => {
    const buf = pickClickMask(trio(), { x: 3, y: 3 }, w, h)!
    expect(buf).not.toBeNull()
    expect(buf[(3 * w + 3) * 4]).toBe(255)         // inside object → white
    expect(buf[(3 * w + 3) * 4 + 3]).toBe(255)     // opaque
    expect(buf[(0 * w + 0) * 4]).toBe(0)           // background → black
  })

  it('returns null when only the oversized background segment contains the click', () => {
    // (9,9) is white only in the background segment (>maxWhiteFrac) → unassignable.
    expect(pickClickMask(trio(), { x: 9, y: 9 }, w, h)).toBeNull()
  })
})
