import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PARCEL_PALETTE_PRESETS, PARCEL_PRESET_NAMES, PARCEL_LIMITS, PARCEL_OCTAVE2_SALT, defaultParcel, normalizeParcel, parcelRows,
  parcelSpec, valueNoise2, fbmParcel, parcelBlockMask, parcelClusters, parcelGridLines, parcelInkRuns,
  parcelPresetPatch, parcelPresetOf, paintParcel,
  type ParcelParams, type ParcelCtx, type ParcelCluster, type ParcelRun,
} from '~/lib/compositor/parcel'
import { defaultGrid } from '~/lib/frame/grid'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// Every rule below is the playgrnd Parcel generator's rule, restated as a test.
const P = (over: Partial<ParcelParams> = {}): ParcelParams => ({ ...defaultParcel(), ...over })

// ── Rule A: the seeded spec ──────────────────────────────────────────────────
describe('parcelSpec (rule A)', () => {
  it('ox in [0,43), oy in [0,37), a salt and a SECOND survey seed; deterministic; seeds differ', () => {
    for (const seed of [1, 11, 999]) {
      const s = parcelSpec(seed)
      expect(s.ox).toBeGreaterThanOrEqual(0); expect(s.ox).toBeLessThan(43)
      expect(s.oy).toBeGreaterThanOrEqual(0); expect(s.oy).toBeLessThan(37)
      expect(Number.isInteger(s.salt)).toBe(true)
      expect(Number.isInteger(s.survey)).toBe(true)
      expect(s).toEqual(parcelSpec(seed))
    }
    expect(parcelSpec(1)).not.toEqual(parcelSpec(2))
    expect(parcelSpec(5).survey).not.toBe(parcelSpec(5).salt)
  })
})

// ── Rule B: noise ────────────────────────────────────────────────────────────
describe('fbmParcel / valueNoise2 (rule B)', () => {
  it('fbm == vn(x,y)·.62 + vn(2.17x, 2.17y)·.38 — two octaves, those weights, that lacunarity', () => {
    for (const [x, y, salt] of [[0.3, 0.7, 1], [10.2, 3.9, 9], [-4.5, 2.2, 0], [123.456, 78.9, 4242]] as const) {
      const expected = valueNoise2(x, y, salt) * 0.62 + valueNoise2(x * 2.17, y * 2.17, salt + PARCEL_OCTAVE2_SALT) * 0.38
      expect(fbmParcel(x, y, salt)).toBeCloseTo(expected, 12)
    }
  })
  it('value noise is in [0,1], hits the lattice values exactly at integers, and is smooth (adjacent samples close)', () => {
    for (let i = 0; i < 200; i++) {
      const v = valueNoise2(i * 0.37 - 20, i * 0.53 - 10, 7)
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
    }
    // Smoothstep interpolation: half-way between two lattice points along x is the mean of them.
    const a = valueNoise2(3, 4, 7), b = valueNoise2(4, 4, 7)
    expect(valueNoise2(3.5, 4, 7)).toBeCloseTo((a + b) / 2, 12)
    // Smoothness: a small step moves the value a small amount, far less than the field's range.
    let maxStep = 0
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.01, y = 2.5
      maxStep = Math.max(maxStep, Math.abs(fbmParcel(x + 0.01, y, 3) - fbmParcel(x, y, 3)))
    }
    expect(maxStep).toBeLessThan(0.05)
    // Zero slope AT the lattice (smoothstep's derivative is 0 at 0 and 1).
    expect(Math.abs(valueNoise2(3.001, 4, 7) - valueNoise2(3, 4, 7))).toBeLessThan(1e-4)
  })
  it('is deterministic and salt-keyed', () => {
    expect(fbmParcel(1.3, 2.4, 5)).toBe(fbmParcel(1.3, 2.4, 5))
    let diff = 0
    for (let i = 0; i < 50; i++) if (fbmParcel(i * 0.7, i * 0.3, 5) !== fbmParcel(i * 0.7, i * 0.3, 6)) diff++
    expect(diff).toBeGreaterThan(45)
  })
})

