// frontend/tests/unit/motion-text-layout.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { layoutTextUnits } from '../../app/lib/motion/animatedText'
import { createTextLayer } from '../../app/composables/useCompositorLayers'

// Minimal measureText stub: every char is 10px wide at any font.
function stubCtx(): CanvasRenderingContext2D {
  return {
    font: '',
    measureText: (s: string) => ({ width: s.length * 10 }),
  } as unknown as CanvasRenderingContext2D
}

describe('layoutTextUnits', () => {
  it('lays out one cell per char with monotonic x and line-based y', () => {
    const layer = createTextLayer({ text: 'AB\nC', x: 0.5, y: 0.5, fontSize: 0.1, lineHeight: 1.2, align: 'left' })
    const cells = layoutTextUnits(stubCtx(), layer, 1000, 1000)
    expect(cells.length).toBe(3) // whitespace-only chars get no cell; newline splits lines
    expect(cells[0].char).toBe('A')
    expect(cells[1].x).toBeGreaterThan(cells[0].x)
    expect(cells[2].y).toBeGreaterThan(cells[0].y) // second line lower
    // Cell height = fontSize px; cells carry the em box for unit-relative deltas
    expect(cells[0].h).toBeCloseTo(100, 3)
  })
  it('is deterministic', () => {
    const layer = createTextLayer({ text: 'HELLO' })
    const a = layoutTextUnits(stubCtx(), layer, 800, 600)
    const b = layoutTextUnits(stubCtx(), layer, 800, 600)
    expect(a).toEqual(b)
  })
})

describe('layoutTextUnits — placed lines (runs) (I9)', () => {
  it('builds the cells from the runs: each run at its own x/y/size, in em of the font size', () => {
    const layer = createTextLayer({ text: 'Weather Report', fontSize: 0.1, align: 'center', textTransform: 'uppercase' })
    ;(layer as any).runs = [{ text: 'Weather', x: -2, y: -0.5 }, { text: 'Report', x: -1, y: 0.6, s: 1.5 }]
    // Stub measure scales with the font's px size, like a real canvas.
    const ctx = { font: '', measureText(s: string) { return { width: s.length * parseFloat(String(this.font).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? '0') * 0.5 } } } as unknown as CanvasRenderingContext2D
    const cells = layoutTextUnits(ctx, layer, 1000, 1000)
    expect(cells.map(c => c.char).join('')).toBe('WEATHERREPORT')
    // Run 1: left edge at -2 em = -200px, middle at -0.5 em = -50px; 100px font ⇒ 50px glyphs.
    expect(cells[0]).toMatchObject({ char: 'W', x: -200 + 25, y: -50, w: 50, h: 100 })
    expect(cells[6]).toMatchObject({ char: 'R', x: -200 + 6 * 50 + 25, y: -50 })
    // Run 2: left edge at -1 em = -100px, middle at 0.6 em = 60px, set 1.5× (75px glyphs).
    expect(cells[7]).toMatchObject({ char: 'R', x: -100 + 37.5, y: 60, w: 75, h: 150, s: 1.5 })
    expect(cells[12]).toMatchObject({ char: 'T', x: -100 + 5 * 75 + 37.5, y: 60 })
  })
})
