/**
 * Carve — the playgrnd "Carve" generator as the `carve` Mosaic style. Every test
 * below restates one RULE of the source (see the checklist in lib/compositor/carve).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CARVE_KINDS, CARVE_LIMITS, CARVE_PALETTE_PRESETS, CARVE_PRESET_NAMES,
  defaultCarve, normalizeCarve, carvePresetPatch, carvePresetOf,
  carveSplit, carveTreatments, carveLayout, carveGrainPixels, paintCarve,
  type CarveParams, type CarveCtx,
} from '~/lib/compositor/carve'
import { defaultGrid } from '~/lib/frame/grid'
import { dealVocabDrivesLook } from '~/lib/compositor/dealVocab'
import { applyCompositorCommand, describeCompositor, impliedDealFill, type CompositorState } from '~/lib/agent/surfaces/compositor'

const P = (over: Partial<CarveParams> = {}): CarveParams => ({ ...defaultCarve(), ...over })
const PAL = [...CARVE_PALETTE_PRESETS.Report.inks]

// ── Rule: the carve (split) ──────────────────────────────────────────────────
describe('carveSplit — the recursive split', () => {
  it('one rectangle cut `cuts` times leaves cuts+1 panels (cuts is floored at 1)', () => {
    for (const cuts of [1, 2, 5, 7, 16]) {
      for (const seed of [1, 12, 777]) expect(carveSplit(P({ cuts }), 1, seed).length).toBe(cuts + 1)
    }
    // 0 (and anything below) still cuts once — the source's max(1, round(cuts)).
    expect(carveSplit(P({ cuts: 0 }), 1, 5).length).toBe(2)
  })

  it('the panels tile the unit box exactly: areas sum to 1, and every sample point is in exactly one panel', () => {
    for (const seed of [1, 12, 99, 4242]) {
      const panels = carveSplit(P({ cuts: 9, uneven: 0.8 }), 0.75, seed)
      expect(panels.reduce((s, r) => s + r.w * r.h, 0)).toBeCloseTo(1, 9)
      for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
        const px = (i + 0.5) / 13, py = (j + 0.5) / 13
        const hits = panels.filter(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)
        expect(hits.length).toBe(1)
      }
      for (const r of panels) { expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0) }
    }
  })

  it('splits across the LONG side in real proportions — with the source\'s 18% flip', () => {
    // One cut, uneven 0 ⇒ t is exactly 0.5, so a vertical split gives two 0.5-wide
    // panels and a horizontal one two 0.5-tall panels. A LANDSCAPE box (aspect < 1)
    // should split vertically ~82% of the time, a PORTRAIT box horizontally ~82%.
    const share = (aspect: number, vertical: boolean) => {
      let hit = 0
      for (let seed = 1; seed <= 400; seed++) {
        const [a] = carveSplit(P({ cuts: 1, uneven: 0 }), aspect, seed)
        const isVertical = Math.abs(a!.w - 0.5) < 1e-9
        if (isVertical === vertical) hit++
      }
      return hit / 400
    }
    expect(share(0.5, true)).toBeGreaterThan(0.74)     // wide box ⇒ vertical cut
    expect(share(0.5, true)).toBeLessThan(0.9)         // …but the flip really happens
    expect(share(2, false)).toBeGreaterThan(0.74)      // tall box ⇒ horizontal cut
    expect(share(2, false)).toBeLessThan(0.9)
  })

  it('the split fraction is 0.5 ± uneven·0.43 (uneven 0 ⇒ dead centre; clamped at 0.92)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const [a, b] = carveSplit(P({ cuts: 1, uneven: 0 }), 1, seed)
      expect(Math.min(a!.w, a!.h)).toBeCloseTo(0.5, 9)
      expect(a!.w * a!.h).toBeCloseTo(b!.w * b!.h, 9)
    }
    for (const uneven of [0.25, 0.55, 1]) {
      let lo = 1, hi = 0
      for (let seed = 1; seed <= 300; seed++) {
        const [a] = carveSplit(P({ cuts: 1, uneven }), 1, seed)
        const t = Math.abs(a!.w - 1) < 1e-9 ? a!.h : a!.w
        lo = Math.min(lo, t); hi = Math.max(hi, t)
      }
      const reach = Math.min(0.92, uneven) * 0.43
      expect(lo).toBeGreaterThanOrEqual(0.5 - reach - 1e-9)
      expect(hi).toBeLessThanOrEqual(0.5 + reach + 1e-9)
      expect(hi - lo).toBeGreaterThan(reach)            // the whole range is really used
    }
  })

  it('picks among the LARGEST few, not always the largest: the biggest panel is usually the one cut', () => {
    // Always-the-largest lays out like a spreadsheet; always-random shreds one corner.
    let cutTheBiggest = 0
    for (let seed = 1; seed <= 200; seed++) {
      const before = carveSplit(P({ cuts: 3 }), 1, seed)
      const after = carveSplit(P({ cuts: 4 }), 1, seed)
      const biggest = before.reduce((m, r) => (r.w * r.h > m.w * m.h ? r : m))
      const survived = after.some(r => Math.abs(r.x - biggest.x) < 1e-9 && Math.abs(r.y - biggest.y) < 1e-9
        && Math.abs(r.w - biggest.w) < 1e-9 && Math.abs(r.h - biggest.h) < 1e-9)
      if (!survived) cutTheBiggest++
    }
    expect(cutTheBiggest / 200).toBeGreaterThan(0.5)
    expect(cutTheBiggest / 200).toBeLessThan(0.95)
  })

  it('the panel order is stable: top to bottom, then left to right', () => {
    const panels = carveSplit(P({ cuts: 12 }), 1, 12)
    for (let i = 1; i < panels.length; i++) {
      const a = panels[i - 1]!, b = panels[i]!
      expect(a.y < b.y || (Math.abs(a.y - b.y) < 1e-12 && a.x <= b.x)).toBe(true)
    }
  })

  it('is deterministic in the seed, and two seeds are two compositions', () => {
    expect(carveSplit(P(), 1, 12)).toEqual(carveSplit(P(), 1, 12))
    expect(JSON.stringify(carveSplit(P(), 1, 12))).not.toBe(JSON.stringify(carveSplit(P(), 1, 13)))
  })
})

// ── Rule: the treatments ─────────────────────────────────────────────────────
describe('carveTreatments — one stream per panel', () => {
  const treat = (over: Partial<CarveParams>, seed: number, aspect = 1) =>
    carveTreatments(carveSplit(P(over), aspect, seed), P(over), PAL.length, seed)

  it('`mix` is the fraction of panels that are patterned (0 ⇒ all flat, 1 ⇒ none flat)', () => {
    for (const seed of [1, 7, 12]) {
      for (const r of treat({ mix: 0, cuts: 12 }, seed)) expect(r.kind).toBe('flat')
      for (const r of treat({ mix: 1, cuts: 12 }, seed)) expect(r.kind).not.toBe('flat')
    }
    let flat = 0, n = 0
    for (let seed = 1; seed <= 120; seed++) for (const r of treat({ mix: 0.7, cuts: 12 }, seed)) { if (r.kind === 'flat') flat++; n++ }
    expect(Math.abs((1 - flat / n) - 0.7)).toBeLessThan(0.06)
  })

  it('the patterned kinds split stripe / chev / grain by the source thresholds, and every kind is reachable', () => {
    const counts: Record<string, number> = {}
    let n = 0
    for (let seed = 1; seed <= 200; seed++) for (const r of treat({ mix: 1, cuts: 12 }, seed)) { counts[r.kind] = (counts[r.kind] ?? 0) + 1; n++ }
    for (const k of CARVE_KINDS) expect(counts[k] ?? 0, k).toBeGreaterThan(k === 'flat' ? -1 : 0)
    expect(counts.flat ?? 0).toBe(0)                       // mix 1 ⇒ nothing is left flat
    // roll < .34 stripe, < .6 chev, else grain — minus the sliver taken by the grid.
    expect(Math.abs(counts.stripe! / n - 0.34)).toBeLessThan(0.06)
    expect(Math.abs(counts.chev! / n - 0.26)).toBeLessThan(0.06)
    expect(counts.grain! / n).toBeGreaterThan(0.3)
  })

  it('the drawn grid is a guest: at most ONE per composition, and only on a panel under 0.3 of the box', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const panels = treat({ mix: 1, cuts: 14 }, seed)
      const grids = panels.filter(r => r.kind === 'grid')
      expect(grids.length).toBeLessThanOrEqual(1)
      for (const g of grids) expect(g.w * g.h).toBeLessThan(0.3)
    }
    // …and with only big panels around it never appears at all (one even cut ⇒ two halves).
    for (let seed = 1; seed <= 60; seed++) for (const r of treat({ mix: 1, cuts: 1, uneven: 0 }, seed)) expect(r.kind).not.toBe('grid')
  })

  it('every panel gets two DISTINCT palette inks, a direction, a pitch break in 0.3..0.75 and its own seed', () => {
    for (const n of [2, 6, 8]) for (const seed of [1, 12, 55]) {
      for (const r of carveTreatments(carveSplit(P({ cuts: 10 }), 1, seed), P({ cuts: 10 }), n, seed)) {
        expect(r.a).toBeGreaterThanOrEqual(0); expect(r.a).toBeLessThan(n)
        expect(r.b).toBeGreaterThanOrEqual(0); expect(r.b).toBeLessThan(n)
        expect(r.a).not.toBe(r.b)
        expect([0, 1]).toContain(r.dir)
        expect(r.brk).toBeGreaterThanOrEqual(0.3); expect(r.brk).toBeLessThanOrEqual(0.75)
        expect(Number.isInteger(r.seed)).toBe(true)
      }
    }
    // A one-ink palette can't offer a second ink — it must not loop or throw.
    for (const r of carveTreatments(carveSplit(P(), 1, 3), P(), 1, 3)) { expect(r.a).toBe(0); expect(r.b).toBe(0) }
  })

  it('carveLayout is the split + the treatments at the box aspect', () => {
    const l = carveLayout(P(), 1200, 800, PAL.length, 12)
    expect(l.length).toBe(defaultCarve().cuts + 1)
    expect(l.map(r => [r.x, r.y, r.w, r.h])).toEqual(carveSplit(P(), 800 / 1200, 12).map(r => [r.x, r.y, r.w, r.h]))
  })
})

// ── Rule: the grain ramp ─────────────────────────────────────────────────────
describe('carveGrainPixels — the photographic panels', () => {
  it('is a ramp between the two inks along the panel\'s own angle, deterministic in the panel seed', () => {
    const a = carveGrainPixels(24, 16, '#000000', '#ffffff', 0, 1234)
    expect(a.length).toBe(24 * 16 * 4)
    expect(carveGrainPixels(24, 16, '#000000', '#ffffff', 0, 1234)).toEqual(a)
    expect(carveGrainPixels(24, 16, '#000000', '#ffffff', 0, 4321)).not.toEqual(a)
    // Opaque everywhere, and the ramp really runs (both ends present).
    for (let p = 3; p < a.length; p += 4) expect(a[p]).toBe(255)
    const lum = [...Array(24 * 16)].map((_, i) => a[i * 4]!)
    expect(Math.max(...lum) - Math.min(...lum)).toBeGreaterThan(120)
  })

  it('grain roughens the middle of the ramp and TAPERS to nothing at both ends', () => {
    // Full-strength noise at the ends burns the pale end to paper and blocks the
    // dark end up — the source tapers by (1 − |t−.5|·1.1).
    const W = 200, H = 200
    const clean = carveGrainPixels(W, H, '#000000', '#ffffff', 0, 77)
    const rough = carveGrainPixels(W, H, '#000000', '#ffffff', 1, 77)
    const dev = (from: number, to: number) => {
      let s = 0, n = 0
      for (let i = 0; i < W * H; i++) {
        const t = clean[i * 4]! / 255
        if (t < from || t >= to) continue
        s += Math.abs(rough[i * 4]! - clean[i * 4]!); n++
      }
      return n ? s / n : 0
    }
    expect(dev(0.4, 0.6)).toBeGreaterThan(dev(0.0, 0.08))
    expect(dev(0.4, 0.6)).toBeGreaterThan(dev(0.92, 1.0))
    expect(dev(0.4, 0.6)).toBeGreaterThan(8)
    // grain 0 changes nothing at all.
    expect(carveGrainPixels(W, H, '#000000', '#ffffff', 0, 77)).toEqual(clean)
  })
})

// ── Params, limits, palettes ─────────────────────────────────────────────────
describe('params and palettes', () => {
  it('the defaults are the source defaults', () => {
    expect(defaultCarve()).toMatchObject({ cuts: 7, uneven: 0.55, gap: 0, mix: 0.7, stripePitch: 0.4, grain: 0.5, gridDetail: 0.5 })
    expect(defaultCarve().inks).toEqual([...CARVE_PALETTE_PRESETS.Report.inks])
  })
  it('normalizeCarve clamps every field and keeps only hex inks', () => {
    const n = normalizeCarve({ cuts: 99, uneven: -1, gap: 'x', mix: 2, stripePitch: 0.25, grain: null, gridDetail: 1.4, inks: ['#abcdef', 'nope', 7] })
    expect(n.cuts).toBe(CARVE_LIMITS.cuts[1]); expect(n.uneven).toBe(0); expect(n.mix).toBe(1)
    expect(n.gap).toBe(defaultCarve().gap); expect(n.grain).toBe(defaultCarve().grain)
    expect(n.stripePitch).toBe(0.25); expect(n.gridDetail).toBe(1)
    expect(n.inks).toEqual(['#abcdef'])
    expect(normalizeCarve({ cuts: 4.6 }).cuts).toBe(5)      // cuts is a whole number
    expect(normalizeCarve(undefined)).toEqual(defaultCarve())
    expect(normalizeCarve({ inks: [] }).inks).toEqual(defaultCarve().inks)   // never inkless
  })
  it('the palette presets are the tool\'s table: 2 neutrals then 4 loud inks, and each round-trips', () => {
    expect(CARVE_PRESET_NAMES.length).toBeGreaterThanOrEqual(5)
    for (const name of CARVE_PRESET_NAMES) {
      const p = CARVE_PALETTE_PRESETS[name]
      expect(p.inks.length).toBe(6)
      for (const c of p.inks) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
      const norm = normalizeCarve(carvePresetPatch(name))
      expect(carvePresetOf(norm)).toBe(name)
      expect(norm.inks.length).toBe(6)
    }
    expect(carvePresetOf(P({ inks: ['#123456', '#654321'] }))).toBe(null)
  })
})

// ── Paint (headless) ─────────────────────────────────────────────────────────
type Rect = { x: number; y: number; w: number; h: number; style: unknown; alpha: number }
type Poly = { pts: [number, number][]; style: unknown }
type Arc = { cx: number; cy: number; r: number; style: unknown }
type Stroke = { style: unknown; lineWidth: number; segs: [number, number, number, number][] }
function recorder(scale = 1) {
  const rects: Rect[] = [], polys: Poly[] = [], arcs: Arc[] = [], strokes: Stroke[] = [], images: { x: number; y: number; w: number; h: number }[] = []
  let pts: [number, number][] = [], segs: [number, number, number, number][] = []
  let pen: [number, number] | null = null, pendingArc: Arc | null = null
  const ctx = {
    fillStyle: '' as unknown, strokeStyle: '' as unknown, lineWidth: 1, globalAlpha: 1,
    getTransform: () => ({ a: scale, b: 0 }),
    save() {}, restore() {}, rect() {}, clip() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, style: ctx.fillStyle, alpha: ctx.globalAlpha }) },
    beginPath() { pts = []; segs = []; pen = null; pendingArc = null },
    moveTo(x: number, y: number) { pts.push([x, y]); pen = [x, y] },
    lineTo(x: number, y: number) { pts.push([x, y]); if (pen) segs.push([pen[0], pen[1], x, y]); pen = [x, y] },
    closePath() {},
    arc(cx: number, cy: number, r: number) { pendingArc = { cx, cy, r, style: ctx.fillStyle } },
    fill() { if (pendingArc) { arcs.push({ ...pendingArc, style: ctx.fillStyle }); pendingArc = null } else if (pts.length) polys.push({ pts: pts.slice(), style: ctx.fillStyle }) },
    stroke() { strokes.push({ style: ctx.strokeStyle, lineWidth: ctx.lineWidth, segs: segs.slice() }) },
    drawImage(_img: unknown, x: number, y: number, w: number, h: number) { images.push({ x, y, w, h }) },
  }
  return { ctx: ctx as unknown as CarveCtx, rects, polys, arcs, strokes, images }
}

/** A `document` whose canvases really hold pixels (the grain path needs one). */
function stubCanvasDocument() {
  vi.stubGlobal('document', {
    createElement: () => {
      const c: any = { width: 0, height: 0 }
      c.getContext = () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      })
      return c
    },
  })
}

