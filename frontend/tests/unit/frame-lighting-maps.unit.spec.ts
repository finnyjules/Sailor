import { describe, it, expect, beforeEach } from 'vitest'
import {
  stampLightingMaps, cachedLightingMaps, LIFT_SCALE, MAP_MAX_EDGE, lightingMapSize, __lightingMapStamps, bumpLightingMapEpoch,
  layerSig, releaseLightingMaps,
  type LightingStamp,
} from '~/lib/frame/lighting/maps'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { newLightLayer } from '~/lib/frame/lighting/settings'

/**
 * A tiny raster standing in for a 2D canvas: each pixel is [red `v`, green `g`, blue `b` 0..255,
 * alpha 0..1], premultiplication ignored where it doesn't matter. Supports exactly the ops the map stamper
 * uses: fillRect (through a scale+translate transform), clearRect, drawImage(canvas, 0, 0) and
 * the composite ops source-over / source-in / lighter.
 */
class FakeCanvas {
  px: { v: number; g: number; b: number; a: number }[]
  ctx: FakeCtx
  constructor(public width: number, public height: number) {
    this.px = Array.from({ length: width * height }, () => ({ v: 0, g: 0, b: 0, a: 0 }))
    this.ctx = new FakeCtx(this)
  }
  getContext() { return this.ctx }
  at(x: number, y = 0) { return this.px[y * this.width + x]! }
}
type RGB = [number, number, number]
const rgbOf = (s: string): RGB => {
  const m = /^rgb\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)$/.exec(s)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  if (s === '#fff' || s === '#ffffff' || s === 'white') return [255, 255, 255]
  if (s === '#000' || s === '#000000' || s === 'black') return [0, 0, 0]
  throw new Error('fake canvas: unknown fillStyle ' + s)
}
class FakeCtx {
  globalCompositeOperation = 'source-over'
  globalAlpha = 1
  fillStyle = '#000'
  private t = { a: 1, d: 1, e: 0, f: 0 }
  private stack: { a: number; d: number; e: number; f: number }[] = []
  constructor(public canvas: FakeCanvas) {}
  save() { this.stack.push({ ...this.t }) }
  restore() { this.t = this.stack.pop() ?? this.t }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) { this.t = { a, d, e, f } }
  getTransform() { return { ...this.t, b: 0, c: 0 } }
  private blend(i: number, c: RGB, a: number) {
    const p = this.canvas.px[i]!
    const op = this.globalCompositeOperation
    const keys = ['v', 'g', 'b'] as const
    if (op === 'source-in') { keys.forEach((k, j) => { p[k] = c[j]! }); p.a = p.a * a; return }
    if (op === 'lighter') { keys.forEach((k, j) => { p[k] = Math.min(255, p[k] * p.a + c[j]! * a) }); p.a = Math.min(1, p.a + a); return }
    const outA = a + p.a * (1 - a)
    keys.forEach((k, j) => { p[k] = outA > 0 ? (c[j]! * a + p[k] * p.a * (1 - a)) / outA : 0 })
    p.a = outA
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const v = rgbOf(String(this.fillStyle))
    const x0 = Math.round(x * this.t.a + this.t.e), x1 = Math.round((x + w) * this.t.a + this.t.e)
    const y0 = Math.round(y * this.t.d + this.t.f), y1 = Math.round((y + h) * this.t.d + this.t.f)
    const all = this.globalCompositeOperation === 'source-in'
    for (let yy = 0; yy < this.canvas.height; yy++) for (let xx = 0; xx < this.canvas.width; xx++) {
      const inside = xx >= x0 && xx < x1 && yy >= y0 && yy < y1
      if (inside) this.blend(yy * this.canvas.width + xx, v, this.globalAlpha)
      else if (all) this.canvas.px[yy * this.canvas.width + xx]!.a = 0
    }
  }
  clearRect() { for (const p of this.canvas.px) { p.v = 0; p.g = 0; p.b = 0; p.a = 0 } }
  drawImage(src: FakeCanvas) {
    src.px.forEach((p, i) => { if (p.a > 0 || this.globalCompositeOperation === 'source-in') this.blend(i, [p.v, p.g, p.b], p.a) })
  }
}
const makeCanvas = (w: number, h: number) => new FakeCanvas(w, h) as unknown as HTMLCanvasElement
const raster = (c: HTMLCanvasElement) => c as unknown as FakeCanvas

