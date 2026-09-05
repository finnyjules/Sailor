import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PANE_DIRS, PANE_RAMP_STEPS, defaultPane, normalizePane, paneWeights, paneRegions, paneCellPick,
  paneCellGradient, paneRampStops, paneInksFromVocab, hexToHsl, hslToHex, type PaneParams,
} from '~/lib/compositor/pane'
import { DEAL_VOCABS } from '~/lib/compositor/dealVocab'
import { defaultGrid } from '~/lib/frame/grid'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// Every rule below is the playgrnd Pane generator's rule, restated as a test.
const P = (over: Partial<PaneParams> = {}): PaneParams => ({ ...defaultPane(), ...over })

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const dist = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ── Rule 1: weights ──────────────────────────────────────────────────────────
describe('paneWeights (rule 1)', () => {
  it('vary=0 ⇒ every share equal', () => {
    const w = paneWeights(5, 0, 7, 'rowh')
    for (const v of w) expect(v).toBeCloseTo(1 / 5, 12)
  })
  it('sums to 1, is deterministic, and vary>0 makes shares uneven', () => {
    const w1 = paneWeights(6, 0.55, 42, 'colw:2'), w2 = paneWeights(6, 0.55, 42, 'colw:2')
    expect(w1).toEqual(w2)
    expect(w1.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12)
    expect(Math.max(...w1) - Math.min(...w1)).toBeGreaterThan(0.01)
    // A different salt is a different stream (row widths independent per row).
    expect(paneWeights(6, 0.55, 42, 'colw:3')).not.toEqual(w1)
  })
})

// ── Rules 2–3: the row masonry ───────────────────────────────────────────────
describe('paneRegions (rules 2–3)', () => {
  const W = 800, H = 500
  const byRow = (rs: ReturnType<typeof paneRegions>) => {
    const m = new Map<number, typeof rs>()
    for (const r of rs) { if (!m.has(r.j)) m.set(r.j, []); m.get(r.j)!.push(r) }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1])
  }

  it('rows stack exactly to the box height (last row snaps) and every row spans exactly the box width (last cell snaps)', () => {
    for (const seed of [1, 9, 42, 777]) {
      const rows = byRow(paneRegions(P(), W, H, seed))
      expect(rows.length).toBe(3)
      let y = 0
      for (const row of rows) {
        expect(row[0]!.y).toBe(y)
        y += row[0]!.h
        for (const r of row) expect(r.y).toBe(row[0]!.y)
        expect(row[0]!.x).toBe(0)
        expect(row[row.length - 1]!.x + row[row.length - 1]!.w).toBe(W)
      }
      expect(y).toBe(H)
    }
  })

  it('cells within a row are FLUSH (no gap, no overlap): each starts where the previous ended', () => {
    for (const seed of [1, 9, 42, 777]) {
      for (const row of byRow(paneRegions(P(), W, H, seed))) {
        for (let i = 1; i < row.length; i++) expect(row[i]!.x).toBe(row[i - 1]!.x + row[i - 1]!.w)
        for (const r of row) { expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0) }
      }
    }
  })

  it('the cell COUNT differs across rows at the defaults (what stops the rows lining up), within 0.55..1.45 × cells', () => {
    let differed = 0
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const counts = byRow(paneRegions(P(), W, H, seed)).map(r => r.length)
      for (const c of counts) { expect(c).toBeGreaterThanOrEqual(3); expect(c).toBeLessThanOrEqual(9) }
      if (new Set(counts).size > 1) differed++
    }
    expect(differed).toBeGreaterThanOrEqual(6)
  })

  it('is deterministic in seed and a different seed changes the layout', () => {
    const a = paneRegions(P(), W, H, 5), b = paneRegions(P(), W, H, 5), c = paneRegions(P(), W, H, 6)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c))
  })

  it('vary=0 ⇒ equal row heights (up to rounding) and equal widths within a row', () => {
    const rows = byRow(paneRegions(P({ vary: 0, rows: 4 }), 800, 400, 3))
    for (const row of rows) {
      expect(Math.abs(row[0]!.h - 100)).toBeLessThanOrEqual(1)
      const ws = row.map(r => r.w)
      expect(Math.max(...ws) - Math.min(...ws)).toBeLessThanOrEqual(1)
    }
  })

  it('honours rows and never overlaps across rows', () => {
    const rs = paneRegions(P({ rows: 6 }), W, H, 11)
    const rows = byRow(rs)
    expect(rows.length).toBe(6)
    for (let j = 1; j < rows.length; j++) expect(rows[j]![0]!.y).toBe(rows[j - 1]![0]!.y + rows[j - 1]![0]!.h)
  })
})

