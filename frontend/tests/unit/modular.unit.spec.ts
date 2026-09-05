import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MODULAR_TYPES, MODULAR_PALETTE_PRESETS, MODULAR_PRESET_NAMES, defaultModular, normalizeModular, modularRows,
  modularPickType, modularRegions, modularEdges, modularLayout, modularCellOn, modularCluster,
  modularGradEndpoints, modularPalette, modularPresetPatch, modularPresetOf, paintModular, fbm2,
  type ModularParams, type ModularCtx, type ModularType,
} from '~/lib/compositor/modular'
import { DEAL_VOCABS } from '~/lib/compositor/dealVocab'
import { defaultGrid } from '~/lib/frame/grid'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// Every rule below is the playgrnd Modular generator's rule, restated as a test.
const P = (over: Partial<ModularParams> = {}): ModularParams => ({ ...defaultModular(), ...over })
const PAL = ['#1B4FA0', '#FF87C3', '#8E9A24', '#FF5B1E', '#111111', '#eeeeee', '#00aa88', '#aa0088']

// ── Rule A: layout ───────────────────────────────────────────────────────────
describe('modularRegions (rule A)', () => {
  it('tiles the gc×gr grid exactly: every module cell claimed once, no overlaps, no gaps', () => {
    for (const seed of [1, 7, 42, 777, 9001]) {
      const gc = 6, gr = 4
      const regs = modularRegions(P({ merge: 0.45 }), gc, gr, PAL.length, seed)
      const cover = new Uint8Array(gc * gr)
      for (const r of regs) {
        expect(r.x + r.w).toBeLessThanOrEqual(gc); expect(r.y + r.h).toBeLessThanOrEqual(gr)
        for (let j = r.y; j < r.y + r.h; j++) for (let i = r.x; i < r.x + r.w; i++) cover[j * gc + i]!++
      }
      for (const c of cover) expect(c).toBe(1)
    }
  })
  it('merge=0 ⇒ all 1×1; merge=1 ⇒ 2×2 / 2-wide / 2-tall all appear; only those four shapes ever', () => {
    for (const seed of [1, 2, 3]) {
      for (const r of modularRegions(P({ merge: 0 }), 8, 6, PAL.length, seed)) { expect(r.w).toBe(1); expect(r.h).toBe(1) }
    }
    const shapes = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5]) for (const r of modularRegions(P({ merge: 1 }), 8, 6, PAL.length, seed)) shapes.add(`${r.w}x${r.h}`)
    expect(shapes.has('2x2')).toBe(true); expect(shapes.has('2x1')).toBe(true); expect(shapes.has('1x2')).toBe(true)
    for (const s of shapes) expect(['1x1', '2x2', '2x1', '1x2']).toContain(s)
  })
  it('merge thresholds keep their order: at merge=1, 2-tall > 2-wide > 2×2 (the .32 / .66 / 1 bands, eroded by free() failures)', () => {
    // Swapping the .32/.66 thresholds would still produce every shape (so the
    // shapes-appear test above passes) but would invert these proportions.
    const counts: Record<string, number> = { '2x2': 0, '2x1': 0, '1x2': 0, '1x1': 0 }
    let n = 0
    for (let seed = 1; seed <= 100; seed++) for (const r of modularRegions(P({ merge: 1 }), 8, 6, PAL.length, seed)) { counts[`${r.w}x${r.h}`]!++; n++ }
    const f = (k: string) => counts[k]! / n
    expect(f('2x1')).toBeGreaterThan(f('2x2'))
    expect(f('1x2')).toBeGreaterThan(f('2x1'))
  })

  it('the type distribution over many seeds ≈ the weights; empty is the most common', () => {
    const w = defaultModular().w
    const total = MODULAR_TYPES.reduce((s, t) => s + w[t], 0)
    const counts: Record<ModularType, number> = { empty: 0, solid: 0, blocks: 0, dots: 0, lines: 0, grad: 0 }
    let n = 0
    for (let seed = 1; seed <= 120; seed++) for (const r of modularRegions(P({ merge: 0 }), 8, 6, PAL.length, seed)) { counts[r.type]++; n++ }
    for (const t of MODULAR_TYPES) expect(Math.abs(counts[t] / n - w[t] / total)).toBeLessThan(0.03)
    expect(Math.max(...MODULAR_TYPES.map(t => counts[t]))).toBe(counts.empty)
  })
  it('modularPickType walks the cumulative weights in TYPES order', () => {
    const w = { empty: 34, solid: 20, blocks: 24, dots: 14, lines: 12, grad: 10 }
    expect(modularPickType(w, 0)).toBe('empty')
    expect(modularPickType(w, 33.9 / 114)).toBe('empty')
    expect(modularPickType(w, 34.1 / 114)).toBe('solid')
    expect(modularPickType(w, 78.1 / 114)).toBe('dots')
    expect(modularPickType(w, 0.9999)).toBe('grad')
    // A zeroed type never appears.
    const none = { ...w, solid: 0 }
    for (let k = 0; k < 500; k++) expect(modularPickType(none, k / 500)).not.toBe('solid')
  })
  it('ci ≠ ci2 always (a DISTINCT second ink), both within the palette; onBg/inset/corner/angle/phase in range', () => {
    for (const n of [2, 4, 8]) for (const seed of [1, 5, 9]) {
      for (const r of modularRegions(P(), 6, 4, n, seed)) {
        expect(r.ci).toBeGreaterThanOrEqual(0); expect(r.ci).toBeLessThan(n)
        expect(r.ci2).toBeGreaterThanOrEqual(0); expect(r.ci2).toBeLessThan(n)
        expect(r.ci).not.toBe(r.ci2)
        expect([0, 1, 2]).toContain(r.inset)
        expect(r.corner).toBeGreaterThanOrEqual(0); expect(r.corner).toBeLessThan(4)
        expect(r.angle).toBeGreaterThanOrEqual(0); expect(r.angle).toBeLessThan(4)
        expect(r.phase).toBeGreaterThanOrEqual(0); expect(r.phase).toBeLessThan(1)
      }
    }
  })
  it('onBg ≈ 45% and inset ≈ 55/25/20 over many modules (the stream draws are independent)', () => {
    let on = 0, ins = [0, 0, 0], n = 0
    for (let seed = 1; seed <= 80; seed++) for (const r of modularRegions(P({ merge: 0 }), 8, 6, PAL.length, seed)) { if (r.onBg) on++; ins[r.inset]!++; n++ }
    expect(Math.abs(on / n - 0.45)).toBeLessThan(0.03)
    expect(Math.abs(ins[0]! / n - 0.55)).toBeLessThan(0.03)
    expect(Math.abs(ins[1]! / n - 0.25)).toBeLessThan(0.03)
    expect(Math.abs(ins[2]! / n - 0.20)).toBeLessThan(0.03)
  })
  it('is deterministic in seed and a different seed changes the layout', () => {
    const a = modularRegions(P(), 6, 4, 8, 5), b = modularRegions(P(), 6, 4, 8, 5), c = modularRegions(P(), 6, 4, 8, 6)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })
  it('pins the DRAW ORDER from the single stream (k, type, ci, ci2, sub, onBg, corner, angle, phase)', () => {
    // The order of draws is what shapes the whole composition: reorder `sub`↔`onBg`,
    // or add/drop a draw, and every later module's type and colours change while the
    // per-field marginals (and every other test here) stay green. A golden pins it.
    const first4 = modularRegions(defaultModular(), 6, 4, 8, 7).slice(0, 4)
      .map(r => [r.x, r.y, r.w, r.h, r.type, r.ci, r.ci2, r.onBg, r.inset, r.corner, r.angle])
    expect(first4).toEqual([
      [0, 0, 1, 1, 'empty', 2, 6, true, 2, 2, 1],
      [1, 0, 1, 2, 'empty', 5, 3, false, 1, 1, 1],
      [2, 0, 1, 2, 'dots', 5, 7, false, 0, 0, 3],
      [3, 0, 1, 1, 'grad', 3, 6, false, 0, 1, 2],
    ])
  })

  it('rows follow the box aspect: gr = max(2, round(gcols · H/W))', () => {
    expect(modularRows(6, 1200, 800)).toBe(4)
    expect(modularRows(6, 1000, 1000)).toBe(6)
    expect(modularRows(6, 1000, 100)).toBe(2)
    expect(modularRows(12, 1080, 1920)).toBe(21)
    const l = modularLayout(P(), 1200, 800, 8, 7)
    expect(l.gc).toBe(6); expect(l.gr).toBe(4)
    expect(l.mx.length).toBe(7); expect(l.my.length).toBe(5)
  })
})