describe('paintCarve (headless)', () => {
  const W = 800, H = 600
  beforeEach(stubCanvasDocument)
  afterEach(() => vi.unstubAllGlobals())

  it('lays the ground down first in the palette\'s first ink, then paints each panel', () => {
    const rec = recorder()
    const panels = paintCarve(rec.ctx, P(), PAL, W, H, 12)
    expect(rec.rects[0]).toMatchObject({ x: 0, y: 0, w: W, h: H, style: PAL[0] })
    expect(panels.length).toBe(8)
  })

  it('NEVER writes globalAlpha or a composite op — every mark rides the layer opacity it was handed', () => {
    // The deal's inline render path has already put the layer's opacity and blend on
    // this ctx. An absolute write would stomp both mid-composition.
    const rec = recorder()
    const writes: string[] = []
    const guarded = new Proxy(rec.ctx as unknown as Record<string, unknown>, {
      set(t, k, v) { if (k === 'globalAlpha' || k === 'globalCompositeOperation') writes.push(String(k)); t[k as string] = v; return true },
    }) as unknown as CarveCtx
    rec.ctx.globalAlpha = 0.4
    paintCarve(guarded, P({ mix: 1 }), PAL, W, H, 12)
    expect(writes).toEqual([])
    for (const r of rec.rects) expect(r.alpha).toBeCloseTo(0.4, 9)
    expect(rec.ctx.globalAlpha).toBeCloseTo(0.4, 9)
  })

  it('a flat panel is one rect in ink A, inset by the gap and never smaller than 1px', () => {
    const rec = recorder()
    const panels = paintCarve(rec.ctx, P({ mix: 0, gap: 0.5 }), PAL, W, H, 12)
    const gap = 0.5 * Math.min(W, H) * 0.02
    const drawn = rec.rects.slice(1)
    expect(drawn.length).toBe(panels.length)
    panels.forEach((p, i) => {
      expect(drawn[i]).toMatchObject({
        x: p.x * W + gap / 2, y: p.y * H + gap / 2,
        w: Math.max(1, p.w * W - gap), h: Math.max(1, p.h * H - gap), style: PAL[p.a],
      })
    })
    // A tiny box still paints: every panel keeps at least a 1px side.
    const tiny = recorder()
    paintCarve(tiny.ctx, P({ mix: 0, gap: 1, cuts: 16 }), PAL, 6, 4, 3)
    for (const r of tiny.rects.slice(1)) { expect(r.w).toBeGreaterThanOrEqual(1); expect(r.h).toBeGreaterThanOrEqual(1) }
  })

  it('a stripe panel is ink A under bands of ink B at TWO pitches, the second 1.9× the first past the break', () => {
    // The dropped-signal look: the pitch changes partway across the panel.
    const rec = recorder()
    const params = P({ mix: 1, cuts: 1, uneven: 0, stripePitch: 1 })
    let hit = 0
    for (let seed = 1; seed <= 60 && !hit; seed++) {
      rec.rects.length = 0
      const panels = paintCarve(rec.ctx, params, PAL, W, H, seed)
      const k = panels.findIndex(p => p.kind === 'stripe')
      if (k < 0) continue
      hit = 1
      const p = panels[k]!
      const x = p.x * W, y = p.y * H, w = p.w * W, h = p.h * H
      const base = Math.max(3, (0.006 + params.stripePitch * 0.075) * Math.min(w, h) + 2)
      const bands = rec.rects.filter(r => r.style === PAL[p.b] && r.x >= x - 1e-9 && r.y >= y - 1e-9)
      expect(bands.length).toBeGreaterThan(2)
      const thin = p.dir ? bands.map(b => b.h) : bands.map(b => b.w)
      // Two pitches present, and the coarse one is 1.9× the fine one.
      expect(Math.max(...thin)).toBeGreaterThan(base * 1.5)
      expect(Math.min(...thin)).toBeLessThanOrEqual(base + 1e-9)
      expect(Math.max(...thin)).toBeCloseTo(base * 1.9, 6)
      // Every band stays inside the panel.
      for (const b of bands) {
        expect(b.x).toBeGreaterThanOrEqual(x - 1e-9); expect(b.y).toBeGreaterThanOrEqual(y - 1e-9)
        expect(b.x + b.w).toBeLessThanOrEqual(x + w + 1e-6); expect(b.y + b.h).toBeLessThanOrEqual(y + h + 1e-6)
      }
    }
    expect(hit).toBe(1)
  })

  it('a chevron panel stacks at least two arrows off the SHORT side', () => {
    const rec = recorder()
    const params = P({ mix: 1, cuts: 3 })
    let rows = 0
    for (let seed = 1; seed <= 80 && !rows; seed++) {
      rec.rects.length = 0; rec.polys.length = 0
      const panels = paintCarve(rec.ctx, params, PAL, W, H, seed)
      const chevs = panels.filter(q => q.kind === 'chev')
      if (!chevs.length) continue
      const rowsOf = (p: typeof chevs[number]) => {
        const w = p.w * W, h = p.h * H
        return Math.max(2, Math.round(h / Math.max(14, Math.min(w, h) * 0.55)))
      }
      rows = chevs.reduce((s, p) => s + rowsOf(p), 0)
      expect(rec.polys.length).toBe(rows)                      // every arrow of every chevron panel
      for (const p of chevs) expect(rowsOf(p)).toBeGreaterThanOrEqual(2)
      const inks = new Set(chevs.map(p => PAL[p.b]))
      for (const poly of rec.polys) { expect(poly.pts.length).toBe(6); expect(inks.has(poly.style as string)).toBe(true) }
    }
    expect(rows).toBeGreaterThanOrEqual(2)
  })

  it('a grain panel goes through an OFFSCREEN canvas and drawImage — never putImageData on the layer ctx', () => {
    // putImageData ignores the layer's opacity, its transform and the box clip.
    const rec = recorder(2)
    const params = P({ mix: 1, cuts: 5 })
    let seen = 0
    for (let seed = 1; seed <= 40 && !seen; seed++) {
      rec.images.length = 0
      const panels = paintCarve(rec.ctx, params, PAL, W, H, seed)
      const p = panels.find(q => q.kind === 'grain')
      if (!p) continue
      seen = 1
      expect(rec.images.length).toBeGreaterThanOrEqual(1)
      const img = rec.images[0]!
      expect(img.w).toBeGreaterThan(0); expect(img.h).toBeGreaterThan(0)
    }
    expect(seen).toBe(1)
    expect((rec.ctx as unknown as Record<string, unknown>).putImageData).toBeUndefined()
  })

  it('the hairline grid panel draws its lattice and its ~18% of dots', () => {
    const rec = recorder()
    const params = P({ mix: 1, cuts: 14, gridDetail: 1 })
    let found = 0
    for (let seed = 1; seed <= 120 && !found; seed++) {
      rec.arcs.length = 0; rec.strokes.length = 0
      const panels = paintCarve(rec.ctx, params, PAL, W, H, seed)
      const p = panels.find(q => q.kind === 'grid')
      if (!p) continue
      found = 1
      const w = p.w * W, h = p.h * H
      expect(rec.strokes.length).toBe(1)
      expect(rec.strokes[0]!.style).toBe(PAL[p.b])
      expect(rec.strokes[0]!.lineWidth).toBeCloseTo(Math.max(1, Math.min(w, h) * 0.004), 9)
      const step = Math.max(14, Math.min(w, h) / (2 + Math.round(params.gridDetail * 6)))
      const nx = Math.floor((w + 0.5) / step) + 1, ny = Math.floor((h + 0.5) / step) + 1
      expect(rec.strokes[0]!.segs.length).toBe(nx + ny)
      expect(rec.arcs.length).toBeLessThan(nx * ny)          // only some nodes get a dot
      for (const a of rec.arcs) expect(a.r).toBeCloseTo(Math.max(1.6, Math.min(w, h) * 0.016), 9)
    }
    expect(found).toBe(1)
  })

  it('two seeds are two pictures; an empty palette never throws', () => {
    const a = recorder(), b = recorder(), c = recorder()
    paintCarve(a.ctx, P(), PAL, W, H, 1)
    paintCarve(b.ctx, P(), PAL, W, H, 2)
    expect(JSON.stringify(a.rects)).not.toBe(JSON.stringify(b.rects))
    expect(() => paintCarve(c.ctx, P(), [], 300, 200, 1)).not.toThrow()
    expect(c.rects.length).toBeGreaterThan(0)
  })
})