// ── Rule 4: direction ────────────────────────────────────────────────────────
describe('paneCellPick direction (rule 4)', () => {
  const N = 40
  const isDiag = (k: number) => (k & 1) === 1

  it('every direction is one of the 8 corner/edge vectors; even = flat, odd = diagonal', () => {
    expect(PANE_DIRS.length).toBe(8)
    for (let k = 0; k < 8; k++) {
      const [x0, y0, x1, y1] = PANE_DIRS[k]!
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
      if (isDiag(k)) { expect(dx).toBe(1); expect(dy).toBe(1) } else { expect(dx + dy).toBe(1) }
      for (const v of [x0, y0, x1, y1]) expect([0, 1]).toContain(v)
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const pk = paneCellPick(P(), 7, 3, i, j)
      expect(PANE_DIRS).toContain(pk.dir)
      expect(pk.dir).toBe(PANE_DIRS[pk.dirIndex])
    }
  })

  it('the fraction of diagonal cells ≈ diag', () => {
    for (const diag of [0.2, 0.45, 0.8]) {
      let d = 0
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (isDiag(paneCellPick(P({ diag }), 7, 5, i, j).dirIndex)) d++
      expect(Math.abs(d / (N * N) - diag)).toBeLessThan(0.05)
    }
  })

  it('diag=0 ⇒ all flats; diag=1 ⇒ all diagonals; all 4 members of each family appear', () => {
    const flats = new Set<number>(), diags = new Set<number>()
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const f = paneCellPick(P({ diag: 0 }), 7, 5, i, j).dirIndex
      const d = paneCellPick(P({ diag: 1 }), 7, 5, i, j).dirIndex
      expect(isDiag(f)).toBe(false); expect(isDiag(d)).toBe(true)
      flats.add(f); diags.add(d)
    }
    expect([...flats].sort()).toEqual([0, 2, 4, 6])
    expect([...diags].sort()).toEqual([1, 3, 5, 7])
  })
})

// ── Rule 5: inks by palette distance ─────────────────────────────────────────
describe('paneCellPick inks (rule 5)', () => {
  const N = 30
  it('spread=0 ⇒ the two inks are palette NEIGHBOURS (b = a+1 mod n)', () => {
    for (const n of [3, 7, 8]) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const { a, b } = paneCellPick(P({ spread: 0 }), n, 2, i, j)
      expect(b).toBe((a + 1) % n)
    }
  })
  it('spread=1 ⇒ steps reach beyond 1 (up to n−1), never 0; a and b always differ; indices within the palette', () => {
    const n = 8
    const steps = new Set<number>()
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const { a, b } = paneCellPick(P({ spread: 1 }), n, 2, i, j)
      expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(n)
      expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(n)
      expect(a).not.toBe(b)
      steps.add(((b - a) % n + n) % n)
    }
    expect(Math.max(...steps)).toBe(n - 1)
    expect(steps.size).toBe(n - 1)
  })
  it('the step never exceeds 1 + spread·(n−2) rounded', () => {
    const n = 8, spread = 0.55, reach = Math.round(1 + spread * (n - 2))
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const { a, b } = paneCellPick(P({ spread }), n, 4, i, j)
      const step = ((b - a) % n + n) % n
      expect(step).toBeGreaterThanOrEqual(1); expect(step).toBeLessThanOrEqual(reach)
    }
  })
})