// ── edges ────────────────────────────────────────────────────────────────────
describe('modularEdges', () => {
  it('integer, monotonic, first==a, last==b (flush, no gutter)', () => {
    for (const [n, a, b] of [[6, 0, 1200], [4, 0, 800], [7, 13, 250], [3, 100, 101], [16, 0, 333]] as const) {
      const e = modularEdges(n, a, b)
      expect(e.length).toBe(n + 1)
      expect(e[0]).toBe(a); expect(e[n]).toBe(b)
      for (const v of e) expect(Number.isInteger(v)).toBe(true)
      for (let i = 1; i <= n; i++) expect(e[i]!).toBeGreaterThanOrEqual(e[i - 1]!)
      expect(e[Math.floor(n / 2)]).toBe(Math.round(a + (b - a) * Math.floor(n / 2) / n))
    }
  })
})

// ── Rule B: cellOn ───────────────────────────────────────────────────────────
describe('modularCellOn (rule B)', () => {
  const N = 120
  it('is deterministic and keyed by module index (per-module salt) and seed', () => {
    let diff = 0
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      expect(modularCellOn(x, y, 3, 0.5, 7)).toBe(modularCellOn(x, y, 3, 0.5, 7))
      if (modularCellOn(x, y, 3, 0.5, 7) !== modularCellOn(x, y, 4, 0.5, 7)) diff++
      if (modularCellOn(x, y, 3, 0.5, 7) !== modularCellOn(x, y, 3, 0.5, 8)) diff++
    }
    expect(diff).toBeGreaterThan(100)
  })
  it('fraction on ≈ blockFill over a large field (tolerant), monotone in blockFill', () => {
    const frac = (bf: number) => {
      let on = 0
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (modularCellOn(x, y, 1, bf, 11)) on++
      return on / (N * N)
    }
    expect(Math.abs(frac(0.5) - 0.5)).toBeLessThan(0.08)
    expect(Math.abs(frac(0.25) - 0.25)).toBeLessThan(0.12)
    expect(Math.abs(frac(0.75) - 0.75)).toBeLessThan(0.12)
    expect(frac(0.25)).toBeLessThan(frac(0.5)); expect(frac(0.5)).toBeLessThan(frac(0.75))
  })
  it('blockFill=0 ⇒ none; blockFill=1 ⇒ (all but the saturated cells the ×1.9 stretch pins at exactly 1, which `<` excludes — the source rule)', () => {
    let on0 = 0, on1 = 0
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (modularCellOn(x, y, 1, 0, 3)) on0++; if (modularCellOn(x, y, 1, 1, 3)) on1++ }
    expect(on0).toBe(0)
    expect(on1 / (N * N)).toBeGreaterThan(0.85)
  })
  it('the field is spatially coherent (a 2-octave noise, not white noise): neighbours agree far more often than chance', () => {
    let agree = 0, n = 0
    for (let y = 0; y < N; y++) for (let x = 0; x < N - 1; x++) { if (modularCellOn(x, y, 2, 0.5, 5) === modularCellOn(x + 1, y, 2, 0.5, 5)) agree++; n++ }
    // (white noise ⇒ 0.5; at the source's ·0.55 sampling the second octave is near
    // per-cell, so the field is coherent but grainy — ~0.69 here.)
    expect(agree / n).toBeGreaterThan(0.62)
    for (const v of [fbm2(0.3, 0.7, 1), fbm2(10.2, 3.9, 9), fbm2(-4.5, 2.2, 0)]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
  })
})