// ── Rule C: the block mask ───────────────────────────────────────────────────
describe('parcelBlockMask (rule C)', () => {
  const gw = 64, gh = 48
  const frac = (m: Uint8Array) => m.reduce((s, v) => s + v, 0) / m.length
  const runBoundaries = (m: Uint8Array) => {
    let n = 0
    for (let v = 0; v < gh; v++) for (let u = 1; u < gw; u++) if (m[v * gw + u] !== m[v * gw + u - 1]) n++
    return n
  }
  it('cover is monotonic (higher cover ⇒ ≥ ink fraction); cover .5 ≈ half-ish; 0 ⇒ ~none, 1 ⇒ ~all', () => {
    for (const seed of [1, 11, 77]) {
      const f = [0, 0.25, 0.5, 0.75, 1].map(cover => frac(parcelBlockMask(P({ cover }), gw, gh, seed)))
      for (let i = 1; i < f.length; i++) expect(f[i]!).toBeGreaterThanOrEqual(f[i - 1]!)
      expect(Math.abs(f[2]! - 0.5)).toBeLessThan(0.2)
      expect(f[0]).toBeLessThan(0.1); expect(f[4]).toBeGreaterThan(0.9)
    }
  })
  it('the threshold rule: cell is ink iff fbm(u·sc+ox, v·sc+oy) > .5 + (.5−cover)·.55 with sc = .2/chunk', () => {
    const p = P({ cover: 0.3, chunk: 1.5 }), seed = 11
    const { ox, oy, salt } = parcelSpec(seed)
    const m = parcelBlockMask(p, gw, gh, seed)
    const sc = 0.2 / p.chunk, th = 0.5 + (0.5 - p.cover) * 0.55
    for (let v = 0; v < gh; v++) for (let u = 0; u < gw; u++) {
      expect(m[v * gw + u]).toBe(fbmParcel(u * sc + ox, v * sc + oy, salt) > th ? 1 : 0)
    }
  })
  it('chunk ↑ ⇒ fewer, larger blobs (fewer run boundaries per row)', () => {
    for (const seed of [1, 11, 77]) {
      const b = [0.5, 1, 2, 3].map(chunk => runBoundaries(parcelBlockMask(P({ chunk }), gw, gh, seed)))
      for (let i = 1; i < b.length; i++) expect(b[i]!).toBeLessThan(b[i - 1]!)
    }
  })
  it('is a coherent field (neighbours agree far more than chance) and deterministic in seed', () => {
    const m = parcelBlockMask(P(), gw, gh, 11)
    let agree = 0, n = 0
    for (let v = 0; v < gh; v++) for (let u = 1; u < gw; u++) { if (m[v * gw + u] === m[v * gw + u - 1]) agree++; n++ }
    // (white noise ⇒ 0.5; at sc = .2 a lattice unit spans 5 cells on the first
    // octave, ~2.3 on the second — coherent but with a grainy edge, ~0.84 here.)
    expect(agree / n).toBeGreaterThan(0.75)
    expect(m).toEqual(parcelBlockMask(P(), gw, gh, 11))
    expect(m).not.toEqual(parcelBlockMask(P(), gw, gh, 12))
  })
  it('rows follow the box aspect: gh = max(4, round(cells · H/W))', () => {
    expect(parcelRows(16, 1200, 800)).toBe(11)
    expect(parcelRows(16, 1000, 1000)).toBe(16)
    expect(parcelRows(16, 1000, 100)).toBe(4)
    expect(parcelRows(16, 1080, 1920)).toBe(28)
  })
})