// ── Rule 6: soft ─────────────────────────────────────────────────────────────
describe('paneCellPick soft (rule 6)', () => {
  const N = 30
  it('soft=1 ⇒ p0=0 and p1=1 (the whole cell is the ramp)', () => {
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const { p0, p1 } = paneCellPick(P({ soft: 1 }), 7, 1, i, j)
      expect(p0).toBe(0); expect(p1).toBe(1)
    }
  })
  it('soft=0 ⇒ p0≤0.49, p1≥0.51: the inks meet on a hard line near the middle (band ≤ 0.02… plus rounding slack)', () => {
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const { p0, p1 } = paneCellPick(P({ soft: 0 }), 7, 1, i, j)
      expect(p0).toBeLessThanOrEqual(0.49); expect(p0).toBeGreaterThan(0.15)
      expect(p1).toBeGreaterThanOrEqual(0.51); expect(p1).toBeLessThan(0.85)
      expect(p1 - p0).toBeLessThan(0.7)
    }
  })
  it('the blend band shrinks as soft falls; p0 and p1 are independent streams', () => {
    let band1 = 0, band0 = 0
    let oneClamped = 0
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = paneCellPick(P({ soft: 0.85 }), 7, 1, i, j), b = paneCellPick(P({ soft: 0.3 }), 7, 1, i, j)
      band1 += a.p1 - a.p0; band0 += b.p1 - b.p0
      // At soft=0 each side pins (0.49 / 0.51) when its own hash is high. If p0 and
      // p1 rode ONE stream they would always pin together; independent streams pin
      // one side alone a good share of the time.
      const z = paneCellPick(P({ soft: 0 }), 7, 1, i, j)
      if ((z.p0 === 0.49) !== (z.p1 === 0.51)) oneClamped++
    }
    expect(band1).toBeGreaterThan(band0)
    expect(oneClamped).toBeGreaterThan(N * N / 4)
  })
})

