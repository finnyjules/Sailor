import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'

class FakeCtx {
  ops: any[] = []
  font = ''; fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 0; lineJoin = 'miter'
  textBaseline = 'alphabetic'; textAlign = 'left'; letterSpacing = '0px'; fontVariationSettings = ''
  measureText(t: string) { return { width: t.length * 10, actualBoundingBoxAscent: 50, actualBoundingBoxDescent: 10 } }
  fillText(t: string, x: number, y: number) { this.ops.push(['fillText', t, x, y]) }
  strokeText(t: string, x: number, y: number) { this.ops.push(['strokeText', t, x, y]) }
  setTransform() {} clearRect() {} save() {} restore() {}
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p?.d, rule, this.fillStyle]) }
  stroke(p: any) { this.ops.push(['stroke', p?.d, this.strokeStyle]) }
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }
class FakePath2D { constructor(public d: string) {} }
const shape: LibraryShape = { id: 'half', name: 'Half', d: 'M0,0L50,0L50,100L0,100Z', fillRule: 'nonzero', box: [0, 0, 50, 100], sourceColor: '#000' }

let last: FakeCanvas
beforeAll(() => { (globalThis as any).Path2D = FakePath2D; vi.stubGlobal('document', { createElement: () => (last = new FakeCanvas()) }) })
afterAll(() => vi.unstubAllGlobals())

// fontSizePx 200 ⇒ lineHeightPx 200, fontPx 140. 'SAILOR' = 6 glyphs × 10px, tracking 0 ⇒ totalAdvance 60.
const base = { text: 'SAILOR', fontFamily: 'Inter', fontWeight: 700, fontSizePx: 200, tracking: 0, scaleX: 1, color: '#ffffff' }

describe('layoutChars without a separator', () => {
  it('is unchanged: one glyph per letter, no path fill', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    const l = layoutChars({ ...base })
    expect(l.glyphs.length).toBe(6)
    expect(last.width).toBe(60)
    expect(last.ctx.ops.some(o => o[0] === 'fill')).toBe(false)
    expect(l.glyphs[5]!.u1).toBeCloseTo(1, 9)
  })
})

describe('layoutChars with a separator', () => {
  it('appends one shape glyph after the last letter: gap, shape, gap', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    // gapPx = 1 × 140 × 0.25 = 35; cap 50 × size 1 = 50 ⇒ shapeH 50, shapeW 25 (aspect 0.5)
    const l = layoutChars({ ...base, separator: { shape, size: 1, gap: 1 } })
    expect(l.glyphs.length).toBe(7)
    const total = 60 + 35 + 25 + 35
    expect(last.width).toBe(total)
    const g = l.glyphs[6]!
    expect(g.char).toBe('half')
    expect(g.u0).toBeCloseTo(95 / total, 9)
    expect(g.u1).toBeCloseTo(120 / total, 9)
    expect(g.aspect).toBeCloseTo(25 / 200, 9)
    expect(g.centerT).toBeCloseTo(107.5 / total, 9)
    const fill = last.ctx.ops.find(o => o[0] === 'fill')
    expect(fill).toEqual(['fill', shape.d, 'nonzero', '#ffffff'])
    // the letters still each get their own fillText at their measured x
    expect(last.ctx.ops.filter(o => o[0] === 'fillText').length).toBe(6)
    // vertical: box y = h/2 - shapeH/2 = 100 - 25 = 75; drawShape scale 0.5 fits 50→25 wide, 100→50 tall ⇒ translate (95, 75)
    const tr = last.ctx.ops.find(o => o[0] === 'translate')
    expect(tr?.[1]).toBeCloseTo(95, 9); expect(tr?.[2]).toBeCloseTo(75, 9)
  })
  it('strokes the shape when the layout has a stroke, and clamps the shape to the row', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    layoutChars({ ...base, strokeWidth: 4, strokeColor: '#000000', separator: { shape, size: 1, gap: 1 } })
    expect(last.ctx.ops.some(o => o[0] === 'stroke' && o[1] === shape.d)).toBe(true)
    const l2 = layoutChars({ ...base, separator: { shape, size: 10, gap: 0 } })   // 50 × 10 = 500 > row 200 ⇒ 200
    expect(l2.glyphs[6]!.aspect).toBeCloseTo((200 * 0.5) / 200, 9)
  })
  it('scaleX widens the whole run including the separator', async () => {
    const { layoutChars } = await import('../../app/lib/spacetype/charLayout')
    layoutChars({ ...base, scaleX: 2, separator: { shape, size: 1, gap: 1 } })
    expect(last.width).toBe(2 * (60 + 35 + 25 + 35))
  })
})
