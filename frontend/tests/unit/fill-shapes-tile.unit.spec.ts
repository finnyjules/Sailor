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

// Shapes now steer count via Size + Spacing (tile fractions), not a raw count. The count
// is DERIVED: d = round(1 / (shapeSize + shapeGap)). The default here (0.2 + 0.05 = 0.25)
// gives d = 4 → a 4×4 = 16 grid. Individual tests override for other clean counts.
const shapesFill = (over: Partial<Fill> = {}): Fill => ({ ...DEFAULT_FILL, type: 'shapes', a: '#ff0000', b: '#000000', shapeId: 'sparkle', shapeSize: 0.2, shapeGap: 0.05, angle: 0, ...over })

/** Derived count for a size+gap pair, mirroring paintShapesTile's `d`. */
const derivedCount = (size: number, gap: number): number => {
  const d = Math.max(1, Math.min(64, Math.round(1 / Math.max(0.02, size + gap))))
  return d * d
}

describe('shapes fill type', () => {
  it('is registered', () => { expect(FILL_TYPES).toContain('shapes') })
  it('draws d×d shape fills in colour a on a colour-b background', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeSize: 0.2, shapeGap: 0.05 }), 120)   // cellFrac 0.25 → d=4 → 16
    const cell = created[0]!.ctx.ops
    // one background fillRect in b, then 16 path fills in a (colour = '#ff0000')
    const bg = cell.find((o: any) => o[0] === 'fillRect')
    expect(bg?.[5]).toBe('#000000')
    const fills = cell.filter((o: any) => o[0] === 'fill' && o[2] === '#ff0000')
    expect(fills.length).toBe(16)
    expect(fills[0]![1]).toBe(shapeById('sparkle')!.d)
  })
  it('leaves the background transparent when b is none', () => {
    created = []
    fillTileCanvas(shapesFill({ b: 'none', shapeSize: 0.4, shapeGap: 0.1 }), 120)   // cellFrac 0.5 → d=2 → 4
    const cell = created[0]!.ctx.ops
    expect(cell.some((o: any) => o[0] === 'fillRect')).toBe(false)
    expect(cell.filter((o: any) => o[0] === 'fill').length).toBe(4)
  })
  it('falls back to sparkle for an unknown shape id', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeId: 'unicorn', shapeSize: 0.5, shapeGap: 0.4 }), 120)   // cellFrac 0.9 → d=1
    expect(created[0]!.ctx.ops.find((o: any) => o[0] === 'fill')![1]).toBe(shapeById('sparkle')!.d)
  })
  it('fillTileBox draws the shapes too, on SQUARE cells', () => {
    created = []
    // cellFrac 0.5 → cols = 2 → cell edge 100px (from the WIDTH). The height is one
    // such cell tall, so a 200×100 box is a 2×1 grid — not the 2×2 of oblong cells.
    fillTileBox(shapesFill({ shapeSize: 0.4, shapeGap: 0.1 }), 200, 100)
    expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill').length).toBe(2)
  })

  // The Spacing = 0 complaint: with one `d` on both axes the cell was as oblong as the
  // box, and drawShape's uniform fit left air on the long axis that Spacing could not
  // close. Square cells + gap 0 ⇒ each shape box IS its cell, so neighbours touch.
  it('at spacing 0 the drawn shape box fills its whole cell', () => {
    created = []
    fillTileBox(shapesFill({ shapeId: 'badge', shapeSize: 0.5, shapeGap: 0 }), 300, 400)
    const ops = created[0]!.ctx.ops
    // cols = round(1/0.5) = 2 → cell 150px; rows = ceil(400/150) = 3 → 6 shapes.
    expect(ops.filter((o: any) => o[0] === 'fill').length).toBe(6)
    // badge's box is 88×88, so a cell-filling draw scales it by 150/88.
    const scale = ops.find((o: any) => o[0] === 'scale')![1]
    expect(scale).toBeCloseTo(150 / 88, 6)
  })

  describe('shapeFit', () => {
    it('fill draws ONE shape scaled to cover the box', () => {
      created = []
      // badge box 88×88 in a 300×400 box → cover scale 400/88, one shape only.
      fillTileBox(shapesFill({ shapeId: 'badge', shapeFit: 'fill' }), 300, 400)
      const ops = created[0]!.ctx.ops
      expect(ops.filter((o: any) => o[0] === 'fill').length).toBe(1)
      expect(ops.find((o: any) => o[0] === 'scale')![1]).toBeCloseTo(400 / 88, 6)
    })
    it('contain draws ONE shape fitted inside the box', () => {
      created = []
      fillTileBox(shapesFill({ shapeId: 'badge', shapeFit: 'contain' }), 300, 400)
      const ops = created[0]!.ctx.ops
      expect(ops.filter((o: any) => o[0] === 'fill').length).toBe(1)
      expect(ops.find((o: any) => o[0] === 'scale')![1]).toBeCloseTo(300 / 88, 6)
    })
    it('ignores Size and Spacing in the single-shape fits', () => {
      created = []
      fillTileBox(shapesFill({ shapeFit: 'contain', shapeSize: 0.05, shapeGap: 0.3 }), 300, 400)
      expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill').length).toBe(1)
    })
    it('still paints the background colour', () => {
      created = []
      fillTileBox(shapesFill({ shapeFit: 'fill', b: '#000000' }), 300, 400)
      expect(created[0]!.ctx.ops.find((o: any) => o[0] === 'fillRect')![5]).toBe('#000000')
    })
    it('normalizeFill defaults it to tile and refuses a bad value', () => {
      expect(normalizeFill({ type: 'shapes' }).shapeFit).toBe('tile')
      expect(normalizeFill({ type: 'shapes', shapeFit: 'cover' }).shapeFit).toBe('tile')
      expect(normalizeFill({ type: 'shapes', shapeFit: 'contain' }).shapeFit).toBe('contain')
      expect((normalizeFill({ type: 'solid', shapeFit: 'fill' }) as any).shapeFit).toBeUndefined()
    })
  })
  it('rotates each shape by angle about the cell centre', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeSize: 0.5, shapeGap: 0.4, angle: 90 }), 120)   // d=1
    expect(created[0]!.ctx.ops.some((o: any) => o[0] === 'rotate' && Math.abs(o[1] - Math.PI / 2) < 1e-6)).toBe(true)
  })

  // The core of the size+gap redesign: the grid count is DERIVED so the pattern still tiles.
  it('derives the grid count from size + gap', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeSize: 0.2, shapeGap: 0.05 }), 120)   // cellFrac 0.25 → d=4
    expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill').length).toBe(16)
    expect(derivedCount(0.2, 0.05)).toBe(16)
    created = []
    fillTileCanvas(shapesFill({ shapeSize: 0.4, shapeGap: 0.1 }), 120)    // cellFrac 0.5 → d=2
    expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill').length).toBe(4)
    expect(derivedCount(0.4, 0.1)).toBe(4)
  })

  // At a FIXED size, a larger gap opens more air around each shape → a smaller drawn shape box.
  // drawShape fits the ink into the target box via `ctx.scale(s, s)` where s ∝ box width, so the
  // recorded scale is a faithful proxy for the box. Both gaps here round to the SAME d (=3, so 9
  // shapes) — isolating the box change from the count change.
  it('a larger gap at fixed size shrinks the drawn shape box (count held)', () => {
    created = []
    fillTileCanvas(shapesFill({ shapeSize: 0.2, shapeGap: 0.1 }), 120)    // cellFrac 0.30 → d=3, fillFrac 0.667
    const opsA = created[0]!.ctx.ops
    const scaleA = opsA.find((o: any) => o[0] === 'scale')![1]
    expect(opsA.filter((o: any) => o[0] === 'fill').length).toBe(9)
    created = []
    fillTileCanvas(shapesFill({ shapeSize: 0.2, shapeGap: 0.13 }), 120)   // cellFrac 0.33 → d=3, fillFrac 0.606
    const opsB = created[0]!.ctx.ops
    const scaleB = opsB.find((o: any) => o[0] === 'scale')![1]
    expect(opsB.filter((o: any) => o[0] === 'fill').length).toBe(9)   // same count
    expect(scaleB).toBeLessThan(scaleA)                                // smaller box
  })
})