// ── Rule D: survey clusters ──────────────────────────────────────────────────
describe('parcelClusters (rule D)', () => {
  it('exactly `grids` clusters, sizes 2..7 × 2..6, boxes positioned inside the grid where they fit; deterministic', () => {
    const gw = 16, gh = 11
    for (const seed of [1, 11, 42, 777]) for (const grids of [0, 1, 4, 8]) {
      const cs = parcelClusters(P({ grids }), gw, gh, seed)
      expect(cs.length).toBe(grids)
      for (const c of cs) {
        expect(c.w).toBeGreaterThanOrEqual(2); expect(c.w).toBeLessThanOrEqual(7)
        expect(c.h).toBeGreaterThanOrEqual(2); expect(c.h).toBeLessThanOrEqual(6)
        expect(c.x).toBeGreaterThanOrEqual(0); expect(c.x).toBeLessThanOrEqual(Math.max(0, gw - c.w))
        expect(c.y).toBeGreaterThanOrEqual(0); expect(c.y).toBeLessThanOrEqual(Math.max(0, gh - c.h))
        for (const [a, b] of c.cells) {
          expect(a).toBeGreaterThanOrEqual(c.x); expect(a).toBeLessThan(c.x + c.w); expect(a).toBeLessThan(gw)
          expect(b).toBeGreaterThanOrEqual(c.y); expect(b).toBeLessThan(c.y + c.h); expect(b).toBeLessThan(gh)
        }
      }
      expect(cs).toEqual(parcelClusters(P({ grids }), gw, gh, seed))
    }
    expect(parcelClusters(P(), gw, gh, 1)).not.toEqual(parcelClusters(P(), gw, gh, 2))
  })
  it('all sizes 2..7 and 2..6 occur over many seeds (the ⌊h·6⌋ / ⌊h·5⌋ ranges are fully used)', () => {
    const ws = new Set<number>(), hs = new Set<number>()
    for (let seed = 1; seed <= 60; seed++) for (const c of parcelClusters(P({ grids: 8 }), 40, 40, seed)) { ws.add(c.w); hs.add(c.h) }
    expect([...ws].sort()).toEqual([2, 3, 4, 5, 6, 7]); expect([...hs].sort()).toEqual([2, 3, 4, 5, 6])
  })
  it('~78% of each box is included (ragged), tolerant over many clusters', () => {
    let inc = 0, tot = 0
    for (let seed = 1; seed <= 80; seed++) for (const c of parcelClusters(P({ grids: 8 }), 40, 40, seed)) { inc += c.cells.length; tot += c.w * c.h }
    expect(Math.abs(inc / tot - 0.78)).toBeLessThan(0.03)
  })
})

// ── Rule E: grid lines ───────────────────────────────────────────────────────
const cluster = (cells: [number, number][]): ParcelCluster => {
  const xs = cells.map(c => c[0]), ys = cells.map(c => c[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1, cells }
}
const sortRuns = (r: ParcelRun[]) => [...r].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3])
/** Expand runs back into unit edges: 'H:a,b' = horizontal unit edge from (a,b) to (a+1,b); 'V:a,b' = vertical (a,b)→(a,b+1). */
function unitEdges(runs: ParcelRun[]): string[] {
  const out: string[] = []
  for (const [x0, y0, x1, y1] of runs) {
    if (y0 === y1) for (let a = x0; a < x1; a++) out.push(`H:${a},${y0}`)
    else if (x0 === x1) for (let b = y0; b < y1; b++) out.push(`V:${x0},${b}`)
    else throw new Error(`diagonal run ${[x0, y0, x1, y1]}`)
  }
  return out
}

