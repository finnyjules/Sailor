import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { paneCellGradient, PANE_ANGLES } from '~/lib/compositor/pane'
import { dealVocabItems, DEAL_VOCABS, type DealVocab } from '~/lib/compositor/dealVocab'
import { isGradient, type LinearGradient } from '~/lib/compositor/paint'
import { resolveGrid, defaultGrid, type FrameGrid } from '~/lib/frame/grid'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// ── The Pane cell generator ──────────────────────────────────────────────────
const solidInks = (v: DealVocab) =>
  dealVocabItems(v).map(it => it.paint).filter((p): p is string => typeof p === 'string')

// Parse a #rrggbb (or #rrggbbaa) hex to [r,g,b] 0..255.
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function dist(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

describe('paneCellGradient', () => {
  it('is deterministic in (vocab, seed, cellIndex)', () => {
    for (const v of DEAL_VOCABS) {
      for (const seed of [1, 42, 9999]) {
        for (const i of [0, 3, 17]) {
          expect(JSON.stringify(paneCellGradient(v, seed, i))).toBe(JSON.stringify(paneCellGradient(v, seed, i)))
        }
      }
    }
  })

  it('returns a linear gradient with a valid 8-way angle and ≥2 stops', () => {
    for (const v of DEAL_VOCABS) {
      for (let i = 0; i < 40; i++) {
        const g = paneCellGradient(v, 7, i)
        expect(isGradient(g)).toBe(true)
        expect(g.type).toBe('linear')
        const lin = g as LinearGradient
        expect(PANE_ANGLES).toContain(lin.angle as (typeof PANE_ANGLES)[number])
        expect(lin.stops.length).toBeGreaterThanOrEqual(2)
        for (const s of lin.stops) {
          expect(s.offset).toBeGreaterThanOrEqual(0)
          expect(s.offset).toBeLessThanOrEqual(1)
          expect(typeof s.color).toBe('string')
        }
      }
    }
  })

  it('the two endpoint inks are DISTINCT and both come from the vocabulary palette', () => {
    for (const v of DEAL_VOCABS) {
      const pool = solidInks(v)
      expect(pool.length).toBeGreaterThanOrEqual(2) // the real four are solids-first
      const poolLower = new Set(pool.map(c => c.toLowerCase()))
      for (let i = 0; i < 60; i++) {
        const lin = paneCellGradient(v, 3, i) as LinearGradient
        const a = lin.stops[0]!.color.toLowerCase()
        const b = lin.stops[lin.stops.length - 1]!.color.toLowerCase()
        expect(a).not.toBe(b)                 // distinct
        expect(poolLower.has(a)).toBe(true)   // from the palette
        expect(poolLower.has(b)).toBe(true)
      }
    }
  })

  it('different cellIndex / seed vary the angle and inks', () => {
    const angles = new Set<number>()
    const inkPairs = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const lin = paneCellGradient('brand', 5, i) as LinearGradient
      angles.add(lin.angle)
      inkPairs.add(`${lin.stops[0]!.color}|${lin.stops[lin.stops.length - 1]!.color}`)
    }
    expect(angles.size).toBeGreaterThan(1)
    expect(inkPairs.size).toBeGreaterThan(1)
    // Same cellIndex, different seed → generally a different gradient.
    const s1 = JSON.stringify(paneCellGradient('brand', 1, 4))
    const s2 = JSON.stringify(paneCellGradient('brand', 2, 4))
    expect(s1).not.toBe(s2)
  })

  it('a middle stop is NOT the naive sRGB midpoint of the endpoints (hue-walk ran, not a straight lerp)', () => {
    // Over many cells, find the largest deviation of the true middle stop from the
    // straight sRGB average of the two endpoints. A plain lerp would put every middle
    // stop ON that chord (≈0); walking the OKLCH hue bows it well off the chord.
    let maxDev = 0
    for (let i = 0; i < 60; i++) {
      const lin = paneCellGradient('brand', 9, i) as LinearGradient
      const stops = lin.stops
      const A = rgb(stops[0]!.color), B = rgb(stops[stops.length - 1]!.color)
      if (dist(A, B) < 8) continue // near-identical endpoints can't bow — skip
      const mid = stops[Math.floor((stops.length - 1) / 2)]!
      const chord: [number, number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]
      maxDev = Math.max(maxDev, dist(rgb(mid.color), chord))
    }
    expect(maxDev).toBeGreaterThan(20)
  })

  it('never throws and stays distinct-or-graceful for an unknown vocab (normalized to brand)', () => {
    const lin = paneCellGradient('nonsense' as DealVocab, 1, 0) as LinearGradient
    expect(lin.type).toBe('linear')
    expect(lin.stops.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Headless deal render: Pane changes the FILL, not the layout ──────────────
// Recording ctx + document.createElement stub, mirroring deal-layer.unit.spec.ts.
describe('deal layer render with cellFill:pane (headless)', () => {
  const drawImages: string[] = []
  // Every gradient tile paintTileBox builds calls createLinearGradient + one
  // addColorStop per stop. Counting stop-adds on the OFFSCREEN tiles proves the
  // deal branch actually took the Pane gradient path per cell (not a solid fill /
  // silent fallback) — the "graceful fallback hides integration failure" guard.
  let colorStops = 0
  let linearGrads = 0
  function recordingCtx(name: string) {
    const g = { addColorStop() { if (name.startsWith('off')) colorStops++ } }
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({}), setTransform() {}, save() {}, restore() {},
      translate() {}, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() {}, fillRect() {}, clearRect() {},
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return g }, createLinearGradient() { if (name.startsWith('off')) linearGrads++; return g }, createPattern() { return g },
      drawImage() { if (name === 'main') drawImages.push(name) },
    } as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  class FakeImageData {
    data: Uint8ClampedArray; width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w * h) * 4) }
  }
  beforeEach(() => {
    drawImages.length = 0; seq = 0; colorStops = 0; linearGrads = 0
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
    vocab: 'brand' as DealVocab, density: 1, cellInset: 0,
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0 },
    ...over,
  })

  it('cellFill:pane paints one cell per region — same count as solid (fill, not layout)', async () => {
    await drawDeal(dealLayer({ cellFill: 'pane' }), 400, 400)
    expect(drawImages.length).toBe(20) // 5×4
    // Proof the Pane gradient path actually ran: every one of the 20 cells built a
    // linear gradient (6 stops each) — not a solid fill or a silent fallback.
    expect(linearGrads).toBe(20)
    expect(colorStops).toBe(20 * 6)
  })

  it('cellFill:solid (and absent) is unchanged — still one cell per region, few/no gradients', async () => {
    await drawDeal(dealLayer({ cellFill: 'solid' }), 400, 400)
    expect(drawImages.length).toBe(20)
    // Solid fills go through fillRect, not per-cell gradients — the vocab has only a
    // single low-weight gradient entry, so the count is far below Pane's 20.
    expect(linearGrads).toBeLessThan(20)
    drawImages.length = 0; linearGrads = 0; colorStops = 0
    await drawDeal(dealLayer(), 400, 400) // absent = solid
    expect(drawImages.length).toBe(20)
    expect(linearGrads).toBeLessThan(20)
  })
})

// ── Agent op: dealGrid cellFill ──────────────────────────────────────────────
describe('agent dealGrid cellFill', () => {
  const baseState = (): CompositorState => ({ layers: [] })

  it('sets cellFill:pane on create', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', cellFill: 'pane' } })
    expect(r.ok).toBe(true)
    expect((r as any).template.layers[0].cellFill).toBe('pane')
  })

  it('defaults cellFill to solid on create when omitted', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1' } })
    expect((r as any).template.layers[0].cellFill).toBe('solid')
  })

  it('sets cellFill:pane on reconfigure of an existing deal', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { cellFill: 'pane' } })
    expect(r.ok).toBe(true)
    const layers = (r as any).template.layers
    expect(layers).toHaveLength(1)
    expect(layers[0].cellFill).toBe('pane')
  })

  it('ignores an unknown cellFill value on reconfigure (keeps the prior fill)', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', cellFill: 'pane' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { cellFill: 'bogus' } })
    expect((r as any).template.layers[0].cellFill).toBe('pane')
  })
})