describe('normalizeFill + shape size/gap', () => {
  it('carries shapeId for a shapes fill, defaults a bad one to sparkle', () => {
    expect(normalizeFill({ type: 'shapes', shapeId: 'sun-rays' }).shapeId).toBe('sun-rays')
    expect(normalizeFill({ type: 'shapes', shapeId: 42 }).shapeId).toBe('sparkle')
  })
  it('drops shapeId on a non-shapes fill', () => {
    expect((normalizeFill({ type: 'solid', shapeId: 'sun-rays' }) as any).shapeId).toBeUndefined()
  })
  it('derives shapeSize/shapeGap from density when absent (migration)', () => {
    const f = normalizeFill({ type: 'shapes', density: 4 })
    expect(f.shapeSize).toBeCloseTo(0.76 / 4, 6)   // ≈ 0.19
    expect(f.shapeGap).toBeCloseTo(0.24 / 4, 6)     // ≈ 0.06
  })
  it('keeps explicit shapeSize/shapeGap and clamps them', () => {
    const f = normalizeFill({ type: 'shapes', shapeSize: 0.3, shapeGap: 0.12 })
    expect(f.shapeSize).toBeCloseTo(0.3, 6)
    expect(f.shapeGap).toBeCloseTo(0.12, 6)
    const clamped = normalizeFill({ type: 'shapes', shapeSize: 5, shapeGap: -1 })
    expect(clamped.shapeSize).toBe(0.6)   // clamped to [0.01, 0.6]
    expect(clamped.shapeGap).toBe(0)       // clamped to [0, 0.6]
  })
  it('drops shapeSize/shapeGap on a non-shapes fill', () => {
    const f = normalizeFill({ type: 'solid', shapeSize: 0.3, shapeGap: 0.1 }) as any
    expect(f.shapeSize).toBeUndefined()
    expect(f.shapeGap).toBeUndefined()
  })
})