describe('parcelGridLines (rule E)', () => {
  it('a 2×2 fully-included cluster is the FULL lattice: interior borders present, each drawn once; 12 unit edges merged into 3 H + 3 V runs', () => {
    const runs = parcelGridLines([cluster([[3, 5], [4, 5], [3, 6], [4, 6]])])
    expect(runs.length).toBe(6)
    expect(sortRuns(runs)).toEqual(sortRuns([
      [3, 5, 5, 5], [3, 6, 5, 6], [3, 7, 5, 7],     // H rows 5, 6 (interior), 7 — each a 2-cell run
      [3, 5, 3, 7], [4, 5, 4, 7], [5, 5, 5, 7],     // V columns 3, 4 (interior), 5 — each a 2-cell run
    ]))
    const edges = unitEdges(runs)
    expect(edges.length).toBe(12)
    expect(new Set(edges).size).toBe(12)                     // no unit edge twice
    expect(edges).toContain('H:3,6'); expect(edges).toContain('V:4,5')   // the interior borders ARE there
  })
  it('DEDUPE: the border shared by two horizontally adjacent cells appears exactly once — not zero, not twice', () => {
    const runs = parcelGridLines([cluster([[0, 0], [1, 0]])])
    const edges = unitEdges(runs)
    expect(edges.filter(e => e === 'V:1,0').length).toBe(1)
    // 2 cells share 1 edge: 8 borders − 1 duplicate = 7 unit edges; H runs merge to 2, V stays 3.
    expect(edges.length).toBe(7)
    expect(sortRuns(runs)).toEqual(sortRuns([[0, 0, 2, 0], [0, 1, 2, 1], [0, 0, 0, 1], [1, 0, 1, 1], [2, 0, 2, 1]]))
  })
  it('DEDUPE across clusters too (two clusters touching share one border), and a single Set means a shared edge is never removed', () => {
    const runs = parcelGridLines([cluster([[0, 0]]), cluster([[0, 1]])])
    const edges = unitEdges(runs)
    expect(edges.filter(e => e === 'H:0,1').length).toBe(1)
    expect(edges.length).toBe(7)
  })
  it('runs are merged: consecutive unit edges become one run; a gap splits them', () => {
    // Three cells in a row on y=2, then a gap, then one more.
    const runs = parcelGridLines([cluster([[1, 2], [2, 2], [3, 2], [5, 2]])])
    const hTop = runs.filter(r => r[1] === 2 && r[3] === 2)
    expect(sortRuns(hTop)).toEqual([[1, 2, 4, 2], [5, 2, 6, 2]])
    const hBot = runs.filter(r => r[1] === 3 && r[3] === 3)
    expect(sortRuns(hBot)).toEqual([[1, 3, 4, 3], [5, 3, 6, 3]])
    // Verticals: x=1..4 and x=5,6, each one cell tall.
    const vs = runs.filter(r => r[0] === r[2])
    expect(sortRuns(vs)).toEqual([[1, 2, 1, 3], [2, 2, 2, 3], [3, 2, 3, 3], [4, 2, 4, 3], [5, 2, 5, 3], [6, 2, 6, 3]])
  })
  it('every unit edge of every run is a border of an included cell; every border of every included cell is covered exactly once (real clusters)', () => {
    for (const seed of [1, 11, 42]) {
      const cs = parcelClusters(P({ grids: 8 }), 16, 11, seed)
      const runs = parcelGridLines(cs)
      const edges = unitEdges(runs)
      const want = new Set<string>()
      for (const c of cs) for (const [a, b] of c.cells) { want.add(`H:${a},${b}`); want.add(`H:${a},${b + 1}`); want.add(`V:${a},${b}`); want.add(`V:${a + 1},${b}`) }
      expect(new Set(edges).size).toBe(edges.length)         // once each
      expect(new Set(edges)).toEqual(want)                   // exactly the borders, no more, no less
      // Merged: no two runs on the same line are adjacent (they would have been one run).
      for (const r of runs) for (const q of runs) {
        if (r === q) continue
        if (r[1] === r[3] && q[1] === q[3] && r[1] === q[1]) expect(r[2] === q[0]).toBe(false)
        if (r[0] === r[2] && q[0] === q[2] && r[0] === q[0]) expect(r[3] === q[1]).toBe(false)
      }
    }
  })
  it('no clusters ⇒ no runs', () => {
    expect(parcelGridLines([])).toEqual([])
    expect(parcelGridLines(parcelClusters(P({ grids: 0 }), 16, 11, 1))).toEqual([])
  })
})

// ── Rule F: ink runs ─────────────────────────────────────────────────────────
describe('parcelInkRuns (rule F)', () => {
  it('run-length rows of the mask, [u0,u1) per run, in raster order', () => {
    const gw = 6, gh = 2
    const m = new Uint8Array([1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1])
    expect(parcelInkRuns(m, gw, gh)).toEqual([{ v: 0, u0: 0, u1: 2 }, { v: 0, u0: 3, u1: 4 }, { v: 0, u0: 5, u1: 6 }, { v: 1, u0: 3, u1: 6 }])
    expect(parcelInkRuns(new Uint8Array(12), gw, gh)).toEqual([])
    expect(parcelInkRuns(new Uint8Array(12).fill(1), gw, gh)).toEqual([{ v: 0, u0: 0, u1: 6 }, { v: 1, u0: 0, u1: 6 }])
  })
})

