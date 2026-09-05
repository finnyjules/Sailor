import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  pickDealIndex, pickDealPaint, keptCell, dealVocabItems, dealVocabSize,
  normalizeVocab, DEAL_VOCABS, type DealVocab,
} from '~/lib/compositor/dealVocab'
import { resolveGrid, defaultGrid, type FrameGrid } from '~/lib/frame/grid'
import { isFill, isGradient, type Paint } from '~/lib/compositor/paint'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// ── The vocabulary picker ────────────────────────────────────────────────────
describe('dealVocab: pickDealIndex / pickDealPaint', () => {
  it('is deterministic in (vocab, seed, cellIndex)', () => {
    for (const v of DEAL_VOCABS) {
      for (const seed of [1, 42, 9999]) {
        for (const i of [0, 3, 17]) {
          expect(pickDealIndex(v, seed, i)).toBe(pickDealIndex(v, seed, i))
          expect(JSON.stringify(pickDealPaint(v, seed, i))).toBe(JSON.stringify(pickDealPaint(v, seed, i)))
        }
      }
    }
  })

  it('every pick is a valid index within the vocabulary', () => {
    for (const v of DEAL_VOCABS) {
      const n = dealVocabSize(v)
      for (let i = 0; i < 200; i++) {
        const idx = pickDealIndex(v, 7, i)
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(n)
      }
    }
  })

  it('returns a deep copy — mutating a picked paint never touches the table', () => {
    const before = JSON.stringify(dealVocabItems('brand'))
    const p = pickDealPaint('brand', 1, 0) as any
    if (typeof p === 'object') { p.mutated = true; if ('a' in p) p.a = '#000000'; if ('stops' in p) p.stops = [] }
    expect(JSON.stringify(dealVocabItems('brand'))).toBe(before)
  })

  it('different seeds produce a different pick distribution', () => {
    const seqOf = (seed: number) => Array.from({ length: 60 }, (_, i) => pickDealIndex('brand', seed, i))
    const a = seqOf(1).join(',')
    const b = seqOf(2).join(',')
    expect(a).not.toBe(b)
  })

  it('a normal deal is not all one cell (guards the "every cell identical" bug)', () => {
    const distinct = new Set(Array.from({ length: 48 }, (_, i) => pickDealIndex('brand', 42, i)))
    expect(distinct.size).toBeGreaterThan(1)
  })

  it('normalizeVocab maps unknown names to "brand"', () => {
    expect(normalizeVocab('nonsense')).toBe('brand')
    expect(normalizeVocab(undefined)).toBe('brand')
    for (const v of DEAL_VOCABS) expect(normalizeVocab(v)).toBe(v)
  })

  it('vocab entries are only solid strings, gradients, or pattern Fills (no live shaders in v1)', () => {
    for (const v of DEAL_VOCABS) {
      for (const { paint } of dealVocabItems(v)) {
        const ok = typeof paint === 'string' || isGradient(paint) || isFill(paint)
        expect(ok).toBe(true)
        if (isFill(paint)) expect(paint.type).not.toBe('shader')
      }
    }
  })
})

// ── Density gate ─────────────────────────────────────────────────────────────
describe('dealVocab: keptCell density', () => {
  it('density >= 1 keeps every cell; density <= 0 keeps none', () => {
    for (let i = 0; i < 100; i++) {
      expect(keptCell(42, i, 1)).toBe(true)
      expect(keptCell(42, i, 1.5)).toBe(true)
      expect(keptCell(42, i, 0)).toBe(false)
      expect(keptCell(42, i, -0.2)).toBe(false)
    }
  })

  it('the kept fraction tracks density (statistical, tolerant)', () => {
    const N = 4000
    for (const d of [0.25, 0.5, 0.75]) {
      let kept = 0
      for (let i = 0; i < N; i++) if (keptCell(99, i, d)) kept++
      expect(Math.abs(kept / N - d)).toBeLessThan(0.04)
    }
  })

  it('is deterministic and independent of the fill stream', () => {
    for (let i = 0; i < 50; i++) expect(keptCell(3, i, 0.5)).toBe(keptCell(3, i, 0.5))
  })
})