// ── Rule 7: the short-arc HSL ramp ───────────────────────────────────────────
describe('paneRampStops (rule 7)', () => {
  it('hex ↔ hsl round-trips', () => {
    for (const hex of ['#ff6259', '#0e6bff', '#f2ff5a', '#23123c', '#ffffff', '#000000', '#808080']) {
      const [h, s, l] = hexToHsl(hex)
      expect(hslToHex(h, s, l)).toBe(hex)
    }
  })

  it('stops are ordered, endpoints are the inks, exactly 8 interior stops (+ p0/p1 pins when inside)', () => {
    const full = paneRampStops('#ff6259', '#0e6bff', 0, 1)
    expect(full.length).toBe(2 + (PANE_RAMP_STEPS - 1))
    expect(full[0]).toEqual({ offset: 0, color: '#ff6259' })
    expect(full[full.length - 1]).toEqual({ offset: 1, color: '#0e6bff' })
    const pinned = paneRampStops('#ff6259', '#0e6bff', 0.3, 0.7)
    expect(pinned.length).toBe(4 + (PANE_RAMP_STEPS - 1))
    expect(pinned[1]).toEqual({ offset: 0.3, color: '#ff6259' })
    expect(pinned[pinned.length - 2]).toEqual({ offset: 0.7, color: '#0e6bff' })
    for (const s of [full, pinned]) for (let k = 1; k < s.length; k++) expect(s[k]!.offset).toBeGreaterThanOrEqual(s[k - 1]!.offset)
    // Interior stops sit at p0 + (p1-p0)·k/8.
    for (let k = 1; k < PANE_RAMP_STEPS; k++) expect(pinned[1 + k]!.offset).toBeCloseTo(0.3 + 0.4 * (k / 8), 12)
  })

  it('walks the SHORT arc: hue 350 → 10 passes through 0 (red), not through 180 (cyan)', () => {
    const a = hslToHex(350, 1, 0.5), b = hslToHex(10, 1, 0.5)
    const stops = paneRampStops(a, b, 0, 1)
    const mid = stops[Math.floor(stops.length / 2)]!
    const [h] = hexToHsl(mid.color)
    // near 0/360, never near 180
    expect(Math.min(h, 360 - h)).toBeLessThan(15)
  })

  it('an achromatic ink borrows the partner\'s hue (no spin to red)', () => {
    // White's stored hue is 0 (red); without the guard the walk from blue (~217°)
    // to 0° would sweep through magenta. With it every chromatic interior stop
    // stays on blue's hue (8-bit rounding jitters the hue of very pale stops, so
    // only stops with real saturation are checked, with a few degrees of slack).
    const hueOf = (hex: string) => hexToHsl(hex)[0]
    const stops = paneRampStops('#0e6bff', '#ffffff', 0, 1) // blue → white
    let checked = 0
    for (const s of stops.slice(1, -1)) {
      const [h, sat] = hexToHsl(s.color)
      if (sat > 0.3) { expect(Math.abs(h - hueOf('#0e6bff'))).toBeLessThan(5); checked++ }
    }
    expect(checked).toBeGreaterThan(3)
    const grey = paneRampStops('#808080', '#ff6259', 0, 1) // grey → coral
    checked = 0
    for (const s of grey.slice(1, -1)) {
      const [h, sat] = hexToHsl(s.color)
      if (sat > 0.3) { expect(Math.abs(h - hueOf('#ff6259'))).toBeLessThan(5); checked++ }
    }
    expect(checked).toBeGreaterThan(3)
  })

  it('a middle stop is NOT the naive sRGB midpoint (proves the hue walk ran, not a straight lerp)', () => {
    const stops = paneRampStops('#ff6259', '#0e6bff', 0, 1) // coral → blue: a straight chord goes grey
    const A = rgb('#ff6259'), B = rgb('#0e6bff')
    const mid = rgb(stops[Math.floor(stops.length / 2)]!.color)
    const chord: [number, number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]
    expect(dist(mid, chord)).toBeGreaterThan(40)
    // …and the middle keeps its saturation (electric, not muddy).
    expect(hexToHsl(stops[Math.floor(stops.length / 2)]!.color)[1]).toBeGreaterThan(0.9)
  })

  it('walks in HSL specifically (not OKLCH): the middle stop is the linear HSL midpoint, hue along the short arc', () => {
    // Pins the colour SPACE. An OKLCH walk also passes the chord/saturation tests above,
    // but its midpoint lands on a different HSL triple — this catches that substitution.
    const stops = paneRampStops('#ff6259', '#0e6bff', 0, 1)
    const A = hexToHsl('#ff6259'), B = hexToHsl('#0e6bff')
    let dh = B[0] - A[0]
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360
    const [h, s, l] = hexToHsl(stops[Math.floor(stops.length / 2)]!.color)
    const expectH = (((A[0] + dh / 2) % 360) + 360) % 360
    const hueDiff = Math.min(Math.abs(h - expectH), 360 - Math.abs(h - expectH))
    expect(hueDiff).toBeLessThan(1.5)                        // hex rounding only
    expect(Math.abs(s - (A[1] + B[1]) / 2)).toBeLessThan(0.02)
    expect(Math.abs(l - (A[2] + B[2]) / 2)).toBeLessThan(0.02)
  })
})