// ── Params / presets ─────────────────────────────────────────────────────────
describe('params and presets', () => {
  it('defaults are the source defaults, first preset colours', () => {
    expect(defaultParcel()).toEqual({ cells: 16, cover: 0.5, chunk: 1, grids: 4, blend: 'multiply', ground: '#D9D9D4', ink: '#DFF23C', hairline: '#98988F' })
    expect(PARCEL_LIMITS.cells).toEqual([8, 40]); expect(PARCEL_LIMITS.grids).toEqual([0, 8])
  })
  it('normalizeParcel clamps and falls back per field; blend must be multiply|normal; colours must be hex', () => {
    const n = normalizeParcel({ cells: 99, cover: 2, chunk: 0.1, grids: -3, blend: 'screen', ground: 'red', ink: '#123456', hairline: 7 })
    expect(n).toEqual({ ...defaultParcel(), cells: 40, cover: 1, chunk: 0.5, grids: 0, ink: '#123456' })
    expect(normalizeParcel({ blend: 'normal', cells: 12.4 }).blend).toBe('normal')
    expect(normalizeParcel({ cells: 12.4 }).cells).toBe(12)
    expect(normalizeParcel(undefined)).toEqual(defaultParcel())
    expect(normalizeParcel({ cover: 0.9 }, P({ cells: 20 }))).toEqual(P({ cells: 20, cover: 0.9 }))
  })
  it('the 6 presets carry the source triples in order; a preset patch round-trips through parcelPresetOf', () => {
    expect(PARCEL_PRESET_NAMES).toEqual(['Lime on grey', 'Blue on cream', 'Acid on black', 'Orange on cream', 'Cyan on stone', 'Blue on olive'])
    const triples = [
      ['#D9D9D4', '#DFF23C', '#98988F'], ['#EFE9DC', '#1B3FA8', '#8A857B'], ['#141414', '#C6FF3D', '#5A5A52'],
      ['#F2EDE4', '#F0480F', '#9A948A'], ['#E8E4DC', '#12B9DC', '#8F948C'], ['#DCE2AA', '#2B2BE0', '#94997F'],
    ]
    PARCEL_PRESET_NAMES.forEach((name, i) => {
      const p = PARCEL_PALETTE_PRESETS[name]
      expect([p.ground, p.ink, p.hairline]).toEqual(triples[i])
      expect(parcelPresetOf(normalizeParcel(parcelPresetPatch(name)))).toBe(name)
    })
    expect(parcelPresetOf(defaultParcel())).toBe('Lime on grey')
    expect(parcelPresetOf(P({ ink: '#000000' }))).toBe(null)
  })
})

// ── Headless render: rule F ──────────────────────────────────────────────────
type Rect = { x: number; y: number; w: number; h: number; style: unknown; op: string }
type Stroke = { style: unknown; lineWidth: number; op: string; segs: [number, number, number, number][] }
function recorder(initialOp = 'source-over') {
  const rects: Rect[] = [], strokes: Stroke[] = []
  let path: [number, number, number, number][] = [], pen: [number, number] | null = null
  const ctx = {
    fillStyle: '' as unknown, strokeStyle: '' as unknown, lineWidth: 1, globalCompositeOperation: initialOp,
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, style: ctx.fillStyle, op: ctx.globalCompositeOperation }) },
    beginPath() { path = []; pen = null },
    moveTo(x: number, y: number) { pen = [x, y] },
    lineTo(x: number, y: number) { if (pen) path.push([pen[0], pen[1], x, y]); pen = [x, y] },
    stroke() { strokes.push({ style: ctx.strokeStyle, lineWidth: ctx.lineWidth, op: ctx.globalCompositeOperation, segs: path.slice() }) },
  }
  return { ctx: ctx as unknown as ParcelCtx, rects, strokes, raw: ctx }
}