// Regression (final review, Major): `shapes` was added to the shared FILL_TYPES, so it appears
// in the Space Type / Shape Studio pickers whose GPU render path is fillTexture(). fillTexture
// had no `shapes` arm and silently fell through to qrTex — a shapes fill rendered as a QR lattice.
// These assert fillTexture now routes `shapes` through the real shape tiler (fillTileCanvas →
// paintShapesTile → drawShape → ctx.fill(Path2D)), not qrTex, and that the cache keys on shape.
import * as THREE from 'three'
import { fillTexture } from '../../app/lib/spacetype/fills'

describe('fillTexture (GPU path) — shapes', () => {
  it('routes a shapes fill through the shape tiler (Path2D fills), NOT qrTex', () => {
    created = []
    const tex = fillTexture(THREE, shapesFill({ a: '#0055ff', shapeId: 'sun-rays', shapeSize: 0.2, shapeGap: 0.05 }))
    expect(tex).toBeInstanceOf(THREE.CanvasTexture)
    const ops = created[0]!.ctx.ops
    const fills = ops.filter((o: any) => o[0] === 'fill' && o[2] === '#0055ff')
    expect(fills.length).toBe(16)                         // d=4 → 4×4 grid of shapes
    expect(fills[0]![1]).toBe(shapeById('sun-rays')!.d)   // the picked shape, not sparkle/qr
  })
  it('caches shapes textures per shapeId (two shapes ≠ same texture)', () => {
    const t1 = fillTexture(THREE, shapesFill({ a: '#abcdef', shapeId: 'sparkle', shapeSize: 0.4, shapeGap: 0.1 }))
    const t2 = fillTexture(THREE, shapesFill({ a: '#abcdef', shapeId: 'sun-rays', shapeSize: 0.4, shapeGap: 0.1 }))
    const t1again = fillTexture(THREE, shapesFill({ a: '#abcdef', shapeId: 'sparkle', shapeSize: 0.4, shapeGap: 0.1 }))
    expect(t2).not.toBe(t1)      // different shape → different cache entry
    expect(t1again).toBe(t1)     // same shape → cache hit
  })
  it('caches shapes textures per size/gap (changing only shapeSize re-tiles)', () => {
    const a = fillTexture(THREE, shapesFill({ a: '#0abed0', shapeId: 'sparkle', shapeSize: 0.2, shapeGap: 0.05 }))
    const b = fillTexture(THREE, shapesFill({ a: '#0abed0', shapeId: 'sparkle', shapeSize: 0.45, shapeGap: 0.05 }))
    const aAgain = fillTexture(THREE, shapesFill({ a: '#0abed0', shapeId: 'sparkle', shapeSize: 0.2, shapeGap: 0.05 }))
    expect(b).not.toBe(a)        // only shapeSize differs → different cache entry
    expect(aAgain).toBe(a)       // identical fill → cache hit
  })
})

