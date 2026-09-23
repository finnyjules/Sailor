import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { __drawTextForTest, localLayerBox } from '~/composables/useCompositorLayers'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'

// Placed title lines (`runs`): each run is drawn at its own position and size, in em of
// the layer's font size, relative to the layer origin — so a layout can set a title line
// by line without rewriting the user's text.

type Call = { t: string; x: number; y: number; font: string }

function makeCtx() {
  const calls: Call[] = []
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const saves: { m: typeof m; a: number; g: string }[] = []
  const ctx: any = {
    canvas: { width: 1000, height: 1000 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '', textAlign: 'start', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    save() { saves.push({ m: { ...m }, a: ctx.globalAlpha, g: ctx.globalCompositeOperation }) },
    restore() {
      const p = saves.pop()
      if (p) { m = p.m; ctx.globalAlpha = p.a; ctx.globalCompositeOperation = p.g }
    },
    translate(tx: number, ty: number) { m.e += m.a * tx + m.c * ty; m.f += m.b * tx + m.d * ty },
    scale(sx: number, sy: number) { m.a *= sx; m.b *= sx; m.c *= sy; m.d *= sy },
    rotate() {}, transform() {},
    setTransform() {}, getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, arcTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, rect() {}, roundRect() {}, ellipse() {},
    clip() {}, clearRect() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
    setLineDash() {},
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }
    },
    putImageData() {}, drawImage() {},
    fillText(t: string, x: number, y: number) { calls.push({ t, x, y, font: ctx.font }) },
    strokeText() {},
    measureText(t: string) {
      const w = t.length * parseFloat(String(ctx.font).split(' ')[1]) * 0.5
      return { width: w, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 }
    },
    createLinearGradient() { return { addColorStop() {} } },
    createRadialGradient() { return { addColorStop() {} } },
    createPattern() { return null },
  }
  return { ctx, calls }
}

const base = (over: Record<string, any> = {}): any => ({
  id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
  text: 'Weather\nReport', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1,
  color: '#111111', align: 'center', lineHeight: 1.1,
  strokeColor: '#000000', strokeWidth: 0,
  ...over,
})

const RUNS = [{ text: 'Weather', x: -2, y: -0.5 }, { text: 'Report', x: -2, y: 0.5, s: 1.5 }]

describe('text layer placed lines (runs)', () => {
  it('a layer without runs draws exactly as before', () => {
    const { ctx, calls } = makeCtx()
    __drawTextForTest(ctx, base({ align: 'left', letterSpacing: 0.05 }), 1000)
    // Captured from the code BEFORE runs existed (2026-09-23), pasted verbatim.
    expect(calls).toEqual([
      { t: 'Weather', x: -175, y: -55.00000000000001, font: '700 100px Inter, sans-serif' },
      { t: 'Report', x: -175, y: 55.00000000000001, font: '700 100px Inter, sans-serif' },
    ])
  })

  it('draws each run at its own place and size, in em of the layer font size', () => {
    const { ctx, calls } = makeCtx()
    __drawTextForTest(ctx, base({ runs: RUNS }), 1000)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ t: 'Weather', x: -200, y: -50 })
    expect(calls[0]!.font).toContain('100px')
    expect(calls[1]).toMatchObject({ t: 'Report', x: -200, y: 50 })
    expect(calls[1]!.font).toContain('150px')
    // Left-anchored, middle baseline — the run's x is its left edge, y its em-box middle.
    expect(ctx.textAlign).toBe('left')
    expect(ctx.textBaseline).toBe('middle')
  })

  it('the box contains every run (runs are centred on the origin by construction)', () => {
    const { ctx } = makeCtx()
    const W = 1000
    const box = localLayerBox(ctx, base({ runs: RUNS }), W, W)
    // Run boxes in px relative to the origin (mock measure: chars × size × 0.5).
    const r1 = { l: -200, r: -200 + 7 * 100 * 0.5, t: -50 - 50, b: -50 + 50 }   // 'Weather' @100px
    const r2 = { l: -200, r: -200 + 6 * 150 * 0.5, t: 50 - 75, b: 50 + 75 }    // 'Report' @150px
    // Width covers both runs.
    expect(box.w).toBeGreaterThanOrEqual(Math.max(r1.r - r1.l, r2.r - r2.l))
    // Height spans first run's top to last run's bottom.
    expect(box.h).toBeGreaterThanOrEqual(r2.b - r1.t)
    // And the centred box actually contains both runs.
    for (const r of [r1, r2]) {
      expect(r.l).toBeGreaterThanOrEqual(-box.w / 2)
      expect(r.r).toBeLessThanOrEqual(box.w / 2)
      expect(r.t).toBeGreaterThanOrEqual(-box.h / 2)
      expect(r.b).toBeLessThanOrEqual(box.h / 2)
    }
    // Exact: 2 × max horizontal extent, 2 × max vertical extent.
    expect(box.w).toBeCloseTo(2 * 250)
    expect(box.h).toBeCloseTo(2 * 125)
  })

  it('editing the words drops the placed lines; moving the layer keeps them', () => {
    const properties: Record<string, any> = { sailor_localLayers: [base({ runs: RUNS })] }
    const node = reactive({ data: { properties } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
    const layer = () => (node.data.properties.sailor_localLayers as any[])[0]

    ed.setLocal('t1', { x: 0.3 })
    expect(layer().x).toBe(0.3)
    expect(layer().runs).toEqual(RUNS)

    // Same words: nothing to re-place.
    ed.setLocal('t1', { text: 'Weather\nReport' })
    expect(layer().runs).toEqual(RUNS)

    ed.setLocal('t1', { text: 'New' })
    expect(layer().text).toBe('New')
    expect(layer().runs).toBeUndefined()
    expect('runs' in layer()).toBe(false)
  })
})