describe('paintParcel (rule F, headless)', () => {
  const W = 1200, H = 800

  it('ground first over the whole box; ink rects cell-snapped, only where the mask is ink, flush; then ONE multiplied hairline stroke on the half-pixel; op restored', () => {
    for (const seed of [11, 23, 101]) {
      const p = P()
      const rec = recorder()
      const layout = paintParcel(rec.ctx, p, W, H, seed)
      const { gw, gh, cw, ch, mask, lines } = layout
      expect(gw).toBe(16); expect(gh).toBe(parcelRows(16, W, H))
      // 1. ground
      expect(rec.rects[0]).toMatchObject({ x: 0, y: 0, w: W, h: H, style: p.ground, op: 'source-over' })
      // 2. ink runs: one rect per run, cell-snapped edges, every covered cell ink, in raster order
      const runs = parcelInkRuns(mask, gw, gh)
      expect(rec.rects.length).toBe(1 + runs.length)
      runs.forEach((r, i) => {
        const rect = rec.rects[1 + i]!
        expect(rect.style).toBe(p.ink); expect(rect.op).toBe('source-over')
        expect(rect).toMatchObject({ x: Math.round(r.u0 * cw), y: Math.round(r.v * ch), w: Math.round(r.u1 * cw) - Math.round(r.u0 * cw), h: Math.round((r.v + 1) * ch) - Math.round(r.v * ch) })
        for (let u = r.u0; u < r.u1; u++) expect(mask[r.v * gw + u]).toBe(1)
      })
      // Every ink cell is covered by exactly one run (flush: nothing missing, nothing doubled).
      const covered = new Uint8Array(gw * gh)
      for (const r of runs) for (let u = r.u0; u < r.u1; u++) covered[r.v * gw + u]++
      for (let i = 0; i < mask.length; i++) expect(covered[i]).toBe(mask[i])
      // 3. hairlines: one stroke, hairline colour, 1px, MULTIPLY, endpoints at round(·)+.5, one seg per run
      expect(rec.strokes.length).toBe(1)
      const s = rec.strokes[0]!
      expect(s.style).toBe(p.hairline); expect(s.lineWidth).toBe(1); expect(s.op).toBe('multiply')
      expect(s.segs).toEqual(lines.map(([x0, y0, x1, y1]) => [Math.round(x0 * cw) + 0.5, Math.round(y0 * ch) + 0.5, Math.round(x1 * cw) + 0.5, Math.round(y1 * ch) + 0.5]))
      expect(lines.length).toBeGreaterThan(0)
      // 4. composite op back to source-over
      expect(rec.raw.globalCompositeOperation).toBe('source-over')
    }
  })
  it('blend "normal" strokes the hairlines with source-over; the op is left as found either way', () => {
    const a = recorder(); paintParcel(a.ctx, P({ blend: 'normal' }), W, H, 11)
    expect(a.strokes[0]!.op).toBe('source-over'); expect(a.raw.globalCompositeOperation).toBe('source-over')
    const b = recorder('screen'); paintParcel(b.ctx, P(), W, H, 11)
    expect(b.strokes[0]!.op).toBe('multiply'); expect(b.raw.globalCompositeOperation).toBe('screen')
  })
  it('the composition is two-tone: ground + ink only, every cell one or the other (no third fill)', () => {
    const rec = recorder(); paintParcel(rec.ctx, P(), W, H, 11)
    const styles = new Set(rec.rects.map(r => r.style))
    expect(styles).toEqual(new Set([P().ground, P().ink]))
  })
  it('grids 0 ⇒ an empty hairline path (no segments); cover 1 ⇒ every row one full-width ink run', () => {
    const a = recorder(); paintParcel(a.ctx, P({ grids: 0 }), W, H, 11)
    expect(a.strokes.length).toBe(1); expect(a.strokes[0]!.segs).toEqual([])
    const b = recorder(); const l = paintParcel(b.ctx, P({ cover: 1 }), W, H, 11)
    expect(b.rects.length).toBe(1 + l.gh)
    for (let v = 0; v < l.gh; v++) expect(b.rects[1 + v]).toMatchObject({ x: 0, w: W })
  })
})

// ── The deal branch routes cellFill:'parcel' to paintParcel on the REAL ctx ──
describe('deal layer render with cellFill:parcel (headless)', () => {
  const mainRects: { x: number; y: number; w: number; h: number }[] = []
  const mainDraws: number[] = []
  const mainStrokeOps: string[] = []
  let translate: [number, number] = [0, 0]
  function recordingCtx(name: string) {
    const c = {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({}), setTransform() {}, save() {}, restore() {},
      translate(x: number, y: number) { if (name === 'main') translate = [x, y] }, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() { if (name === 'main') mainStrokeOps.push(c.globalCompositeOperation) }, clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) { if (name === 'main') mainRects.push({ x, y, w, h }) },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return { addColorStop() {} } },
      createLinearGradient() { return { addColorStop() {} } },
      createPattern() { return {} },
      drawImage() { if (name === 'main') mainDraws.push(1) },
    }
    return c as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  class FakeImageData {
    data: Uint8ClampedArray; width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w * h) * 4) }
  }
  beforeEach(() => {
    mainRects.length = 0; mainDraws.length = 0; mainStrokeOps.length = 0; seq = 0; translate = [0, 0]
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

  it('a Parcel deal paints ground + ink runs + a multiplied hairline stroke straight on the main ctx, centred, ignoring grid / density / inset (no tiles)', async () => {
    await drawDeal(dealLayer({ cellFill: 'parcel', parcel: P() }), 400, 400)
    expect(mainDraws.length).toBe(0)                       // no per-cell tiles
    expect(translate).toEqual([-200, -200])                // box top-left at (-W/2, -H/2)
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 400 })
    const rec = recorder()
    paintParcel(rec.ctx, P(), 400, 400, 9)
    expect(mainRects.length).toBe(rec.rects.length)        // identical call sequence to the pure paint
    expect(mainStrokeOps).toEqual(['multiply'])
  })
  it('a Parcel deal without params uses the defaults', async () => {
    await drawDeal(dealLayer({ cellFill: 'parcel', h: 0.75 }), 400, 300)
    expect(mainDraws.length).toBe(0)
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 })
    expect(mainStrokeOps).toEqual(['multiply'])
  })
  it('cellFill:solid is unchanged (tiles via drawImage)', async () => {
    await drawDeal(dealLayer({ cellFill: 'solid', density: 1, cellInset: 0 }), 400, 400)
    expect(mainDraws.length).toBe(20)
    expect(mainStrokeOps.length).toBe(0)
  })
})

