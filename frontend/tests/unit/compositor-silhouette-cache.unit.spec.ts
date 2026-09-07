import { describe, it, expect } from 'vitest'
import {
  silhouetteCacheKey, LruCache, SILHOUETTE_CACHE_CAP, SILHOUETTE_RASTER_PAD_PX,
  silhouettePadPx, silhouetteContentReady, silhouetteRasterFits, SILHOUETTE_RASTER_MAX_PX,
  silhouetteInkOverhangPx, SILHOUETTE_RASTER_MAX_DIM, SILHOUETTE_CACHE_MAX_BYTES,
  type SilhouetteInkInput,
} from '~/lib/compositor/silhouetteCache'
import { applyTornEdgeToData, DEFAULT_TORN_EDGE } from '~/lib/compositor/tornEdge'
import { applyFeatherToData, DEFAULT_FEATHER } from '~/lib/compositor/feather'

/** A brush-ish layer carrying every field the key is supposed to notice. */
const baseLayer = () => ({
  id: 'l1', kind: 'brush', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  w: 0.4, h: 0.3, fill: '#ff0000',
  strokes: [{ radius: 0.01, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }],
  effects: [{ type: 'grain', visible: true, amount: 0.2 }],
  tornEdge: { ...DEFAULT_TORN_EDGE },
  feather: { ...DEFAULT_FEATHER },
} as Record<string, unknown>)

const key = (l: Record<string, unknown>, s = 2, bw = 200, bh = 150, W = 1000) =>
  silhouetteCacheKey(l, s, bw, bh, W)

describe('silhouetteCacheKey', () => {
  it('ignores the fields that only move/fade the baked box', () => {
    const a = baseLayer()
    const b = {
      ...baseLayer(),
      id: 'l2', x: 0.9, y: 0.1, rotation: 37, opacity: 0.25, blend: 'multiply',
      skewX: 12, skewY: -4,
      cornerPin: { tl: { x: 0.1, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } },
      cloner: { mode: 'grid', count: 9 },
      name: 'renamed', visible: true, locked: true, groupId: 'g7',
    }
    expect(key(b)).toBe(key(a))
  })

  it('ignores property insertion order, including inside nested objects', () => {
    // A top-level-only key sort would still vary the key here: `tornEdge` is the
    // same object with its OWN keys in a different order.
    const a = {
      id: 'l1', kind: 'brush', w: 0.4, fill: '#ff0000',
      tornEdge: { amount: 5, seed: 2, roughness: 0.3, frequency: 4 },
    } as Record<string, unknown>
    const b = {
      fill: '#ff0000', w: 0.4, kind: 'brush', id: 'l1',
      tornEdge: { frequency: 4, roughness: 0.3, seed: 2, amount: 5 },
    } as Record<string, unknown>
    expect(key(b)).toBe(key(a))
  })

  it('changes when anything that changes the baked pixels changes', () => {
    const base = key(baseLayer())
    const differs = (mutate: (l: Record<string, unknown>) => void) => {
      const l = baseLayer(); mutate(l)
      return key(l) !== base
    }
    expect(differs(l => { (l.tornEdge as any).amount = 12 })).toBe(true)
    expect(differs(l => { l.feather = { ...DEFAULT_FEATHER, amount: 0.9 } })).toBe(true)
    expect(differs(l => { l.fill = '#00ff00' })).toBe(true)
    expect(differs(l => { (l.strokes as any[])[0].points.push({ x: 0.3, y: 0.3 }) })).toBe(true)
    expect(differs(l => { l.text = 'hello' })).toBe(true)
    expect(differs(l => { l.filename = 'photo.png' })).toBe(true)
    expect(differs(l => { (l.effects as any[])[0].amount = 0.9 })).toBe(true)
    expect(differs(l => { l.w = 0.41 })).toBe(true)
    expect(differs(l => { l.h = 0.31 })).toBe(true)
  })

  it('changes with the raster size, the device scale and the frame width', () => {
    const l = baseLayer()
    const base = key(l)
    expect(key(l, 1)).not.toBe(base)          // device scale
    expect(key(l, 2, 201)).not.toBe(base)     // raster width (device px)
    expect(key(l, 2, 200, 151)).not.toBe(base) // raster height
    expect(key(l, 2, 200, 150, 1200)).not.toBe(base) // logical frame width
  })
})