// ── The deal branch routes cellFill:'carve' to paintCarve ────────────────────
describe('deal layer render with cellFill:carve (headless)', () => {
  const mainRects: { x: number; y: number; w: number; h: number }[] = []
  let translate: [number, number] = [0, 0]
  let mainDraws = 0
  function recordingCtx(name: string) {
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({ a: 1, b: 0 }), setTransform() {}, save() {}, restore() {},
      translate(x: number, y: number) { if (name === 'main') translate = [x, y] }, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() {}, clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) { if (name === 'main') mainRects.push({ x, y, w, h }) },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return { addColorStop() {} } },
      createLinearGradient() { return { addColorStop() {} } },
      createPattern() { return {} },
      drawImage() { if (name === 'main') mainDraws++ },
    } as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  beforeEach(() => {
    mainRects.length = 0; mainDraws = 0; seq = 0; translate = [0, 0]
    vi.stubGlobal('document', { createElement: () => { const c: any = { width: 0, height: 0 }; c.getContext = () => recordingCtx(`off-${++seq}`); return c } })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function drawDeal(layer: any, W: number, H: number) {
    const { drawLocalLayer } = await import('~/composables/useCompositorLayers')
    drawLocalLayer(recordingCtx('main'), layer, W, H)
  }
  const dealLayer = (over: Record<string, unknown> = {}) => ({
    id: 'd1', kind: 'deal', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 1, h: 1,
    vocab: 'brand', density: 0.1, cellInset: 0.3,
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0, gen: { ...defaultGrid().gen, seed: 12 } },
    ...over,
  })

  it('paints the whole box, centred, ignoring grid / density / inset', async () => {
    await drawDeal(dealLayer({ cellFill: 'carve', carve: defaultCarve() }), 400, 400)
    expect(translate).toEqual([-200, -200])
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 400 })
    const rec = recorder()
    paintCarve(rec.ctx, defaultCarve(), defaultCarve().inks, 400, 400, 12)
    expect(mainRects.length).toBe(rec.rects.length)
  })
  it('a carve deal with no params of its own paints at the defaults', async () => {
    await drawDeal(dealLayer({ cellFill: 'carve', h: 0.75 }), 400, 300)
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })
})

