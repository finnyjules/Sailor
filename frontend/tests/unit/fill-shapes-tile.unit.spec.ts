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
  drawImage(img: any, x: number, y: number) { this.ops.push(['drawImage', x, y]) }
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

// Regression (final review, Major): `shapes` was added to the shared FILL_TYPES, so it appears
// in the Space Type / Shape Studio pickers whose GPU render path is fillTexture(). fillTexture
// had no `shapes` arm and silently fell through to qrTex — a shapes fill rendered as a QR lattice.
// These assert fillTexture now routes `shapes` through the real shape tiler (fillTileCanvas →
// paintShapesTile → drawShape → ctx.fill(Path2D)), not qrTex, and that the cache keys on shapeId.
import * as THREE from 'three'
import { fillTexture } from '../../app/lib/spacetype/fills'

describe('fillTexture (GPU path) — shapes', () => {
  it('routes a shapes fill through the shape tiler (Path2D fills), NOT qrTex', () => {
    created = []
    const tex = fillTexture(THREE, shapesFill({ a: '#0055ff', shapeId: 'sun-rays', density: 3 }))
    expect(tex).toBeInstanceOf(THREE.CanvasTexture)
    const ops = created[0]!.ctx.ops
    const fills = ops.filter((o: any) => o[0] === 'fill' && o[2] === '#0055ff')
    expect(fills.length).toBe(9)                          // 3×3 grid of shapes
    expect(fills[0]![1]).toBe(shapeById('sun-rays')!.d)   // the picked shape, not sparkle/qr
  })
  it('caches shapes textures per shapeId (two shapes ≠ same texture)', () => {
    const t1 = fillTexture(THREE, shapesFill({ a: '#abcdef', shapeId: 'sparkle', density: 2 }))
    const t2 = fillTexture(THREE, shapesFill({ a: '#abcdef', shapeId: 'sun-rays', density: 2 }))
    const t1again = fillTexture(THREE, shapesFill({ a: '#abcdef', shapeId: 'sparkle', density: 2 }))
    expect(t2).not.toBe(t1)      // different shape → different cache entry
    expect(t1again).toBe(t1)     // same shape → cache hit
  })
})

// Regression (final review, follow-up): fillAtlasTexture (the shutter/coil per-band atlas) is a
// SECOND, independent GPU tile builder that never calls fillTexture — its `else` branch rendered a
// shapes fill as a flat `a`-colour band, and its cache key omitted shapeId. Assert it now stamps
// the shape tile (Path2D fills) and keys on shapeId.
import { fillAtlasTexture } from '../../app/lib/spacetype/fills'

describe('fillAtlasTexture (shutter/coil atlas) — shapes', () => {
  it('stamps the shape tile into the band, not a flat colour', () => {
    created = []
    fillAtlasTexture(THREE, [shapesFill({ a: '#22aa44', shapeId: 'sun-rays', density: 2 })])
    // the atlas canvas is created[0]; the stamped tile is a nested canvas created by fillTileCanvas
    const tileCanvas = created.find(c => c.ctx.ops.some((o: any) => o[0] === 'fill' && o[2] === '#22aa44'))
    expect(tileCanvas).toBeTruthy()
    expect(tileCanvas!.ctx.ops.filter((o: any) => o[0] === 'fill' && o[2] === '#22aa44').length).toBe(4)
  })
  it('caches atlases per shapeId', () => {
    const a = fillAtlasTexture(THREE, [shapesFill({ a: '#334455', shapeId: 'sparkle', density: 2 })])
    const b = fillAtlasTexture(THREE, [shapesFill({ a: '#334455', shapeId: 'sun-rays', density: 2 })])
    const aAgain = fillAtlasTexture(THREE, [shapesFill({ a: '#334455', shapeId: 'sparkle', density: 2 })])
    expect(b).not.toBe(a)
    expect(aAgain).toBe(a)
  })
})