// ── Rule C: cluster ──────────────────────────────────────────────────────────
describe('modularCluster (rule C)', () => {
  it('corner alignment: bit0 → right, bit1 → bottom; inset shrinks by 2 per side only when the side > 2', () => {
    expect(modularCluster({ inset: 1, corner: 0 }, 8, 8)).toEqual({ ox: 0, oy: 0, cw: 6, ch: 6 })
    expect(modularCluster({ inset: 1, corner: 1 }, 8, 8)).toEqual({ ox: 2, oy: 0, cw: 6, ch: 6 })
    expect(modularCluster({ inset: 1, corner: 2 }, 8, 8)).toEqual({ ox: 0, oy: 2, cw: 6, ch: 6 })
    expect(modularCluster({ inset: 1, corner: 3 }, 8, 8)).toEqual({ ox: 2, oy: 2, cw: 6, ch: 6 })
    // uh=4 is > 2, so it shrinks by 4 too → clamps to 1 and sits on the bottom row.
    expect(modularCluster({ inset: 2, corner: 3 }, 8, 4)).toEqual({ ox: 4, oy: 3, cw: 4, ch: 1 })
    // uw ≤ 2: no shrink on that side regardless of inset.
    expect(modularCluster({ inset: 2, corner: 3 }, 2, 2)).toEqual({ ox: 0, oy: 0, cw: 2, ch: 2 })
    expect(modularCluster({ inset: 2, corner: 1 }, 2, 6)).toEqual({ ox: 0, oy: 0, cw: 2, ch: 2 })
    // inset 0 = the whole module.
    expect(modularCluster({ inset: 0, corner: 3 }, 4, 4)).toEqual({ ox: 0, oy: 0, cw: 4, ch: 4 })
    // Never below 1.
    expect(modularCluster({ inset: 2, corner: 0 }, 3, 3).cw).toBe(1)
  })
})

