import { describe, it, expect } from 'vitest'
import {
  silhouetteCacheKey, LruCache, SILHOUETTE_CACHE_CAP, SILHOUETTE_RASTER_PAD_PX,
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

  it('ignores property insertion order', () => {
    const a = { id: 'l1', kind: 'brush', w: 0.4, fill: '#ff0000' } as Record<string, unknown>
    const b = { fill: '#ff0000', w: 0.4, kind: 'brush', id: 'l1' } as Record<string, unknown>
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