describe('LruCache', () => {
  it('returns undefined on a miss and the value on a hit', () => {
    const c = new LruCache<number>(2)
    expect(c.get('nope')).toBeUndefined()
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
  })

  it('evicts the least-recently-used past the cap, and get refreshes recency', () => {
    const c = new LruCache<number>(2)
    c.set('a', 1); c.set('b', 2)
    c.get('a')            // 'a' is now the most recent, so 'b' is next out
    c.set('c', 3)
    expect(c.size).toBe(2)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(1)
    expect(c.get('c')).toBe(3)
  })

  it('re-setting an existing key replaces it without growing', () => {
    const c = new LruCache<number>(2)
    c.set('a', 1); c.set('a', 9)
    expect(c.size).toBe(1)
    expect(c.get('a')).toBe(9)
  })

  it('clear empties it', () => {
    const c = new LruCache<number>(2)
    c.set('a', 1); c.clear()
    expect(c.size).toBe(0)
    expect(c.get('a')).toBeUndefined()
  })

  it('SILHOUETTE_CACHE_CAP is a small positive bound', () => {
    expect(SILHOUETTE_CACHE_CAP).toBeGreaterThan(0)
    expect(SILHOUETTE_CACHE_CAP).toBeLessThanOrEqual(64)
  })
})

// A count cap alone bounds nothing useful when the values are device-resolution
// canvases: 24 full-screen retina rasters is already hundreds of MB of GPU-backed
// memory in a module-global cache that never empties. The budget is on BYTES.
describe('LruCache byte budget', () => {
  /** Values are plain sizes so the pure cache never touches a canvas. */
  const sized = (maxBytes: number, cap = 100) =>
    new LruCache<number>(cap, { sizeOf: v => v, maxBytes })

  it('tracks the total size of what it holds', () => {
    const c = sized(1000)
    c.set('a', 100); c.set('b', 250)
    expect(c.bytes).toBe(350)
  })

  it('evicts least-recently-used until the byte budget holds', () => {
    const c = sized(300)
    c.set('a', 100); c.set('b', 100); c.set('c', 100)
    expect(c.size).toBe(3)
    c.set('d', 100)                    // 400 > 300 ⇒ 'a' goes
    expect(c.get('a')).toBeUndefined()
    expect(c.bytes).toBeLessThanOrEqual(300)
    expect(c.size).toBe(3)
  })

  it('evicts as many as it takes for one big entry', () => {
    const c = sized(300)
    c.set('a', 100); c.set('b', 100); c.set('c', 100)
    c.set('big', 280)
    expect(c.bytes).toBeLessThanOrEqual(300)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBeUndefined()
    expect(c.get('big')).toBe(280)
  })

  it('get still refreshes recency under the byte budget', () => {
    const c = sized(300)
    c.set('a', 100); c.set('b', 100); c.set('c', 100)
    c.get('a')                         // 'a' most recent ⇒ 'b' is next out
    c.set('d', 100)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(100)
  })

  it('replacing a key re-accounts its bytes instead of double-counting', () => {
    const c = sized(1000)
    c.set('a', 100); c.set('a', 400)
    expect(c.size).toBe(1)
    expect(c.bytes).toBe(400)
  })

  it('a delete-by-eviction gives the bytes back', () => {
    const c = sized(1000, 1)
    c.set('a', 100); c.set('b', 250)
    expect(c.size).toBe(1)
    expect(c.bytes).toBe(250)
  })

  it('clear zeroes the byte total too', () => {
    const c = sized(1000)
    c.set('a', 100); c.clear()
    expect(c.bytes).toBe(0)
  })

  it('the count cap is still enforced independently of the budget', () => {
    const c = sized(1_000_000, 2)
    c.set('a', 1); c.set('b', 1); c.set('c', 1)
    expect(c.size).toBe(2)
    expect(c.get('a')).toBeUndefined()
  })

  it('a lone entry over budget is kept rather than evicting into a guaranteed miss', () => {
    const c = sized(100)
    c.set('huge', 5000)
    expect(c.get('huge')).toBe(5000)
  })

  it('with no sizeOf the cache behaves exactly as before (count cap only)', () => {
    const c = new LruCache<number>(2)
    c.set('a', 1); c.set('b', 2); c.set('c', 3)
    expect(c.size).toBe(2)
    expect(c.bytes).toBe(0)
  })

  it('SILHOUETTE_CACHE_MAX_BYTES is a sane ceiling for device-res rasters', () => {
    expect(SILHOUETTE_CACHE_MAX_BYTES).toBe(192 * 1024 * 1024)
    // Big enough that a single legal raster (the area cap, 4 bytes/px) always fits.
    expect(SILHOUETTE_CACHE_MAX_BYTES).toBeGreaterThan(SILHOUETTE_RASTER_MAX_PX * 4)
  })
})