// ── resolveGrid integration: the deal's cell layout ──────────────────────────
describe('deal + resolveGrid', () => {
  const explicitGrid = (cols: number, rows: number): FrameGrid => ({
    ...defaultGrid(), mode: 'explicit', columns: cols, rows, margin: 0, gutter: 0,
  })

  it('a 4×3 grid yields 12 regions, all inside the box and non-overlapping', () => {
    const boxW = 800, boxH = 600
    const { regions } = resolveGrid(explicitGrid(4, 3), boxW, boxH)
    expect(regions.length).toBe(12)
    for (const r of regions) {
      expect(r.x).toBeGreaterThanOrEqual(-0.001)
      expect(r.y).toBeGreaterThanOrEqual(-0.001)
      expect(r.x + r.w).toBeLessThanOrEqual(boxW + 0.001)
      expect(r.y + r.h).toBeLessThanOrEqual(boxH + 0.001)
      expect(r.w).toBeGreaterThan(0)
      expect(r.h).toBeGreaterThan(0)
    }
    // Pairwise non-overlap (axis-aligned rects; touching edges are fine).
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i]!, b = regions[j]!
        const overlap = a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001
          && a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001
        expect(overlap).toBe(false)
      }
    }
  })

  it('the whole deal is a stable (kept, paintIndex) sequence for a fixed config', () => {
    const grid = explicitGrid(6, 4)
    grid.gen = { ...grid.gen, seed: 123 }
    const sig = () => {
      const { regions } = resolveGrid(grid, 600, 400)
      return regions.map((_r, i) => `${keptCell(grid.gen.seed, i, 0.7) ? 1 : 0}:${pickDealIndex('warm', grid.gen.seed, i)}`).join('|')
    }
    expect(sig()).toBe(sig())
    // …and a re-roll (new seed) changes it.
    const before = sig()
    grid.gen = { ...grid.gen, seed: 124 }
    expect(sig()).not.toBe(before)
  })
})