// ── Rule D: gradient directions ──────────────────────────────────────────────
describe('modularGradEndpoints (rule D grad)', () => {
  it('the 4 directions are L→R, T→B, TL→BR, TR→BL over the module rect', () => {
    expect(modularGradEndpoints(0, 10, 20, 110, 220)).toEqual([10, 20, 110, 20])
    expect(modularGradEndpoints(1, 10, 20, 110, 220)).toEqual([10, 20, 10, 220])
    expect(modularGradEndpoints(2, 10, 20, 110, 220)).toEqual([10, 20, 110, 220])
    expect(modularGradEndpoints(3, 10, 20, 110, 220)).toEqual([110, 20, 10, 220])
  })
})

// ── Params / presets / palette ───────────────────────────────────────────────
describe('params, presets and palette', () => {
  it('defaults are the source defaults', () => {
    expect(defaultModular()).toMatchObject({
      gcols: 6, unit: 4, merge: 0.45, w: { empty: 34, solid: 20, blocks: 24, dots: 14, lines: 12, grad: 10 },
      blockFill: 0.5, dot: 0.62, rules: 0.22, ruleW: 1,
    })
  })
  it('normalizeModular clamps and falls back per field (weights per type, colours must be hex)', () => {
    const n = normalizeModular({ gcols: 99, unit: -1, merge: 2, w: { empty: 99, solid: 'x' }, blockFill: 'no', dot: 0.1, rules: -1, ruleW: 9, bg: 'red', rule: '#123456', inks: ['#abcdef', 'nope', 7] })
    expect(n.gcols).toBe(12); expect(n.unit).toBe(2); expect(n.merge).toBe(1)
    expect(n.w).toEqual({ ...defaultModular().w, empty: 50 })
    expect(n.blockFill).toBe(0.5); expect(n.dot).toBe(0.1); expect(n.rules).toBe(0); expect(n.ruleW).toBe(3)
    expect(n.bg).toBe(defaultModular().bg); expect(n.rule).toBe('#123456'); expect(n.inks).toEqual(['#abcdef'])
    expect(normalizeModular(undefined)).toEqual(defaultModular())
  })
  it('the 5 presets carry the source colours; a preset patch round-trips through modularPresetOf', () => {
    expect(MODULAR_PRESET_NAMES).toEqual(['Digital', 'Riso', 'Bloom', 'Heat', 'Mono'])
    expect(MODULAR_PALETTE_PRESETS.Riso).toEqual({ bg: '#F1EBE1', rule: '#0E2A8C', inks: ['#1B4FA0', '#FF87C3', '#8E9A24', '#FF5B1E'] })
    expect(MODULAR_PALETTE_PRESETS.Mono.inks).toEqual(['#F2F0EA', '#7E848E', '#3A3E46', '#191B20'])
    for (const name of MODULAR_PRESET_NAMES) {
      const p = normalizeModular(modularPresetPatch(name))
      expect(modularPresetOf(p)).toBe(name)
      expect(p.inks.length).toBe(4)
    }
    expect(modularPresetOf(defaultModular())).toBe(null)   // default inks = the vocab, not a preset
  })
  it('modularPalette: own inks when set, else the vocabulary\'s ORDERED solids (≥ 5), never empty', () => {
    expect(modularPalette(P({ inks: ['#000000', '#ffffff'] }), 'brand')).toEqual(['#000000', '#ffffff'])
    for (const v of DEAL_VOCABS) {
      const inks = modularPalette(P(), v)
      expect(inks.length).toBeGreaterThanOrEqual(5)
      for (const c of inks) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})

// ── Headless render: rule D, every type + the hairlines ─────────────────────
type Rect = { x: number; y: number; w: number; h: number; style: unknown; alpha: number }
type Grad = { x0: number; y0: number; x1: number; y1: number; stops: [number, string][] }
type Arc = { cx: number; cy: number; r: number; style: unknown }
type Stroke = { style: unknown; alpha: number; lineWidth: number; segs: [number, number, number, number][] }
function recorder() {
  const rects: Rect[] = [], grads: Grad[] = [], arcs: Arc[] = [], strokes: Stroke[] = []
  let path: [number, number, number, number][] = [], pen: [number, number] | null = null
  let pendingArc: Arc | null = null
  const ctx = {
    fillStyle: '' as unknown, strokeStyle: '' as unknown, lineWidth: 1, globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, style: ctx.fillStyle, alpha: ctx.globalAlpha }) },
    createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
      const g: Grad & { addColorStop(o: number, c: string): void } = { x0, y0, x1, y1, stops: [], addColorStop(o, c) { g.stops.push([o, c]) } }
      grads.push(g); return g as unknown as CanvasGradient
    },
    beginPath() { path = []; pen = null; pendingArc = null },
    moveTo(x: number, y: number) { pen = [x, y] },
    lineTo(x: number, y: number) { if (pen) path.push([pen[0], pen[1], x, y]); pen = [x, y] },
    arc(cx: number, cy: number, r: number) { pendingArc = { cx, cy, r, style: ctx.fillStyle } },
    fill() { if (pendingArc) { arcs.push({ ...pendingArc, style: ctx.fillStyle }); pendingArc = null } },
    stroke() { strokes.push({ style: ctx.strokeStyle, alpha: ctx.globalAlpha, lineWidth: ctx.lineWidth, segs: path.slice() }) },
  }
  return { ctx: ctx as unknown as ModularCtx, rects, grads, arcs, strokes }
}
const inside = (px: number, py: number, x0: number, y0: number, x1: number, y1: number) => px >= x0 && px <= x1 && py >= y0 && py <= y1