// Why the baked raster is padded: both silhouette effects measure each opaque
// pixel's distance to the nearest TRANSPARENT one. A layer's own box is tight
// around its ink (a rect fills it exactly; strokeBounds hugs a brush), so with no
// margin there is no transparent pixel to measure from and the effect no-ops.
describe('SILHOUETTE_RASTER_PAD_PX', () => {
  const fill = (W: number, H: number, x0: number, y0: number, x1: number, y1: number) => {
    const d = new Uint8ClampedArray(W * H * 4)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4
      d[o] = 200; d[o + 1] = 120; d[o + 2] = 60; d[o + 3] = 255
    }
    return d
  }
  const alphas = (d: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) n++; return n }

  it('leaves at least one transparent pixel around the content', () => {
    expect(SILHOUETTE_RASTER_PAD_PX).toBeGreaterThanOrEqual(1)
  })

  it('torn edge cannot tear content that runs to the raster edge, but can with a margin', () => {
    const flush = fill(40, 40, 0, 0, 40, 40)
    applyTornEdgeToData(flush, 40, 40, { ...DEFAULT_TORN_EDGE }, 1)
    expect(alphas(flush)).toBe(0)             // nothing to tear from — silently untorn

    const P = SILHOUETTE_RASTER_PAD_PX
    const padded = fill(40 + P * 2, 40 + P * 2, P, P, P + 40, P + 40)
    applyTornEdgeToData(padded, 40 + P * 2, 40 + P * 2, { ...DEFAULT_TORN_EDGE }, 1)
    expect(alphas(padded)).toBeGreaterThan(0) // the margin gives the tear an edge
  })

  it('feather likewise needs the margin', () => {
    const flush = fill(40, 40, 0, 0, 40, 40)
    applyFeatherToData(flush, 40, 40, { ...DEFAULT_FEATHER })
    expect(alphas(flush)).toBe(0)

    const P = SILHOUETTE_RASTER_PAD_PX
    const padded = fill(40 + P * 2, 40 + P * 2, P, P, P + 40, P + 40)
    applyFeatherToData(padded, 40 + P * 2, 40 + P * 2, { ...DEFAULT_FEATHER })
    expect(alphas(padded)).toBeGreaterThan(0)
  })
})

/** An ink-overhang input with everything off; spread the interesting fields over it. */
const ink = (o: Partial<SilhouetteInkInput> = {}): SilhouetteInkInput => ({
  kind: 'rect', strokeAlign: 'center', strokePx: 0, fontPx: 0, boxHPx: 0, boxHeightPx: 0,
  maxLineWPx: 0, boxWidthPx: 0, ...o,
})