// A 4×1 Frame. Each test layer is a rect covering columns [x0, x1).
const W = 4, H = 1
function rectLayer(id: string, patch: Record<string, unknown> = {}): LocalLayer {
  return { id, kind: 'rect', x: 0.5, y: 0.5, w: 1, h: 0.25, rotation: 0, opacity: 1, ...patch } as unknown as LocalLayer
}
function stamp(layer: LocalLayer | null, x0: number, x1: number): LightingStamp {
  return {
    layer,
    sig: layer ? `${layer.id}:${x0}-${x1}:${JSON.stringify(layer)}` : null,
    draw: (t) => { t.fillStyle = 'rgb(90,90,90)'; t.fillRect(x0, 0, x1 - x0, 1) },
  }
}
const opts = { backgroundLit: true, makeCanvas }

beforeEach(() => bumpLightingMapEpoch())

describe('stampLightingMaps — lit', () => {
  it('starts from the background switch: white when lit, black when not', () => {
    const lit = stampLightingMaps([], W, H, W, H, opts)!.lit
    expect(raster(lit).at(0).v).toBe(255)
    const dark = stampLightingMaps([], W, H, W, H, { ...opts, backgroundLit: false })!.lit
    expect(raster(dark).at(0).v).toBe(0)
  })

  it('stamps in stack order: an unlit top layer clears the lit map under it, a lit one above restores it', () => {
    const under = rectLayer('a')
    const unlit = rectLayer('b', { lit: false })
    const top = rectLayer('c')
    const m = stampLightingMaps([stamp(under, 0, 4), stamp(unlit, 1, 3), stamp(top, 2, 3)], W, H, W, H, opts)!
    const r = raster(m.lit)
    expect(r.at(0).v).toBe(255)
    expect(r.at(1).v).toBe(0)     // unlit layer on top
    expect(r.at(2).v).toBe(255)   // lit layer above the unlit one
    expect(r.at(3).v).toBe(255)
  })

  it('a lit layer over an unlit background is lit', () => {
    const m = stampLightingMaps([stamp(rectLayer('a'), 0, 2)], W, H, W, H, { ...opts, backgroundLit: false })!
    expect(raster(m.lit).at(0).v).toBe(255)
    expect(raster(m.lit).at(3).v).toBe(0)
  })
})

describe('stampLightingMaps — lift', () => {
  it('starts black; stacked casting layers add their lifts', () => {
    const a = rectLayer('a', { lift: 0.04 })
    const b = rectLayer('b', { lift: 0.06 })
    const m = stampLightingMaps([stamp(a, 0, 3), stamp(b, 1, 2)], W, H, W, H, opts)!
    const r = raster(m.lift)
    const g = (lift: number) => Math.round(lift / LIFT_SCALE * 255)
    expect(r.at(3).v).toBe(0)
    expect(r.at(0).v).toBeCloseTo(g(0.04), 0)
    expect(r.at(1).v).toBeCloseTo(g(0.04) + g(0.06), 0)
  })

  it('a layer that does not cast adds no lift', () => {
    const m = stampLightingMaps([stamp(rectLayer('a', { castsShadow: false }), 0, 4)], W, H, W, H, opts)!
    expect(raster(m.lift).at(0).v).toBe(0)
  })

  it('images and wired items do not cast by default', () => {
    const img = { ...rectLayer('i'), kind: 'image' } as unknown as LocalLayer
    const m = stampLightingMaps([stamp(img, 0, 4), stamp(null, 0, 4)], W, H, W, H, opts)!
    expect(raster(m.lift).at(0).v).toBe(0)
  })
})

describe('stampLightingMaps — what stamps nothing', () => {
  it('hidden layers and light layers stamp nothing', () => {
    let drawn = 0
    const counted = (l: LocalLayer): LightingStamp => ({ ...stamp(l, 0, 4), draw: (t) => { drawn++; stamp(l, 0, 4).draw(t) } })
    const hidden = rectLayer('h', { visible: false, lit: false })
    const light = newLightLayer('lamp') as unknown as LocalLayer
    const m = stampLightingMaps([counted(hidden), counted(light)], W, H, W, H, opts)!
    expect(drawn).toBe(0)
    expect(raster(m.lit).at(0).v).toBe(255)
    expect(raster(m.lift).at(0).v).toBe(0)
  })
})

