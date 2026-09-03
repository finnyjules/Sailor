import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'

// makeTextTexture draws to document.createElement('canvas'); node has no canvas,
// so a recording fake stands in. Text measures 10px per character, cap height 50.
class FakeCtx {
  ops: any[] = []
  font = ''; fillStyle: any = '#000'; strokeStyle: any = '#000'; lineWidth = 0; lineJoin = 'miter'
  textBaseline = 'alphabetic'; textAlign = 'left'; letterSpacing = '0px'
  measureText(t: string) { return { width: t.length * 10, actualBoundingBoxAscent: 50, actualBoundingBoxDescent: 10 } }
  fillText(t: string, x: number, y: number) { this.ops.push(['fillText', t, x, y]) }
  strokeText(t: string, x: number, y: number) { this.ops.push(['strokeText', t, x, y]) }
  setTransform() {}
  clearRect() {}
  save() {} restore() {}
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p?.d, rule, this.fillStyle]) }
  stroke(p: any) { this.ops.push(['stroke', p?.d, this.strokeStyle]) }
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }
class FakePath2D { constructor(public d: string) {} }

const shape: LibraryShape = { id: 'half', name: 'Half', d: 'M0,0L50,0L50,100L0,100Z', fillRule: 'nonzero', box: [0, 0, 50, 100], sourceColor: '#000' }

let last: FakeCanvas
beforeAll(() => {
  ;(globalThis as any).Path2D = FakePath2D
  vi.stubGlobal('document', { createElement: () => (last = new FakeCanvas()) })
})
afterAll(() => vi.unstubAllGlobals())

const base = {
  label: 'SAILOR   ', fontFamily: 'Inter', fontWeight: 700, axes: {}, typeColor: '#ff0000', heightPx: 256, fontSizePx: 100,
}

describe('makeTextTexture without a separator', () => {
  it('is the old tile: width = label width, no path fill', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    const tex = makeTextTexture({ ...base })
    expect(last.width).toBe(90)                       // 'SAILOR   ' = 9 chars × 10
    expect(tex.userData.wordFracs).toEqual([1])
    expect(tex.userData.wordInkFracs[0]).toBeCloseTo(60 / 90, 6)
    expect(last.ctx.ops.some(o => o[0] === 'fill')).toBe(false)
    expect(last.ctx.ops.find(o => o[0] === 'fillText')?.[1]).toBe('SAILOR   ')
    // identity case: no tracking, no separator ⇒ untracked width over its own tile is 1
    expect(tex.userData.naturalWidthFrac).toBe(1)
    expect(tex.userData.separator).toBeUndefined()
  })
})

describe('makeTextTexture with a separator', () => {
  it('lays the tile out as text, gap, shape, gap', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    // size 1 ⇒ shapeH = cap 50, aspect 0.5 ⇒ shapeW 25; gap 1 ⇒ 0.25 × fontSizePx 100 = 25 each side
    const tex = makeTextTexture({ ...base, separator: { shape, size: 1, gap: 1 } })
    expect(last.width).toBe(60 + 25 + 25 + 25)        // 135
    expect(tex.userData.wordFracs).toEqual([1])
    expect(tex.userData.wordInkFracs[0]).toBeCloseTo((60 + 25 + 25) / 135, 6)
    const fill = last.ctx.ops.find(o => o[0] === 'fill')
    expect(fill).toEqual(['fill', shape.d, 'nonzero', '#ff0000'])
    // the text is drawn trimmed so the old trailing gap cannot double the spacing
    expect(last.ctx.ops.find(o => o[0] === 'fillText')?.[1]).toBe('SAILOR')
    // the shape's target box starts after text + gap; translate x = 85 - box.x×scale (box.x is 0)
    const tr = last.ctx.ops.find(o => o[0] === 'translate')
    expect(tr?.[1]).toBeCloseTo(85, 6)
    // vertical placement: rowH 256, cy 128, mid = 128 + (10-50)/2 = 108, shapeH 50 ⇒
    // target y = 83; fit scale 0.5 makes bh×s = 50 = o.h, so dy = 83
    expect(tr?.[2]).toBeCloseTo(83, 6)
    // untracked (no tracking set) ⇒ naturalWidthFrac is exactly 1 for the identity case
    expect(tex.userData.naturalWidthFrac).toBe(1)
    expect(tex.userData.separator?.shape.id).toBe('half')
  })
  it('strokes the shape when the type has a stroke', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    makeTextTexture({ ...base, strokeWidth: 3, strokeColor: '#000000', separator: { shape, size: 1, gap: 1 } })
    expect(last.ctx.ops.some(o => o[0] === 'stroke' && o[1] === shape.d)).toBe(true)
  })
  it('paints one shape per row of a multi-text atlas', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    makeTextTexture({ ...base, labels: ['SAILOR   ', 'SEA   '], separator: { shape, size: 1, gap: 1 } })
    expect(last.ctx.ops.filter(o => o[0] === 'fill').length).toBe(2)
    expect(last.width).toBe(135)                      // widest row wins
    // each row's shape sits after its OWN text + gap, not the widest row's:
    // row 0 (SAILOR, 60px) ⇒ 60 + 25 = 85; row 1 (SEA, 30px) ⇒ 30 + 25 = 55
    const translates = last.ctx.ops.filter(o => o[0] === 'translate')
    expect(translates[0]?.[1]).toBeCloseTo(85, 6)
    expect(translates[1]?.[1]).toBeCloseTo(55, 6)
  })
  it('scaleX widens the canvas for the whole tile', async () => {
    const { makeTextTexture } = await import('../../app/lib/spacetype/textTexture')
    makeTextTexture({ ...base, scaleX: 2, separator: { shape, size: 1, gap: 1 } })
    expect(last.width).toBe(270)
  })
})