// The finding this covers: the raster used to be padded by `outsideStrokePadPx`,
// which is 0 for anything but an OUTSIDE-aligned stroke — while the DEFAULT
// alignment is 'center', whose ink reaches half the stroke width past the box. So
// every default-aligned stroke wider than a couple of px had its outer half clipped
// out of the cached raster, in preview AND export.
describe('silhouetteInkOverhangPx', () => {
  it('a centre-aligned shape stroke overhangs by HALF its width', () => {
    expect(silhouetteInkOverhangPx(ink({ strokeAlign: 'center', strokePx: 20 }))).toBe(10)
  })

  it('an outside-aligned shape stroke overhangs by the FULL width', () => {
    expect(silhouetteInkOverhangPx(ink({ strokeAlign: 'outside', strokePx: 20 }))).toBe(20)
  })

  it('an inside-aligned shape stroke does not overhang at all', () => {
    expect(silhouetteInkOverhangPx(ink({ strokeAlign: 'inside', strokePx: 20 }))).toBe(0)
  })

  // drawLayerContent strokes a line with lineCap 'round', so the cap bulges half a
  // stroke width past each endpoint — and localLayerBox gives a line only `w * W`.
  it('a line overhangs by half its width for the round caps, whatever the alignment', () => {
    for (const a of ['inside', 'center', 'outside'] as const) {
      expect(silhouetteInkOverhangPx(ink({ kind: 'line', strokeAlign: a, strokePx: 20 }))).toBe(10)
    }
  })

  it('text gets a full em of font size plus the stroke width', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', fontPx: 40, strokePx: 6 }))).toBe(46)
  })

  // drawText places its lines anywhere within ±boxH/2 under `valign`, while
  // localLayerBox reports only `lines × lineHeight` — so a short block in a tall
  // height box sits far outside the measured box.
  it('text in a tall height box pads by at least half the slack over the line block', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', boxHPx: 400, boxHeightPx: 80 })))
      .toBeGreaterThanOrEqual(160)
  })

  it('a height box no taller than the line block adds nothing', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', boxHPx: 40, boxHeightPx: 200 }))).toBe(0)
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', boxHPx: 0, boxHeightPx: 200 }))).toBe(0)
  })

  it('a kind that draws no stroke overhangs by nothing', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'brush' }))).toBe(0)
    expect(silhouetteInkOverhangPx(ink({ kind: 'image' }))).toBe(0)
  })

  it('non-finite inputs count as zero rather than propagating NaN', () => {
    expect(silhouetteInkOverhangPx(ink({ strokePx: NaN }))).toBe(0)
    expect(silhouetteInkOverhangPx(ink({ strokeAlign: 'outside', strokePx: Infinity }))).toBe(0)
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', fontPx: NaN, strokePx: 6 }))).toBe(6)
    expect(Number.isFinite(silhouetteInkOverhangPx(ink({ kind: 'text', fontPx: NaN, strokePx: NaN, boxHPx: NaN, boxHeightPx: NaN })))).toBe(true)
  })

  // wrappedTextLines only breaks on whitespace, so a single word (or URL) wider than
  // boxW is emitted as one over-long line; localLayerBox's text-with-boxW branch
  // reports `w = boxW * W` regardless, so a cached raster sized off that box alone
  // hard-clips the word. Pad it out by half the overflow, same shape as the
  // centre-aligned stroke case above (the line straddles the box on both sides).
  it('a line wider than the box overhangs by half the overflow', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: 300, boxWidthPx: 100 }))).toBe(100)
  })

  it('a line no wider than the box adds nothing for line overflow', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: 50, boxWidthPx: 100 }))).toBe(0)
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: 100, boxWidthPx: 100 }))).toBe(0)
  })

  it('non-finite line-width inputs count as zero rather than propagating NaN', () => {
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: NaN, boxWidthPx: 100 }))).toBe(0)
    expect(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: Infinity, boxWidthPx: 100 }))).toBe(0)
    expect(Number.isFinite(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: 300, boxWidthPx: NaN })))).toBe(true)
    expect(Number.isFinite(silhouetteInkOverhangPx(ink({ kind: 'text', maxLineWPx: NaN, boxWidthPx: NaN })))).toBe(true)
  })
})

describe('silhouettePadPx', () => {
  it('an unstroked shape gets only the raster margin', () => {
    expect(silhouettePadPx(ink(), 1)).toBe(SILHOUETTE_RASTER_PAD_PX)
    expect(silhouettePadPx(ink({ kind: 'brush' }), 1)).toBe(SILHOUETTE_RASTER_PAD_PX)
  })

  it('the total pad is the raster margin plus the ink overhang', () => {
    const i = ink({ kind: 'text', fontPx: 40, strokePx: 6, boxHPx: 400, boxHeightPx: 80 })
    expect(silhouettePadPx(i, 1)).toBe(SILHOUETTE_RASTER_PAD_PX + silhouetteInkOverhangPx(i))
  })

  it('a DEFAULT centre-aligned stroke is padded by half its width', () => {
    expect(silhouettePadPx(ink({ strokePx: 20 }), 1)).toBe(SILHOUETTE_RASTER_PAD_PX + 10)
  })

  it('text with a 400px height box over an 80px line block gets >= 160px of extra pad', () => {
    const plain = silhouettePadPx(ink({ kind: 'text', fontPx: 40, boxHeightPx: 80 }), 1)
    const boxed = silhouettePadPx(ink({ kind: 'text', fontPx: 40, boxHPx: 400, boxHeightPx: 80 }), 1)
    expect(boxed - plain).toBeGreaterThanOrEqual(160)
  })

  it('at device scale 0.5 the raster margin doubles in logical px', () => {
    expect(silhouettePadPx(ink(), 1)).toBe(SILHOUETTE_RASTER_PAD_PX)
    expect(silhouettePadPx(ink(), 0.5)).toBe(SILHOUETTE_RASTER_PAD_PX * 2)
  })

  it('at device scale 2 the raster margin does not shrink below the base', () => {
    expect(silhouettePadPx(ink(), 2)).toBe(SILHOUETTE_RASTER_PAD_PX)
  })

  it('non-finite font/stroke inputs do not propagate as NaN', () => {
    expect(silhouettePadPx(ink({ kind: 'text', fontPx: NaN, strokePx: NaN }), 1)).toBe(SILHOUETTE_RASTER_PAD_PX)
    expect(silhouettePadPx(ink({ kind: 'text', fontPx: Infinity, strokePx: 6 }), 1)).toBe(SILHOUETTE_RASTER_PAD_PX + 6)
    expect(Number.isFinite(silhouettePadPx(ink({ kind: 'text', fontPx: NaN, strokePx: NaN }), 1))).toBe(true)
  })
})