// ── Agent op: dealGrid parcel ────────────────────────────────────────────────
describe('agent dealGrid parcel', () => {
  const baseState = (): CompositorState => ({ layers: [] })

  it('creates with cellFill:parcel and parcel params merged onto the defaults', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', parcel: { cells: 24 } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('parcel')
    expect(l.parcel).toEqual({ ...defaultParcel(), cells: 24 })
  })
  it('defaults: a bare create is the Mosaic default (modular); parcel at the source defaults', () => {
    const l = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1' } }) as any).template.layers[0]
    expect(l.cellFill).toBe('modular')
    expect(l.parcel).toEqual(defaultParcel())
    expect(l.modular).toBeDefined(); expect(l.pane).toBeDefined()
  })
  it('a Parcel palettePreset sets the three colours (explicit parcel colours win) and implies the Parcel fill', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', palettePreset: 'Acid on black', parcel: { ink: '#ffffff' } } })
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('parcel')
    expect(l.parcel.ground).toBe('#141414'); expect(l.parcel.ink).toBe('#ffffff'); expect(l.parcel.hairline).toBe('#5A5A52')
    // A Modular preset name still means Modular.
    const m = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd2', palettePreset: 'Riso' } }) as any).template.layers[0]
    expect(m.cellFill).toBe('modular')
  })
  it('reconfigure merges and clamps; an explicit cellFill:"modular" alongside parcel keeps modular', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { parcel: { cover: 0.8, cells: 99, blend: 'normal', chunk: 'no' } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('parcel')
    expect(l.parcel).toEqual({ ...defaultParcel(), cover: 0.8, cells: 40, blend: 'normal' })
    const r2 = applyCompositorCommand((r as any).template, { op: 'dealGrid', target: 'dd', args: { palettePreset: 'Blue on olive' } })
    expect((r2 as any).template.layers[0].parcel).toEqual({ ...defaultParcel(), cover: 0.8, cells: 40, blend: 'normal', ...parcelPresetPatch('Blue on olive') })
    const r3 = applyCompositorCommand((r2 as any).template, { op: 'dealGrid', target: 'dd', args: { cellFill: 'modular', parcel: { grids: 6 } } })
    expect((r3 as any).template.layers[0].cellFill).toBe('modular')
    expect((r3 as any).template.layers[0].parcel.grids).toBe(6)
    // And the other way: modular args alongside an explicit "parcel" keep parcel.
    const r4 = applyCompositorCommand((r3 as any).template, { op: 'dealGrid', target: 'dd', args: { cellFill: 'parcel', modular: { gcols: 8 } } })
    expect((r4 as any).template.layers[0].cellFill).toBe('parcel')
    expect((r4 as any).template.layers[0].modular.gcols).toBe(8)
  })
  it('sending parcel:{} alone implies cellFill:"parcel" on create and reconfigure', () => {
    const l = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', parcel: {} } }) as any).template.layers[0]
    expect(l.cellFill).toBe('parcel'); expect(l.parcel).toEqual(defaultParcel())
    const s = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', cellFill: 'pane' } }) as any).template
    const r = applyCompositorCommand(s, { op: 'dealGrid', target: 'dd', args: { parcel: {} } })
    expect((r as any).template.layers[0].cellFill).toBe('parcel')
  })
})