// Regression (final review, follow-up): fillAtlasTexture (the shutter/coil per-band atlas) is a
// SECOND, independent GPU tile builder that never calls fillTexture — its `else` branch rendered a
// shapes fill as a flat `a`-colour band, and its cache key omitted the shape. Assert it now stamps
// the shape tile (Path2D fills) and keys on the shape.
import { fillAtlasTexture } from '../../app/lib/spacetype/fills'

describe('fillAtlasTexture (shutter/coil atlas) — shapes', () => {
  it('stamps the shape tile into the band, not a flat colour', () => {
    created = []
    fillAtlasTexture(THREE, [shapesFill({ a: '#22aa44', shapeId: 'sun-rays', shapeSize: 0.4, shapeGap: 0.1 })])
    // the atlas canvas is created[0]; the stamped tile is a nested canvas created by fillTileCanvas
    const tileCanvas = created.find(c => c.ctx.ops.some((o: any) => o[0] === 'fill' && o[2] === '#22aa44'))
    expect(tileCanvas).toBeTruthy()
    expect(tileCanvas!.ctx.ops.filter((o: any) => o[0] === 'fill' && o[2] === '#22aa44').length).toBe(4)   // d=2 → 4
  })
  it('caches atlases per shapeId', () => {
    const a = fillAtlasTexture(THREE, [shapesFill({ a: '#334455', shapeId: 'sparkle', shapeSize: 0.4, shapeGap: 0.1 })])
    const b = fillAtlasTexture(THREE, [shapesFill({ a: '#334455', shapeId: 'sun-rays', shapeSize: 0.4, shapeGap: 0.1 })])
    const aAgain = fillAtlasTexture(THREE, [shapesFill({ a: '#334455', shapeId: 'sparkle', shapeSize: 0.4, shapeGap: 0.1 })])
    expect(b).not.toBe(a)
    expect(aAgain).toBe(a)
  })
})

describe('paintShapesTile self-migration (density-only fill)', () => {
  it('renders a density-only shapes fill at its saved count, not a flat fallback', () => {
    // A shapes fill that skipped normalizeFill (e.g. a compositor Paint fed straight to the tile
    // builder) may carry only the legacy `density`. paintShapesTile derives size/gap from it.
    created = []
    fillTileCanvas({ ...DEFAULT_FILL, type: 'shapes', shapeId: 'sparkle', a: '#ff0000', b: '#000000', density: 4 } as Fill, 120)
    // density 4 → size 0.19, gap 0.06 → cellFrac 0.25 → d = 4 → 16 shapes (not the 0.1/0.03 fallback's ~8²).
    expect(created[0]!.ctx.ops.filter((o: any) => o[0] === 'fill' && o[2] === '#ff0000').length).toBe(16)
  })
})