// ── Headless paint: the deal actually draws each kept cell ───────────────────
// Recording ctx + document.createElement stub, mirroring brush-layer-render.unit.spec.ts.
// paintTileBox creates offscreen canvases via document.createElement; the deal draws
// each into the main ctx with drawImage — so counting main-ctx drawImage ops proves
// the paint path ran and how many cells landed.
describe('deal layer render (headless)', () => {
  const drawImages: string[] = []
  // Cell placements + translates recorded on the MAIN ctx, so a test can assert WHERE
  // cells land (box centering, corner-origin), not just how many there are.
  const mainDraws: Array<{ x: number; y: number; w: number; h: number }> = []
  const mainTranslates: Array<[number, number]> = []
  // Clips on the MAIN ctx: the rect(s) added to the path since the last beginPath,
  // captured at clip() time — so a test can assert the deal clips to exactly its box.
  const mainClips: Array<Array<{ x: number; y: number; w: number; h: number }>> = []
  let mainPathRects: Array<{ x: number; y: number; w: number; h: number }> = []
  // fillRects on the MAIN ctx (with the fillStyle in force), so a test can assert the
  // shader styles paint ONE box-sized rect with a resolved paint.
  const mainFillRects: Array<{ x: number; y: number; w: number; h: number; style: unknown }> = []
  function recordingCtx(name: string) {
    const g = { addColorStop() {} }
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({}), setTransform() {}, save() {}, restore() {},
      translate(dx = 0, dy = 0) { if (name === 'main') mainTranslates.push([dx, dy]) },
      rotate() {}, scale() {}, clip() { if (name === 'main') mainClips.push([...mainPathRects]) },
      beginPath() { if (name === 'main') mainPathRects = [] }, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {},
      rect(x = 0, y = 0, w = 0, h = 0) { if (name === 'main') mainPathRects.push({ x, y, w, h }) }, closePath() {}, setLineDash() {},
      fill() {}, stroke() {}, clearRect() {},
      fillRect(x = 0, y = 0, w = 0, h = 0) { if (name === 'main') mainFillRects.push({ x, y, w, h, style: (this as any).fillStyle }) },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return g }, createLinearGradient() { return g }, createPattern() { return g },
      drawImage(_img: unknown, x = 0, y = 0, w = 0, h = 0) { if (name === 'main') { drawImages.push(name); mainDraws.push({ x, y, w, h }) } },
    } as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  class FakeImageData {
    data: Uint8ClampedArray; width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w * h) * 4) }
  }
  beforeEach(() => {
    drawImages.length = 0; mainDraws.length = 0; mainTranslates.length = 0; mainClips.length = 0; mainFillRects.length = 0; mainPathRects = []; seq = 0
    vi.stubGlobal('ImageData', FakeImageData)
    vi.stubGlobal('document', { createElement: () => { const c: any = { width: 0, height: 0 }; c.getContext = () => recordingCtx(`off-${++seq}`); return c } })
  })
  afterEach(() => vi.unstubAllGlobals())

  // Imported lazily so the document stub is installed before the module's DOM-free
  // paths run (drawLocalLayer itself only touches the stubbed document inside cells).
  async function drawDeal(layer: any, W: number, H: number) {
    const { drawLocalLayer } = await import('~/composables/useCompositorLayers')
    drawLocalLayer(recordingCtx('main'), layer, W, H)
  }

  const dealLayer = (over: Record<string, unknown> = {}) => ({
    id: 'd1', kind: 'deal', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 1, h: 1,
    vocab: 'brand' as DealVocab, density: 1, cellInset: 0,
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0 },
    ...over,
  })

  it('paints one cell per region at full density (non-blank)', async () => {
    await drawDeal(dealLayer(), 400, 400)
    // 5×4 explicit grid = 20 cells, each drawn once.
    expect(drawImages.length).toBe(20)
  })

  it('density 0 paints nothing; density 1 paints all', async () => {
    await drawDeal(dealLayer({ density: 0 }), 400, 400)
    expect(drawImages.length).toBe(0)
    drawImages.length = 0
    await drawDeal(dealLayer({ density: 1 }), 400, 400)
    expect(drawImages.length).toBe(20)
  })

  it('cellInset 0 draws flush cells even when the grid carries a gutter (no hidden gap)', async () => {
    // A grid gutter would otherwise inset every cell independently of cellInset, so
    // cells are never flush at inset 0. The deal must resolve flush and let cellInset
    // be the only gap. 2 cols × 1 row over a 400px box → cells at [0,200] and [200,400].
    const grid = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 1, margin: 0, gutter: 0.05 }
    await drawDeal(dealLayer({ w: 1, h: 1, cellInset: 0, grid }), 400, 400)
    expect(mainDraws.length).toBe(2)
    const [a, b] = [...mainDraws].sort((p, q) => p.x - q.x)
    // Left cell starts at the box left; the two cells meet with no gap; right cell ends at the box right.
    expect(a!.x).toBeLessThan(0.5)
    expect(Math.abs((a!.x + a!.w) - b!.x)).toBeLessThan(0.5)   // adjacent, no gutter gap
    expect(b!.x + b!.w).toBeGreaterThan(400 - 0.5)
  })

  it('centres the box (boxH from WIDTH, not height) and places cells corner-origin inside it', async () => {
    // Pass H ≠ W so a `* H` regression is distinguishable from the correct `* W`.
    // layer.w=1, h=0.5, W=400 → boxW=400, boxH=0.5*400=200 (a `* H` bug would give 400).
    await drawDeal(dealLayer({ w: 1, h: 0.5 }), 400, 800)
    const boxW = 400, boxH = 200
    // The deal branch centres the box: some translate must be (-boxW/2, -boxH/2).
    expect(mainTranslates.some(([dx, dy]) => Math.abs(dx + boxW / 2) < 1 && Math.abs(dy + boxH / 2) < 1)).toBe(true)
    // Every cell sits inside the box, corner-origin (x,y are the cell's top-left).
    expect(mainDraws.length).toBe(20)
    for (const d of mainDraws) {
      expect(d.x).toBeGreaterThanOrEqual(-0.5)
      expect(d.y).toBeGreaterThanOrEqual(-0.5)
      expect(d.x + d.w).toBeLessThanOrEqual(boxW + 0.5)
      expect(d.y + d.h).toBeLessThanOrEqual(boxH + 0.5)
    }
    // Cells fill the box, not clustered: something touches each edge/quadrant.
    const minX = Math.min(...mainDraws.map(d => d.x)), maxR = Math.max(...mainDraws.map(d => d.x + d.w))
    const minY = Math.min(...mainDraws.map(d => d.y)), maxB = Math.max(...mainDraws.map(d => d.y + d.h))
    expect(minX).toBeLessThan(1); expect(maxR).toBeGreaterThan(boxW - 1)
    expect(minY).toBeLessThan(1); expect(maxB).toBeGreaterThan(boxH - 1)
  })

  it('clips every mode to its box (the ported generators rely on a canvas edge the box lacks)', async () => {
    // Parcel strokes edge-touching hairlines at W+.5 and Mosh/Modular oversize rects
    // by +1 — on the tool's own canvas the edge clips them; a deal box has none. So
    // the deal branch clips ONCE to exactly (0,0,boxW,boxH) in box space, for every
    // cellFill. layer.w=0.5, h=0.25, W=400 → boxW=200, boxH=100 (smaller than the frame).
    for (const cellFill of ['pane', 'parcel', 'modular', 'mosh', 'solid'] as const) {
      mainClips.length = 0
      await drawDeal(dealLayer({ w: 0.5, h: 0.25, cellFill }), 400, 400)
      expect(mainClips.length, `${cellFill}: one clip`).toBe(1)
      expect(mainClips[0], `${cellFill}: the clip path is the box`).toEqual([{ x: 0, y: 0, w: 200, h: 100 }])
    }
  })

  it('never renders fully blank at a low but non-zero density (force-kept cell)', async () => {
    // A small grid at min slider density across many seeds: at least one cell always
    // paints, so a deal the user just added is never invisible. density 0 stays empty.
    for (let seed = 1; seed <= 30; seed++) {
      drawImages.length = 0
      const g = { ...defaultGrid(), mode: 'explicit' as const, columns: 2, rows: 2, margin: 0, gutter: 0, gen: { ...defaultGrid().gen, seed } }
      await drawDeal(dealLayer({ density: 0.05, grid: g }), 400, 400)
      expect(drawImages.length).toBeGreaterThanOrEqual(1)
    }
  })

  // Fix 3: a partial carve object (hand-edited or imported frame) reaching paint with
  // no `inks` must not throw. The deal branch used to hand paintCarve the RAW layer's
  // `carve.inks` (undefined here), which threw at `palette.length` inside paintCarve
  // and took the whole frame down; it must now go through normalizeCarve first.
  it('a carve layer with a partial params object and no inks renders without throwing', async () => {
    mainFillRects.length = 0; drawImages.length = 0
    await drawDeal(dealLayer({ cellFill: 'carve', carve: { cuts: 3 } }), 400, 400)
    // Something actually painted (the ground rect at least) — not a silent no-op.
    expect(mainFillRects.length + drawImages.length).toBeGreaterThan(0)
  })

  it('the shader styles paint ONE box-sized rect through resolvePaint, in box space, inside the clip', async () => {
    // No shader catalog in this harness, so resolvePaint takes its documented fallback
    // (the spec's input paint) — the point here is the PATH: clip to the box, then one
    // fillRect over the whole box IN BOX SPACE (the box is the shader's own frame: the
    // deal branch swaps the field context's frame for the box while it paints, so
    // there is no step back to the centre — the fill is positioned from the box's
    // top-left, where its base transform was captured) with a resolved fillStyle.
    for (const cellFill of ['oddgrid', 'static'] as const) {
      mainFillRects.length = 0; mainClips.length = 0; mainTranslates.length = 0
      const { mosaicShaderSpec } = await import('~/lib/compositor/mosaic')
      const layer = dealLayer({ cellFill, w: 1, h: 0.5, shader: mosaicShaderSpec(cellFill, 7) })
      await drawDeal(layer, 400, 400)
      expect(mainClips[0]).toEqual([{ x: 0, y: 0, w: 400, h: 200 }])
      // The layer's own placement translate to the box corner is the LAST translate.
      expect(mainTranslates.slice(-1)).toEqual([[-200, -100]])
      expect(mainFillRects).toHaveLength(1)
      expect(mainFillRects[0]).toMatchObject({ x: 0, y: 0, w: 400, h: 200 })
      expect(mainFillRects[0]!.style).toBeTruthy() // a resolved paint, never the empty default
      expect(drawImages).toHaveLength(0) // no per-cell tiles: the whole box is one fill
    }
  })

  it('two different seeds produce different dealt sequences (pixel-signature proxy)', () => {
    // The picked-paint sequence is the pixel signature: if two seeds dealt the same
    // fills to the same cells, the render would be identical. They must differ.
    const grid: FrameGrid = { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4 }
    const seqFor = (seed: number) => {
      const { regions } = resolveGrid(grid, 400, 320)
      return regions.map((_r, i) => JSON.stringify(pickDealPaint('cool', seed, i))).join('|')
    }
    expect(seqFor(11)).not.toBe(seqFor(22))
  })
})