describe('map size and cache', () => {
  it('device-sized, long edge capped at 1024', () => {
    expect(MAP_MAX_EDGE).toBe(1024)
    expect(lightingMapSize(800, 600)).toEqual({ w: 800, h: 600 })
    expect(lightingMapSize(1080, 1350)).toEqual({ w: Math.round(1080 * 1024 / 1350), h: 1024 })
    expect(lightingMapSize(2160, 2700)).toEqual({ w: Math.round(2160 * 1024 / 2700), h: 1024 })
  })

  it('maxLift: 0 when nothing casts, else the stacked lifts (plus rounding), capped at LIFT_SCALE', () => {
    expect(stampLightingMaps([stamp(rectLayer('a', { castsShadow: false }), 0, 4)], W, H, W, H, opts)!.maxLift).toBe(0)
    const m = stampLightingMaps([stamp(rectLayer('a', { lift: 0.04 }), 0, 3), stamp(rectLayer('b', { lift: 0.06 }), 1, 2)], W, H, W, H, opts)!
    expect(m.maxLift).toBeGreaterThanOrEqual(0.1)
    expect(m.maxLift).toBeLessThan(0.1 + 3 * LIFT_SCALE / 255)
    const big = Array.from({ length: 5 }, (_, i) => stamp(rectLayer('x' + i, { lift: 0.15 }), 0, 4))
    expect(stampLightingMaps(big, W, H, W, H, opts)!.maxLift).toBe(LIFT_SCALE)
  })

  it('no per-paint allocations: one scratch canvas, one uncached pair, reused', () => {
    let made = 0
    const counting = (w: number, h: number) => { made++; return makeCanvas(w, h) }
    const o = { backgroundLit: true, makeCanvas: counting }
    const unc = { ...stamp(rectLayer('a', { lit: false }), 0, 2), sig: null }
    const m1 = cachedLightingMaps([unc], W, H, W, H, o)!
    const afterFirst = made
    const m2 = cachedLightingMaps([unc], W, H, W, H, o)!
    const m3 = cachedLightingMaps([unc], W, H, W, H, o)!
    expect(made).toBe(afterFirst)           // no canvas made after the first paint
    expect(m2.lit).toBe(m1.lit)
    expect(m3.lift).toBe(m1.lift)
    expect(m3.version).toBeGreaterThan(m2.version) // re-stamped in place ⇒ re-uploaded
  })

  it('keeps the maps when only the lights change; re-stamps when a layer changes', () => {
    const a = rectLayer('a')
    const n0 = __lightingMapStamps()
    const m1 = cachedLightingMaps([stamp(a, 0, 2)], W, H, W, H, opts)
    const m2 = cachedLightingMaps([stamp(a, 0, 2)], W, H, W, H, opts)
    expect(m2).toBe(m1)
    expect(__lightingMapStamps() - n0).toBe(1)
    const m3 = cachedLightingMaps([stamp({ ...a, x: 0.4 } as LocalLayer, 0, 2)], W, H, W, H, opts)
    expect(m3).not.toBe(m1)
    expect(__lightingMapStamps() - n0).toBe(2)
    // The background switch and the size are part of the key too.
    cachedLightingMaps([stamp(a, 0, 2)], W, H, W, H, { ...opts, backgroundLit: false })
    expect(__lightingMapStamps() - n0).toBe(3)
  })

  it('a stamp with no signature is never served from the cache', () => {
    const s = { ...stamp(rectLayer('a', { lit: false }), 0, 2), sig: null }
    const n0 = __lightingMapStamps()
    cachedLightingMaps([s], W, H, W, H, opts)
    cachedLightingMaps([s], W, H, W, H, opts)
    expect(__lightingMapStamps() - n0).toBe(2)
  })

  it('a lit, non-casting stamp over an all-lit map is skipped (and leaves the key alone)', () => {
    let drawn = 0
    const wired: LightingStamp = { layer: null, sig: null, draw: () => { drawn++ } }
    const n0 = __lightingMapStamps()
    cachedLightingMaps([wired], W, H, W, H, opts)
    cachedLightingMaps([wired], W, H, W, H, opts)
    expect(drawn).toBe(0)
    expect(__lightingMapStamps() - n0).toBe(1)
  })

  it('layerSig is a short memoised hash, not the layer\'s JSON; a changed layer hashes differently', () => {
    const a = { ...rectLayer('a'), text: 'x'.repeat(5000) } as unknown as LocalLayer
    const s1 = layerSig(a)
    expect(s1.length).toBeLessThan(40)
    expect(layerSig(a)).toBe(s1)
    expect(layerSig({ ...a } as LocalLayer)).toBe(s1)               // same content, same hash
    expect(layerSig({ ...a, x: 0.41 } as LocalLayer)).not.toBe(s1)
  })

  it('releaseLightingMaps drops every cached map: the next paint re-stamps', () => {
    const a = rectLayer('a')
    const m1 = cachedLightingMaps([stamp(a, 0, 2)], W, H, W, H, opts)
    releaseLightingMaps()
    const n0 = __lightingMapStamps()
    const m2 = cachedLightingMaps([stamp(a, 0, 2)], W, H, W, H, opts)
    expect(m2).not.toBe(m1)
    expect(__lightingMapStamps() - n0).toBe(1)
  })
})