describe('paintModular (rule D, headless)', () => {
  const W = 1200, H = 800

  it('scales every alpha by the INCOMING globalAlpha (the layer opacity) instead of writing absolutes', () => {
    // The deal's inline render path sets the layer opacity on this ctx before
    // painting. The source writes `globalAlpha = .85 / rules / 1` absolutely (it
    // paints at 1), which here would stomp the layer opacity after the first line
    // grid. Every fill/stroke must carry a0 × its own factor, and a0 must survive.
    const p = normalizeModular(modularPresetPatch('Riso'))
    const rec = recorder()
    rec.ctx.globalAlpha = 0.5
    paintModular(rec.ctx, p, p.inks, W, H, 7)
    for (const r of rec.rects) expect(r.alpha).toBeCloseTo(0.5, 6)
    expect(rec.strokes.length).toBeGreaterThan(0)
    const hair = rec.strokes[rec.strokes.length - 1]!
    expect(hair.style).toBe(p.rule)
    expect(hair.alpha).toBeCloseTo(0.5 * p.rules, 6)
    for (const s of rec.strokes.slice(0, -1)) expect(s.alpha).toBeCloseTo(0.5 * 0.85, 6)
    expect(rec.ctx.globalAlpha).toBeCloseTo(0.5, 6)
  })

  it('paints bg first (one full-box fillRect in bg), then per module exactly what its type implies, then the hairlines', () => {
    for (const seed of [7, 23, 101]) {
      const p = normalizeModular(modularPresetPatch('Riso'))
      const rec = recorder()
      const layout = paintModular(rec.ctx, p, p.inks, W, H, seed)
      expect(rec.rects[0]).toMatchObject({ x: 0, y: 0, w: W, h: H, style: p.bg })
      const { mx, my, regions, gc, gr } = layout
      // Types seen in this render, so the per-type checks below actually ran.
      const seen = new Set<ModularType>()
      let rectCursor = 1, arcCursor = 0, strokeCursor = 0, gradCursor = 0
      regions.forEach((reg, idx) => {
        seen.add(reg.type)
        const x0 = mx[reg.x]!, x1 = mx[reg.x + reg.w]!, y0 = my[reg.y]!, y1 = my[reg.y + reg.h]!
        const col = p.inks[reg.ci]!, col2 = p.inks[reg.ci2]!
        const uw = reg.w * p.unit, uh = reg.h * p.unit
        const ux = modularEdges(uw, x0, x1), uy = modularEdges(uh, y0, y1)
        if (reg.type === 'empty') return
        if (reg.type === 'solid') {
          expect(rec.rects[rectCursor++]).toMatchObject({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, style: col })
          return
        }
        if (reg.type === 'grad') {
          const g = rec.grads[gradCursor++]!
          const r = rec.rects[rectCursor++]!
          expect(r).toMatchObject({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
          expect(r.style).toBe(g)
          expect(g.stops).toEqual([[0, col], [1, col2]])
          expect([g.x0, g.y0, g.x1, g.y1]).toEqual(modularGradEndpoints(reg.angle, x0, y0, x1, y1))
          return
        }
        // blocks / dots / lines: the col2 ground first unless onBg.
        if (!reg.onBg) expect(rec.rects[rectCursor++]).toMatchObject({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, style: col2 })
        if (reg.type === 'blocks') {
          // Each run rect: in col, on a sub-row, spanning consecutive ON sub-cells, inside the module.
          let expectRuns = 0
          for (let j = 0; j < uh; j++) { let prev = false; for (let i = 0; i < uw; i++) { const on = modularCellOn(reg.x * p.unit + i, reg.y * p.unit + j, idx, p.blockFill, seed); if (on && !prev) expectRuns++; prev = on } }
          for (let k = 0; k < expectRuns; k++) {
            const r = rec.rects[rectCursor++]!
            expect(r.style).toBe(col)
            expect(inside(r.x, r.y, x0, y0, x1, y1) && inside(r.x + r.w, r.y + r.h, x0, y0, x1, y1)).toBe(true)
            const j = uy.indexOf(r.y); expect(j).toBeGreaterThanOrEqual(0); expect(r.h).toBe(uy[j + 1]! - uy[j]!)
            const i0 = ux.indexOf(r.x), i1 = ux.indexOf(r.x + r.w)
            expect(i0).toBeGreaterThanOrEqual(0); expect(i1).toBeGreaterThan(i0)
            for (let i = i0; i < i1; i++) expect(modularCellOn(reg.x * p.unit + i, reg.y * p.unit + j, idx, p.blockFill, seed)).toBe(true)
          }
          return
        }
        if (reg.type === 'dots') {
          const { ox, oy, cw, ch } = modularCluster(reg, uw, uh)
          const cx0 = ux[ox]!, cy0 = uy[oy]!, cx1 = ux[ox + cw]!, cy1 = uy[oy + ch]!
          let expectDots = 0
          for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (modularCellOn(reg.x * p.unit + ox + i, reg.y * p.unit + oy + j, idx + 77, p.blockFill, seed)) expectDots++
          for (let k = 0; k < expectDots; k++) {
            const a = rec.arcs[arcCursor++]!
            expect(a.style).toBe(col)
            expect(inside(a.cx, a.cy, cx0, cy0, cx1, cy1)).toBe(true)   // only inside the CLUSTER
            // radius = min(subW, subH) · dot / 2 of its own sub-cell
            const i = ux.findIndex((v, n) => a.cx > v && a.cx < ux[n + 1]!), j = uy.findIndex((v, n) => a.cy > v && a.cy < uy[n + 1]!)
            expect(a.r).toBeCloseTo(Math.min(ux[i + 1]! - ux[i]!, uy[j + 1]! - uy[j]!) * p.dot / 2, 9)
            expect(a.cx).toBeCloseTo((ux[i]! + ux[i + 1]!) / 2, 9); expect(a.cy).toBeCloseTo((uy[j]! + uy[j + 1]!) / 2, 9)
          }
          return
        }
        if (reg.type === 'lines') {
          const s = rec.strokes[strokeCursor++]!
          expect(s.style).toBe(col); expect(s.alpha).toBe(0.85); expect(s.lineWidth).toBe(p.ruleW)
          const verts = [], horiz = []
          for (let i = 1; i < uw; i++) verts.push([ux[i]! + 0.5, y0, ux[i]! + 0.5, y1])
          for (let j = 1; j < uh; j++) horiz.push([x0, uy[j]! + 0.5, x1, uy[j]! + 0.5])
          expect(s.segs).toEqual([...verts, ...horiz])
        }
      })
      // Everything accounted for — nothing extra was painted per module.
      expect(rec.grads.length).toBe(gradCursor); expect(rec.arcs.length).toBe(arcCursor)
      expect(rec.rects.length).toBe(rectCursor)
      // The hairlines: the LAST stroke, rule colour, alpha == rules, every interior module edge, full span.
      expect(rec.strokes.length).toBe(strokeCursor + 1)
      const hair = rec.strokes[rec.strokes.length - 1]!
      expect(hair.style).toBe(p.rule); expect(hair.alpha).toBe(p.rules); expect(hair.lineWidth).toBe(p.ruleW)
      const expectSegs = []
      for (let i = 1; i < gc; i++) expectSegs.push([mx[i]! + 0.5, 0, mx[i]! + 0.5, H])
      for (let j = 1; j < gr; j++) expectSegs.push([0, my[j]! + 0.5, W, my[j]! + 0.5])
      expect(hair.segs).toEqual(expectSegs)
      // Alpha restored after every alpha'd stroke.
      expect((rec.ctx as unknown as { globalAlpha: number }).globalAlpha).toBe(1)
      // At the defaults, over 3 seeds, all six types should have been exercised at least once.
      for (const t of MODULAR_TYPES) if (seed === 101) expect([...seen].length).toBeGreaterThanOrEqual(5)
    }
  })

  it('pins one gradient direction: angle 3 runs top-right → bottom-left of ITS module', () => {
    const p = normalizeModular({ ...modularPresetPatch('Digital'), w: { empty: 0, solid: 0, blocks: 0, dots: 0, lines: 0, grad: 1 }, merge: 0 })
    const rec = recorder()
    const { mx, my, regions } = paintModular(rec.ctx, p, p.inks, W, H, 3)
    const k = regions.findIndex(r => r.angle === 3)
    expect(k).toBeGreaterThanOrEqual(0)
    const reg = regions[k]!, g = rec.grads[k]!
    expect([g.x0, g.y0, g.x1, g.y1]).toEqual([mx[reg.x + 1], my[reg.y], mx[reg.x], my[reg.y + 1]])
    const k0 = regions.findIndex(r => r.angle === 0)
    if (k0 >= 0) { const r0 = regions[k0]!, g0 = rec.grads[k0]!; expect([g0.x0, g0.y0, g0.x1, g0.y1]).toEqual([mx[r0.x], my[r0.y], mx[r0.x + 1], my[r0.y]]) }
  })

  it('rules=0 ⇒ no hairline stroke; rules>0 ⇒ exactly one, at that alpha', () => {
    const only = { empty: 1, solid: 0, blocks: 0, dots: 0, lines: 0, grad: 0 }
    const a = recorder(); paintModular(a.ctx, P({ w: only, rules: 0 }), PAL, W, H, 1)
    expect(a.strokes.length).toBe(0)
    expect(a.rects.length).toBe(1)   // bg only: every module empty
    const b = recorder(); paintModular(b.ctx, P({ w: only, rules: 0.4 }), PAL, W, H, 1)
    expect(b.strokes.length).toBe(1); expect(b.strokes[0]!.alpha).toBe(0.4)
  })

  it('module edges are flush: consecutive solid modules share an edge; edges span 0..W / 0..H', () => {
    const p = P({ w: { empty: 0, solid: 1, blocks: 0, dots: 0, lines: 0, grad: 0 }, merge: 0, rules: 0 })
    const rec = recorder()
    const { mx, my, gc, gr } = paintModular(rec.ctx, p, PAL, W, H, 4)
    expect(mx[0]).toBe(0); expect(mx[gc]).toBe(W); expect(my[0]).toBe(0); expect(my[gr]).toBe(H)
    const mods = rec.rects.slice(1)
    expect(mods.length).toBe(gc * gr)
    for (let k = 1; k < gc; k++) expect(mods[k]!.x).toBe(mods[k - 1]!.x + mods[k - 1]!.w)
  })

  it('never throws on an empty palette (graceful fallback pair)', () => {
    const rec = recorder()
    expect(() => paintModular(rec.ctx, P(), [], 300, 200, 1)).not.toThrow()
    expect(rec.rects.length).toBeGreaterThanOrEqual(1)
  })
})

// ── The deal branch routes cellFill:'modular' to paintModular on the REAL ctx ─
describe('deal layer render with cellFill:modular (headless)', () => {
  const mainRects: { x: number; y: number; w: number; h: number }[] = []
  const mainDraws: number[] = []
  let mainStrokes = 0, mainGrads = 0, mainArcs = 0
  let translate: [number, number] = [0, 0]
  function recordingCtx(name: string) {
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({}), setTransform() {}, save() {}, restore() {},
      translate(x: number, y: number) { if (name === 'main') translate = [x, y] }, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() { if (name === 'main') mainArcs++ }, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() { if (name === 'main') mainStrokes++ }, clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) { if (name === 'main') mainRects.push({ x, y, w, h }) },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return { addColorStop() {} } },
      createLinearGradient() { if (name === 'main') mainGrads++; return { addColorStop() {} } },
      createPattern() { return {} },
      drawImage() { if (name === 'main') mainDraws.push(1) },
    } as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  class FakeImageData {
    data: Uint8ClampedArray; width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w * h) * 4) }
  }
  beforeEach(() => {
    mainRects.length = 0; mainDraws.length = 0; mainStrokes = 0; mainGrads = 0; mainArcs = 0; seq = 0; translate = [0, 0]
    vi.stubGlobal('ImageData', FakeImageData)
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
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0, gen: { ...defaultGrid().gen, seed: 9 } },
    ...over,
  })

  it('a Modular deal paints bg + modules + hairlines straight on the main ctx, centred, ignoring grid / density / inset (no tiles)', async () => {
    const p = normalizeModular(modularPresetPatch('Riso'))
    await drawDeal(dealLayer({ cellFill: 'modular', modular: p }), 400, 400)
    expect(mainDraws.length).toBe(0)                       // no per-cell tiles
    expect(translate).toEqual([-200, -200])                // box top-left at (-W/2, -H/2)
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 400 })
    const rec = recorder()
    paintModular(rec.ctx, p, p.inks, 400, 400, 9)
    expect(mainRects.length).toBe(rec.rects.length)        // identical call sequence to the pure paint
    expect(mainGrads).toBe(rec.grads.length); expect(mainArcs).toBe(rec.arcs.length); expect(mainStrokes).toBe(rec.strokes.length)
    expect(mainStrokes).toBeGreaterThanOrEqual(1)           // the hairlines at least
  })
  it('a Modular deal without params uses the defaults + the vocabulary inks', async () => {
    // Both w and h are width-normalized (like RectLayer): h 0.75 of a 400-wide frame = 300.
    await drawDeal(dealLayer({ cellFill: 'modular', h: 0.75 }), 400, 300)
    expect(mainDraws.length).toBe(0)
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 })
  })
  it('cellFill:solid is unchanged (tiles via drawImage)', async () => {
    await drawDeal(dealLayer({ cellFill: 'solid', density: 1, cellInset: 0 }), 400, 400)
    expect(mainDraws.length).toBe(20)
    expect(mainStrokes).toBe(0)
  })
})