// ── The Mosaic seams: style table, vocab gate, agent op ──────────────────────
describe('Carve as a Mosaic style', () => {
  const baseState = (extra: Partial<CompositorState> = {}): CompositorState => ({ layers: [], ...extra })
  const layerOf = (r: ReturnType<typeof applyCompositorCommand>) => (r as any).template.layers[0]

  it('carries its own palette, so the vocabulary control stays hidden', () => {
    expect(dealVocabDrivesLook({ cellFill: 'carve' })).toBe(false)
  })

  it('style:"carve" creates a frame-filling carve mosaic with the source defaults', () => {
    const r = applyCompositorCommand(baseState({ aspect: 0.75 }), { op: 'mosaic', args: { id: 'm', style: 'carve', seed: 12 } })
    expect(r.ok).toBe(true)
    expect(layerOf(r)).toMatchObject({ kind: 'deal', cellFill: 'carve', w: 1, h: 0.75 })
    expect(layerOf(r).carve).toEqual(defaultCarve())
  })

  it('carve tunables imply the style — after pane / modular / parcel / mosh in the precedence order', () => {
    expect(impliedDealFill({ carve: {} })).toBe('carve')
    expect(impliedDealFill({ mosh: {}, carve: {} })).toBe('mosh')
    expect(impliedDealFill({ palettePreset: 'Almanac' })).toBe('carve')
    const l = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', carve: { cuts: 12, mix: 0.2 } } }))
    expect(l.cellFill).toBe('carve')
    expect(l.carve).toEqual({ ...defaultCarve(), cuts: 12, mix: 0.2 })
  })

  it('a palettePreset lands only on carve, and a wrong-table name is an error with the options', () => {
    const l = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'carve', palettePreset: 'signal' } }))
    expect(l.carve.inks).toEqual([...CARVE_PALETTE_PRESETS.Signal.inks])
    const bad = applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'carve', palettePreset: 'Riso' } })
    expect(bad.ok).toBe(false)
    expect((bad as any).detail).toMatch(/unknown palettePreset "Riso" for carve; options: Report/)
  })

  it('reads back as style "carve" with its preset name and tunables (no ink array)', () => {
    const s = (applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'carve', palettePreset: 'Broadsheet', carve: { cuts: 9 } } }) as any).template
    const cur = describeCompositor(s).objects.find(x => x.id === 'm')!.current as any
    expect(cur.style).toBe('carve')
    expect(cur.carve).toMatchObject({ palettePreset: 'Broadsheet', cuts: 9, mix: 0.7 })
    expect(cur.carve).not.toHaveProperty('inks')
    expect(describeCompositor(baseState()).commands.find(c => c.op === 'mosaic')!.hint!).toContain('"carve"')
  })

  it('restyling to carve and away again keeps the layer, its box and its seed', () => {
    const s1 = (applyCompositorCommand(baseState({ aspect: 0.5 }), { op: 'mosaic', args: { id: 'm', style: 'mosh', seed: 7 } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'mosaic', target: 'm', args: { style: 'carve' } })
    expect(layerOf(r)).toMatchObject({ id: 'm', cellFill: 'carve', w: 1, h: 0.5 })
    expect(layerOf(r).grid.gen.seed).toBe(7)
    const back = applyCompositorCommand((r as any).template, { op: 'mosaic', target: 'm', args: { style: 'mosh' } })
    expect(layerOf(back).cellFill).toBe('mosh')
    expect(layerOf(back).carve).toEqual(defaultCarve())
  })
})