// ── Agent op: dealGrid ───────────────────────────────────────────────────────
describe('agent dealGrid op', () => {
  const baseState = (): CompositorState => ({ layers: [] })

  it('creates a deal layer filling the frame, seeded from an off grid → generated', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { vocab: 'warm', density: 0.6, id: 'deal1' } })
    expect(r.ok).toBe(true)
    const layers = (r as any).template.layers
    expect(layers).toHaveLength(1)
    const d = layers[0]
    expect(d.kind).toBe('deal')
    expect(d.id).toBe('deal1')
    expect(d.vocab).toBe('warm')
    expect(d.density).toBeCloseTo(0.6)
    expect(d.w).toBe(1)
    expect(d.grid.mode).toBe('generated') // an off frame grid is dealt as generated
  })

  it('clamps density/cellInset and normalizes an unknown vocab', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { vocab: 'bogus', density: 5, cellInset: 9 } })
    const d = (r as any).template.layers[0]
    expect(d.vocab).toBe('brand')
    expect(d.density).toBe(1)
    expect(d.cellInset).toBe(0.4)
  })

  it('reconfigures an existing deal in place when targeted', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', vocab: 'brand' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { vocab: 'cool', density: 0.3 } })
    expect(r.ok).toBe(true)
    const layers = (r as any).template.layers
    expect(layers).toHaveLength(1) // reconfigure, not a second layer
    expect(layers[0].vocab).toBe('cool')
    expect(layers[0].density).toBeCloseTo(0.3)
  })

  it('generate:true re-rolls the deal grid seed', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', seed: 100 } }) as any).template
    expect(s1.layers[0].grid.gen.seed).toBe(100)
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { generate: true } })
    const seed = (r as any).template.layers[0].grid.gen.seed
    expect(seed).not.toBe(100)
    expect(seed).toBeGreaterThanOrEqual(1)
    expect(seed).toBeLessThanOrEqual(9999)
  })

  it('rejects targeting a non-deal layer', () => {
    const s: CompositorState = { layers: [{ id: 'r', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.3, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any] }
    const r = applyCompositorCommand(s, { op: 'dealGrid', target: 'r', args: { vocab: 'cool' } })
    expect(r.ok).toBe(false)
  })
})