// ── Stage 2: the facing map and shine ───────────────────────────────────────────────────────

/** A Relight photo's stamp: silhouette over [x0, x1), and a facing tile there in `rgb`. */
function photoStamp(layer: LocalLayer, x0: number, x1: number, rgb: RGB, shine: number, sig = 'tile1'): LightingStamp {
  const tile = new FakeCanvas(W, H)
  for (let x = x0; x < x1; x++) Object.assign(tile.at(x), { v: rgb[0], g: rgb[1], b: rgb[2], a: 1 })
  const base = stamp(layer, x0, x1)
  return { ...base, sig: `${base.sig}|f${sig}|${shine}`, facing: { shine, draw: t => (t as unknown as FakeCtx).drawImage(tile) } }
}
const img = (id: string, patch: Record<string, unknown> = {}) => ({ ...rectLayer(id), kind: 'image', ...patch } as unknown as LocalLayer)

describe('stampLightingMaps — facing (stage 2)', () => {
  it('no Relight photo ⇒ no facing map, and the lit map is stage 1\'s grey, byte for byte', () => {
    const m = stampLightingMaps([stamp(rectLayer('a', { lit: false }), 1, 3)], W, H, W, H, opts)!
    expect(m.facing).toBeNull()
    expect(raster(m.lit).px.map(p => [p.v, p.g, p.b])).toEqual([[255, 255, 255], [0, 0, 0], [0, 0, 0], [255, 255, 255]])
  })

  it('a Relight photo makes the facing map: flat outside it, its tile inside; shine in the lit map\'s G', () => {
    const m = stampLightingMaps([photoStamp(img('p'), 1, 3, [60, 200, 140], 0.5)], W, H, W, H, opts)!
    const f = raster(m.facing!)
    expect([f.at(0).v, f.at(0).g, f.at(0).b]).toEqual([128, 128, 255])
    expect([f.at(1).v, f.at(1).g, f.at(1).b]).toEqual([60, 200, 140])
    expect([f.at(2).v, f.at(2).g, f.at(2).b]).toEqual([60, 200, 140])
    expect([f.at(3).v, f.at(3).g, f.at(3).b]).toEqual([128, 128, 255])
    const l = raster(m.lit)
    expect([l.at(0).v, l.at(0).g]).toEqual([255, 0])        // background: lit, no shine
    expect([l.at(1).v, l.at(1).g]).toEqual([255, 128])      // the photo: lit, shine 0.5
  })

  it('a layer above the photo faces the viewer again and has no shine', () => {
    const m = stampLightingMaps([photoStamp(img('p'), 0, 4, [60, 200, 140], 1), stamp(rectLayer('t'), 2, 3)], W, H, W, H, opts)!
    const f = raster(m.facing!)
    expect([f.at(1).v, f.at(1).g, f.at(1).b]).toEqual([60, 200, 140])
    expect([f.at(2).v, f.at(2).g, f.at(2).b]).toEqual([128, 128, 255])
    expect(raster(m.lit).at(1).g).toBe(255)
    expect(raster(m.lit).at(2).g).toBe(0)
  })

  it('a hidden photo makes no facing map', () => {
    const m = stampLightingMaps([photoStamp(img('p', { visible: false }), 0, 4, [60, 200, 140], 1)], W, H, W, H, opts)!
    expect(m.facing).toBeNull()
  })

  it('cached: the same tile serves the cache; a new tile signature (dials, field landing) re-stamps', () => {
    const p = img('p')
    const n0 = __lightingMapStamps()
    const m1 = cachedLightingMaps([photoStamp(p, 1, 3, [60, 200, 140], 0.5, 'a')], W, H, W, H, opts)
    const m2 = cachedLightingMaps([photoStamp(p, 1, 3, [60, 200, 140], 0.5, 'a')], W, H, W, H, opts)
    expect(m2).toBe(m1)
    expect(m1!.facing).not.toBeNull()
    const m3 = cachedLightingMaps([photoStamp(p, 1, 3, [70, 200, 140], 0.5, 'b')], W, H, W, H, opts)
    expect(m3).not.toBe(m1)
    expect(raster(m3!.facing!).at(1).v).toBe(70)
    expect(__lightingMapStamps() - n0).toBe(2)
    // Back to a Frame without a photo: no facing map.
    expect(cachedLightingMaps([stamp(rectLayer('a', { lit: false }), 0, 1)], W, H, W, H, opts)!.facing).toBeNull()
  })
})
