import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// node env has no ImageData — stub a minimal one (matches fill-shapes-tile's FakeCanvas approach).
class FakeImageData {
  data: Uint8ClampedArray; width: number; height: number
  constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4) }
}
beforeAll(() => { vi.stubGlobal('ImageData', FakeImageData) })
afterAll(() => vi.unstubAllGlobals())

import { paperImageData, normalizeFill, FILL_TYPES, DEFAULT_FILL, hexBytes, fillTileKey, type Fill } from '../../app/lib/spacetype/fillTile'

const paper = (over: Partial<Fill> = {}): Fill =>
  ({ ...DEFAULT_FILL, type: 'paper', a: '#f3efe6', b: '#8b7d68', grain: 0.4, density: 12, angle: 0, ...over })

describe('paper fill — registration & model', () => {
  it('is registered in FILL_TYPES', () => { expect(FILL_TYPES).toContain('paper') })

  it('normalizeFill defaults grain to 0.4 and clamps to [0,1]', () => {
    expect(normalizeFill({ type: 'paper' }).grain).toBe(0.4)
    expect(normalizeFill({ type: 'paper', grain: 5 }).grain).toBe(1)
    expect(normalizeFill({ type: 'paper', grain: -2 }).grain).toBe(0)
    expect(normalizeFill({ type: 'paper', grain: 0.25 }).grain).toBeCloseTo(0.25, 6)
  })

  it('drops grain on a non-paper fill', () => {
    expect((normalizeFill({ type: 'solid', grain: 0.4 }) as any).grain).toBeUndefined()
  })
})

describe('paper fill — density controls grain scale (no flat mega-blocks)', () => {
  const channelAt = (img: ImageData, x: number, y: number, ch = 0) => img.data[(y * img.width + x) * 4 + ch]

  it('keeps grain high-frequency at low density (does NOT render one flat block)', () => {
    // The bug this guards: density mapped to a cell up to 24px, drawn as ONE flat value, so a
    // low-density paper fill showed giant pixel-blocks ("blows up the texture"). Grain must stay
    // varied pixel-to-pixel even at the coarsest density — a small neighbourhood is not one colour.
    const img = paperImageData(32, 32, paper({ density: 1, grain: 0.7 }))
    const vals = new Set<number>()
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) vals.add(channelAt(img, x, y))
    expect(vals.size).toBeGreaterThan(1)
  })

  it('density changes the rendered grain (fine ≠ coarse)', () => {
    const fine = paperImageData(24, 24, paper({ density: 32, grain: 0.7 }))
    const coarse = paperImageData(24, 24, paper({ density: 1, grain: 0.7 }))
    expect(Array.from(fine.data)).not.toEqual(Array.from(coarse.data))
  })
})

describe('paperImageData — deterministic grain', () => {
  it('is byte-for-byte deterministic for the same fill', () => {
    const a = paperImageData(16, 16, paper())
    const b = paperImageData(16, 16, paper())
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })

  it('with grain 0 is a flat base color (no grain drawn)', () => {
    const base = hexBytes('#f3efe6')
    const img = paperImageData(8, 8, paper({ grain: 0 }))
    for (let i = 0; i < img.data.length; i += 4) {
      expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual(base)
      expect(img.data[i + 3]).toBe(255)
    }
  })

  it('with grain > 0 varies pixels away from the flat base (grain drew)', () => {
    const base = hexBytes('#f3efe6')
    const img = paperImageData(16, 16, paper({ grain: 0.6 }))
    let varied = 0
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] !== base[0] || img.data[i + 1] !== base[1] || img.data[i + 2] !== base[2]) varied++
    }
    expect(varied).toBeGreaterThan(0)
  })

  it('blends to INTERMEDIATE values (paper ≠ hard two-color noise)', () => {
    // noise emits only exact-a or exact-b bytes; paper interpolates, so some channel
    // value must fall strictly between base and tint for the red channel.
    const baseR = hexBytes('#f3efe6')[0], tintR = hexBytes('#8b7d68')[0]
    const lo = Math.min(baseR, tintR), hi = Math.max(baseR, tintR)
    const img = paperImageData(16, 16, paper({ grain: 0.7 }))
    let intermediate = false
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i]
      if (r > lo && r < hi) { intermediate = true; break }
    }
    expect(intermediate).toBe(true)
  })
})