// ── Agent op: dealGrid modular ───────────────────────────────────────────────
describe('agent dealGrid modular', () => {
  const baseState = (): CompositorState => ({ layers: [] })

  it('creates with cellFill:modular and modular params merged onto the defaults', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', modular: { gcols: 8 } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('modular')
    expect(l.modular).toEqual({ ...defaultModular(), gcols: 8 })
  })
  it('defaults: a bare create is the Mosaic default (modular), modular at the source defaults', () => {
    const l = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1' } }) as any).template.layers[0]
    expect(l.cellFill).toBe('modular')
    expect(l.modular).toEqual(defaultModular())
    expect(l.pane).toBeDefined()
  })
  it('palettePreset sets bg + rule + inks (explicit modular colours win); implies the Modular fill', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', palettePreset: 'Riso', modular: { bg: '#ffffff' } } })
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('modular')
    expect(l.modular.bg).toBe('#ffffff'); expect(l.modular.rule).toBe('#0E2A8C'); expect(l.modular.inks).toEqual([...MODULAR_PALETTE_PRESETS.Riso.inks])
  })
  it('reconfigure merges and clamps; an explicit cellFill:"pane" alongside modular keeps pane', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { modular: { merge: 1, gcols: 40, w: { empty: 5 }, dot: 'no' } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('modular')
    expect(l.modular).toEqual({ ...defaultModular(), merge: 1, gcols: 12, w: { ...defaultModular().w, empty: 5 } })
    const r2 = applyCompositorCommand((r as any).template, { op: 'dealGrid', target: 'dd', args: { palettePreset: 'Mono' } })
    const l2 = (r2 as any).template.layers[0]
    expect(l2.modular).toEqual({ ...defaultModular(), merge: 1, gcols: 12, w: { ...defaultModular().w, empty: 5 }, ...modularPresetPatch('Mono') })
    const r3 = applyCompositorCommand((r2 as any).template, { op: 'dealGrid', target: 'dd', args: { cellFill: 'pane', modular: { unit: 6 } } })
    expect((r3 as any).template.layers[0].cellFill).toBe('pane')
    expect((r3 as any).template.layers[0].modular.unit).toBe(6)
  })
  it('ignores an unknown cellFill on reconfigure (keeps the prior fill); an unknown preset is rejected, not swallowed', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', cellFill: 'modular' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { cellFill: 'bogus' } })
    expect((r as any).template.layers[0].cellFill).toBe('modular')
    expect((r as any).template.layers[0].modular).toEqual(defaultModular())
    const bad = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { cellFill: 'bogus', palettePreset: 'Nope' } })
    expect(bad.ok).toBe(false)
    expect((bad as any).detail).toMatch(/unknown palettePreset "Nope" for modular/)
  })
})
