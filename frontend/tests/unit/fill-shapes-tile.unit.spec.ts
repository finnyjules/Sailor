import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

class FakeCtx {
  ops: any[] = []
  fillStyle: any = ''; strokeStyle = ''; lineWidth = 0; lineJoin = ''
  save() { this.ops.push(['save']) }
  restore() { this.ops.push(['restore']) }
  translate(x: number, y: number) { this.ops.push(['translate', x, y]) }
  rotate(a: number) { this.ops.push(['rotate', a]) }
  scale(x: number, y: number) { this.ops.push(['scale', x, y]) }
  beginPath() {}
  fillRect(x: number, y: number, w: number, h: number) { this.ops.push(['fillRect', x, y, w, h, this.fillStyle]) }
  fill(p: any, rule?: string) { this.ops.push(['fill', p?.d, this.fillStyle]) }
  stroke() {}
  createLinearGradient() { return { addColorStop() {} } }
  putImageData() {}
  getImageData() { return { data: new Uint8ClampedArray(4) } }
  moveTo() {} lineTo() {} clip() {} clearRect() {} setTransform() {} getContext() { return this }
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }
class FakePath2D { constructor(public d: string) {} }

let created: FakeCanvas[] = []
beforeAll(() => {
  ;(globalThis as any).Path2D = FakePath2D
  vi.stubGlobal('document', { createElement: () => { const c = new FakeCanvas(); created.push(c); return c } })
})
afterAll(() => vi.unstubAllGlobals())

import { fillTileCanvas, fillTileBox, normalizeFill, FILL_TYPES, DEFAULT_FILL, type Fill } from '../../app/lib/spacetype/fillTile'
import { shapeById } from '../../app/lib/shapes/catalog'

const shapesFill = (over: Partial<Fill> = {}): Fill => ({ ...DEFAULT_FILL, type: 'shapes', a: '#ff0000', b: '#000000', shapeId: 'sparkle', density: 3, angle: 0, ...over })

describe('shapes fill type', () => {
  it('is registered', () => { expect(FILL_TYPES).toContain('shapes') })
  it('draws d×d shape fills in colour a on a colour-b background', () => {
    created = []
    fillTileCanvas(shapesFill({ density: 3 }), 120)
    const cell = created[0]!.ctx.ops
    // one background fillRect in b, then 9 path fills in a (colour = '#ff0000')
    const bg = cell.find((o: any) => o[0] === 'fillRect')
    expect(bg?.[5]).toBe('#000000')
    const fills = cell.filter((o: any) => o[0] === 'fill' && o[2] === '#ff0000')
    expect(fills.length).toBe(9)
    expect(fills[0]![1]).toBe(shapeById('sparkle')!.d)
  })
  it('leaves the background transparent when b is none', () => {
    created = []
    fillTileCanvas(shapesFill({ b: 'none', density: 2 }), 120)
    const cell = created[0]!.ctx.ops
    expect(cell.some((o: any) => o[0] === 'fillRect')).toBe(false)
    expect(cell.filter((o: any) => o[0] === 'fill').length).toBe(4)
  })
  it('falls back to sparkle for an unknown shape id', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeId: 'unicorn', density: 1 }), 120)
    expect(created[0]!.ctx.ops.find((o: any) => o[0] === 'fill')![1]).toBe(shapeById('sparkle')!.d)
  })
  it('fillTileBox draws the shapes too', () => {
    created = []
    fillTileBox(shapesFill({ density: 2 }), 200, 100)
    expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill').length).toBe(4)
  })
  it('rotates each shape by angle about the cell centre', () => {
    created = []
    fillTileCanvas(shapesFill({ density: 1, angle: 90 }), 120)
    expect(created[0]!.ctx.ops.some((o: any) => o[0] === 'rotate' && Math.abs(o[1] - Math.PI / 2) < 1e-6)).toBe(true)
  })
})

describe('normalizeFill + shapeId', () => {
  it('carries shapeId for a shapes fill, defaults a bad one to sparkle', () => {
    expect(normalizeFill({ type: 'shapes', shapeId: 'sun-rays' }).shapeId).toBe('sun-rays')
    expect(normalizeFill({ type: 'shapes', shapeId: 42 }).shapeId).toBe('sparkle')
  })
  it('drops shapeId on a non-shapes fill', () => {
    expect((normalizeFill({ type: 'solid', shapeId: 'sun-rays' }) as any).shapeId).toBeUndefined()
  })
})