// ── The whole cell ───────────────────────────────────────────────────────────
describe('paneCellGradient', () => {
  const pal = ['#0e6bff', '#ff6259', '#f2ff5a', '#54f4cf', '#ff99f7', '#96b4ff', '#23123c']
  it('is deterministic, returns a PANE_DIRS vector in cell fractions, inks from the palette', () => {
    for (let i = 0; i < 12; i++) for (let j = 0; j < 4; j++) {
      const g = paneCellGradient(P(), pal, 9, i, j)
      expect(JSON.stringify(g)).toBe(JSON.stringify(paneCellGradient(P(), pal, 9, i, j)))
      expect(g.type).toBe('linear')
      expect(PANE_DIRS.some(d => d[0] === g.x0 && d[1] === g.y0 && d[2] === g.x1 && d[3] === g.y1)).toBe(true)
      expect(pal).toContain(g.stops[0]!.color)
      expect(pal).toContain(g.stops[g.stops.length - 1]!.color)
      expect(g.stops[0]!.color).not.toBe(g.stops[g.stops.length - 1]!.color)
    }
  })
  it('never throws on an empty palette (graceful fallback pair)', () => {
    const g = paneCellGradient(P(), [], 1, 0, 0)
    expect(g.stops.length).toBeGreaterThanOrEqual(2)
  })
  it('paneInksFromVocab gives the ORDERED solids of every vocabulary (≥ 5 inks)', () => {
    for (const v of DEAL_VOCABS) {
      const inks = paneInksFromVocab(v)
      expect(inks.length).toBeGreaterThanOrEqual(5)
      for (const c of inks) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
  it('normalizePane clamps and falls back per field', () => {
    expect(normalizePane({ rows: 99, cells: -3, vary: 2, diag: 'x', soft: null, spread: 0.2 }))
      .toEqual({ rows: 8, cells: 1, vary: 1, diag: 0.45, soft: 0.85, spread: 0.2 })
    expect(normalizePane(undefined)).toEqual(defaultPane())
  })
})

// ── Headless render: the deal branch paints Pane's own masonry ──────────────
describe('deal layer render with cellFill:pane (headless)', () => {
  // Recording ctx + document.createElement stub, mirroring deal-layer.unit.spec.ts.
  // Pane builds ONE canvas linear gradient per region directly on the MAIN ctx
  // (no per-cell tile) with endpoints on the cell's corners/edges, then fillRects.
  type Grad = { x0: number; y0: number; x1: number; y1: number; stops: number }
  const mainGrads: Grad[] = []
  const mainFills: { x: number; y: number; w: number; h: number; grad: Grad | null }[] = []
  const mainDraws: number[] = []
  let offGrads = 0
  function recordingCtx(name: string) {
    let fillStyle: unknown = ''
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      get fillStyle() { return fillStyle }, set fillStyle(v: unknown) { fillStyle = v },
      strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({}), setTransform() {}, save() {}, restore() {},
      translate() {}, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() {}, clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) {
        if (name === 'main') mainFills.push({ x, y, w, h, grad: (fillStyle as Grad | null) && typeof fillStyle === 'object' ? fillStyle as Grad : null })
      },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return { addColorStop() {} } },
      createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
        const g: Grad = { x0, y0, x1, y1, stops: 0 }
        const obj = { ...g, addColorStop() { obj.stops++ } }
        if (name === 'main') mainGrads.push(obj); else offGrads++
        return obj
      },
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
    mainGrads.length = 0; mainFills.length = 0; mainDraws.length = 0; seq = 0; offGrads = 0
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
    vocab: 'brand', density: 1, cellInset: 0,
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0, gen: { ...defaultGrid().gen, seed: 9 } },
    ...over,
  })

  it('a Pane deal issues one createLinearGradient + fillRect per masonry region, endpoints on the cell corners/edges, cells flush', async () => {
    const layer = dealLayer({ cellFill: 'pane', pane: defaultPane() })
    await drawDeal(layer, 400, 400)
    const regions = paneRegions(defaultPane(), 400, 400, 9)
    expect(regions.length).toBeGreaterThan(8)
    expect(mainGrads.length).toBe(regions.length)
    expect(mainFills.length).toBe(regions.length)
    expect(mainDraws.length).toBe(0)   // no per-cell tiles: Pane paints directly
    expect(offGrads).toBe(0)
    for (let k = 0; k < regions.length; k++) {
      const r = regions[k]!, f = mainFills[k]!, g = mainGrads[k]!
      expect([f.x, f.y, f.w, f.h]).toEqual([r.x, r.y, r.w, r.h])
      expect(f.grad).toBe(g)
      expect(g.stops).toBe(2 + (PANE_RAMP_STEPS - 1) + (paneCellPick(defaultPane(), 7, 9, r.i, r.j).p0 > 0 ? 1 : 0) + (paneCellPick(defaultPane(), 7, 9, r.i, r.j).p1 < 1 ? 1 : 0))
      // The gradient endpoints are EXACTLY the picked direction vector mapped over THIS
      // cell — not merely "some corner or edge" (which a transposed x0/y0 would also
      // satisfy). Ties the painted geometry to the pick.
      const d = paneCellPick(defaultPane(), 7, 9, r.i, r.j).dir
      expect([g.x0, g.y0, g.x1, g.y1]).toEqual([r.x + d[0] * r.w, r.y + d[1] * r.h, r.x + d[2] * r.w, r.y + d[3] * r.h])
    }
    // No cell has a gap to its row neighbour.
    const rows = new Map<number, typeof mainFills>()
    for (let k = 0; k < regions.length; k++) { const j = regions[k]!.j; if (!rows.has(j)) rows.set(j, []); rows.get(j)!.push(mainFills[k]!) }
    for (const row of rows.values()) {
      for (let i = 1; i < row.length; i++) expect(row[i]!.x).toBe(row[i - 1]!.x + row[i - 1]!.w)
      expect(row[row.length - 1]!.x + row[row.length - 1]!.w).toBe(400)
    }
  })

  it('a Pane deal ignores the shared grid / density / inset (masonry, every cell filled)', async () => {
    await drawDeal(dealLayer({ cellFill: 'pane', pane: P({ rows: 2 }), density: 0.1, cellInset: 0.3 }), 400, 400)
    expect(mainFills.length).toBe(paneRegions(P({ rows: 2 }), 400, 400, 9).length)
    expect(mainFills.every(f => f.grad !== null)).toBe(true)
  })

  it('cellFill:solid (and absent) is unchanged — one tile per grid region, no main-ctx gradients', async () => {
    await drawDeal(dealLayer({ cellFill: 'solid' }), 400, 400)
    expect(mainDraws.length).toBe(20)
    expect(mainGrads.length).toBe(0)
    mainDraws.length = 0
    await drawDeal(dealLayer(), 400, 400)
    expect(mainDraws.length).toBe(20)
  })
})