// ── GPU path ────────────────────────────────────────────────────────────────
// fillTexture's dispatch ends in `: qrTex(...)`. A new shared FILL_TYPES member with no arm
// renders as QR on every GPU surface. paintPaperTile strokes fibres (qr does not), so a paper
// tile records `stroke` ops while a qr tile does not — that distinguishes the two.
class FakeCtx {
  ops: any[] = []
  fillStyle: any = ''; strokeStyle = ''; lineWidth = 0; globalAlpha = 1
  save() {} restore() {}
  fillRect() {} beginPath() {} moveTo() {} lineTo() {}
  stroke() { this.ops.push(['stroke']) }
  putImageData() { this.ops.push(['putImageData']) }
  createLinearGradient() { return { addColorStop() {} } }
  getImageData() { return { data: new Uint8ClampedArray(4) } }
  drawImage() {}
  translate() {} rotate() {} scale() {} clip() {} clearRect() {} setTransform() {}
}
class FakeCanvas { width = 0; height = 0; ctx = new FakeCtx(); getContext() { return this.ctx } }

let gpuCreated: FakeCanvas[] = []
function installGpuDom() {
  vi.stubGlobal('document', { createElement: () => { const c = new FakeCanvas(); gpuCreated.push(c); return c } })
}

import * as THREE from 'three'
import { fillTexture, fillAtlasTexture } from '../../app/lib/spacetype/fills'

describe('paper fill — GPU path (fillTexture)', () => {
  beforeAll(() => installGpuDom())
  it('routes paper through the paper tiler (fibre strokes), NOT qrTex', () => {
    gpuCreated = []
    const tex = fillTexture(THREE, paper({ grain: 0.5 }))
    expect(tex).toBeInstanceOf(THREE.CanvasTexture)
    // At least one produced canvas recorded a putImageData (grain) AND a stroke (fibre) — qr has no stroke.
    const paperTile = gpuCreated.find(c => c.ctx.ops.some((o: any) => o[0] === 'stroke'))
    expect(paperTile).toBeTruthy()
    expect(paperTile!.ctx.ops.some((o: any) => o[0] === 'putImageData')).toBe(true)
  })
  it('caches per grain (changing only grain re-tiles)', () => {
    const a = fillTexture(THREE, paper({ a: '#eeeeee', grain: 0.3 }))
    const b = fillTexture(THREE, paper({ a: '#eeeeee', grain: 0.8 }))
    const aAgain = fillTexture(THREE, paper({ a: '#eeeeee', grain: 0.3 }))
    expect(b).not.toBe(a)
    expect(aAgain).toBe(a)
  })
})

describe('paper fill — GPU atlas (fillAtlasTexture)', () => {
  beforeAll(() => installGpuDom())
  it('stamps a paper tile into the band, not a flat colour', () => {
    gpuCreated = []
    fillAtlasTexture(THREE, [paper({ grain: 0.5 })])
    const tile = gpuCreated.find(c => c.ctx.ops.some((o: any) => o[0] === 'stroke'))
    expect(tile).toBeTruthy()   // a real paper tile (fibres) was stamped, not a flat fillRect band
  })
})

// ── Shared cache key (regression: grain missing from resolve.ts / sliceGlitch.ts caches) ──
describe('fillTileKey — shared cache key', () => {
  it('two paper fills differing ONLY in grain produce DIFFERENT keys', () => {
    const low = fillTileKey(paper({ grain: 0.3 }))
    const high = fillTileKey(paper({ grain: 0.8 }))
    expect(low).not.toBe(high)
  })

  it('two paper fills with the SAME fields produce the SAME key', () => {
    const a = fillTileKey(paper({ grain: 0.5 }))
    const b = fillTileKey(paper({ grain: 0.5 }))
    expect(a).toBe(b)
  })

  it('a shapes fill still keys on shapeId', () => {
    const shapes = (over: Partial<Fill> = {}): Fill =>
      ({ ...DEFAULT_FILL, type: 'shapes', shapeId: 'sparkle', shapeSize: 0.3, shapeGap: 0.1, ...over })
    const a = fillTileKey(shapes({ shapeId: 'sparkle' }))
    const b = fillTileKey(shapes({ shapeId: 'circle' }))
    expect(a).not.toBe(b)
  })

  it('for a non-shapes/non-paper type, the trailing extra segment is empty', () => {
    const noise: Fill = { ...DEFAULT_FILL, type: 'noise' }
    expect(fillTileKey(noise).endsWith('|')).toBe(true)
  })
})