describe('silhouetteContentReady', () => {
  it('is true when font, image and fill bitmaps are all ready', () => {
    expect(silhouetteContentReady('text', { font: true, image: true, fillBitmaps: true })).toBe(true)
  })

  it('is false for a text layer whose real font has not loaded', () => {
    expect(silhouetteContentReady('text', { font: false, image: true, fillBitmaps: true })).toBe(false)
  })

  it('is false for an image layer whose bitmap has not decoded', () => {
    expect(silhouetteContentReady('image', { font: false || true, image: false, fillBitmaps: true })).toBe(false)
  })

  it('is false whenever a fill bitmap is missing, regardless of kind', () => {
    expect(silhouetteContentReady('rect', { font: true, image: true, fillBitmaps: false })).toBe(false)
  })

  it('ignores font readiness for a non-text kind', () => {
    expect(silhouetteContentReady('rect', { font: false, image: true, fillBitmaps: true })).toBe(true)
  })

  it('ignores image readiness for a non-image kind', () => {
    expect(silhouetteContentReady('text', { font: true, image: false, fillBitmaps: true })).toBe(true)
  })
})

describe('silhouetteRasterFits', () => {
  it('accepts a raster within the cap', () => {
    expect(silhouetteRasterFits(1000, 1000)).toBe(true) // 1,000,000 px
  })

  it('rejects a raster past SILHOUETTE_RASTER_MAX_PX', () => {
    expect(silhouetteRasterFits(5000, 5000)).toBe(false) // 25,000,000 px
    expect(SILHOUETTE_RASTER_MAX_PX).toBe(16_000_000)
  })

  it('rejects non-finite dimensions', () => {
    expect(silhouetteRasterFits(NaN, 100)).toBe(false)
    expect(silhouetteRasterFits(100, Infinity)).toBe(false)
  })

  it('rejects dimensions below 1px', () => {
    expect(silhouetteRasterFits(0, 100)).toBe(false)
    expect(silhouetteRasterFits(100, 0.5)).toBe(false)
    expect(silhouetteRasterFits(-5, 100)).toBe(false)
  })

  // The area cap alone lets a long thin raster through: 32768 x 480 is 15.7 Mpx,
  // under the area ceiling, but past every engine's per-DIMENSION limit — the
  // canvas comes back blank and the cache would store that emptiness for a layer
  // that then simply vanishes.
  it('rejects a raster past the per-dimension cap even when its area fits', () => {
    expect(32_768 * 480).toBeLessThan(SILHOUETTE_RASTER_MAX_PX)  // area is fine
    expect(silhouetteRasterFits(32_768, 480)).toBe(false)        // the width is not
    expect(silhouetteRasterFits(480, 32_768)).toBe(false)
    expect(SILHOUETTE_RASTER_MAX_DIM).toBe(16_384)
  })

  it('accepts a raster exactly at the dimension cap whose area still fits', () => {
    expect(silhouetteRasterFits(SILHOUETTE_RASTER_MAX_DIM, 500)).toBe(true)
    expect(silhouetteRasterFits(SILHOUETTE_RASTER_MAX_DIM + 1, 500)).toBe(false)
  })
})

describe('silhouette cache key covers stack order', () => {
  it('two stacks differing only in order produce different keys', () => {
    const a = { effects: [{ id: 'a', type: 'torn_edge', visible: true }, { id: 'b', type: 'feather', visible: true }] }
    const b = { effects: [{ id: 'b', type: 'feather', visible: true }, { id: 'a', type: 'torn_edge', visible: true }] }
    expect(silhouetteCacheKey(a, 2, 100, 100, 1000)).not.toBe(silhouetteCacheKey(b, 2, 100, 100, 1000))
  })
})