// ── Agent op: dealGrid pane ──────────────────────────────────────────────────
describe('agent dealGrid pane', () => {
  const baseState = (): CompositorState => ({ layers: [] })

  it('creates with cellFill:pane and pane params merged onto the defaults', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', cellFill: 'pane', pane: { rows: 4 } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('pane')
    expect(l.pane).toEqual({ ...defaultPane(), rows: 4 })
  })
  it('defaults: solid fill, pane at the source defaults', () => {
    const l = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1' } }) as any).template.layers[0]
    expect(l.cellFill).toBe('solid')
    expect(l.pane).toEqual(defaultPane())
  })
  it('sending pane implies the Pane fill; reconfigure merges and clamps', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { pane: { diag: 1, rows: 40, spread: 'no' } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('pane')
    expect(l.pane).toEqual({ ...defaultPane(), diag: 1, rows: 8 })
    const r2 = applyCompositorCommand((r as any).template, { op: 'dealGrid', target: 'dd', args: { pane: { soft: 0.2 } } })
    expect((r2 as any).template.layers[0].pane).toEqual({ ...defaultPane(), diag: 1, rows: 8, soft: 0.2 })
  })
  it('ignores an unknown cellFill value on reconfigure (keeps the prior fill)', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', cellFill: 'pane' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { cellFill: 'bogus' } })
    expect((r as any).template.layers[0].cellFill).toBe('pane')
  })
})
