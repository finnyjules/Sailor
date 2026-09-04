import { describe, it, expect } from 'vitest'
import { renderShapes, renderStudio, studioToSvg, studioFramePad, contentBounds, framePad } from '~/lib/geoshape/render'
import { DEFAULT_CONFIG } from '~/lib/geoshape/config'
import { defaultDoc, mergeStudioDoc, studioDocFromPersisted, newLayerId } from '~/lib/geoshape/studio'

const layerOf = (mark: any, offset?: any) => ({
  layerId: newLayerId(), enabled: true, mark, opacity: 1, blend: 'normal',
  offset: { x: 0, y: 0, scale: 1, rotate: 0, ...(offset ?? {}) },
})

describe('geoshape studio render', () => {
  // ── No-regression: a one-layer doc at native offset must be byte-identical to
  //    the flat single-mark render (same geometry, same order). ──
  it('a one-layer doc renders exactly the single mark', async () => {
    const solo = await renderShapes(DEFAULT_CONFIG)
    const doc = mergeStudioDoc({ layers: [layerOf(DEFAULT_CONFIG)], padding: DEFAULT_CONFIG.padding })
    const stud = await renderStudio(doc)
    expect(stud.length).toBe(solo.length)
    // Command geometry matches shape-for-shape.
    expect(stud.map((s) => s.commands)).toEqual(solo.map((s) => s.commands))
  })

  it('studioDocFromPersisted(legacy) renders identically to renderShapes(config)', async () => {
    const legacy = { ...DEFAULT_CONFIG, shape: 'star', sides: 5, size: 200, padding: 24 }
    const solo = await renderShapes(legacy)
    const doc = studioDocFromPersisted({ config: legacy })
    const stud = await renderStudio(doc)
    expect(stud.map((s) => s.commands)).toEqual(solo.map((s) => s.commands))
  })

  it('disabled layers are skipped', async () => {
    const doc = mergeStudioDoc({
      layers: [layerOf(DEFAULT_CONFIG), { ...layerOf(DEFAULT_CONFIG), enabled: false }],
    })
    const solo = await renderShapes(DEFAULT_CONFIG)
    const stud = await renderStudio(doc)
    expect(stud.length).toBe(solo.length) // only the one enabled layer contributes
  })

  it('two layers concatenate bottom-to-top', async () => {
    const a = await renderShapes(DEFAULT_CONFIG)
    const b = await renderShapes({ ...DEFAULT_CONFIG, shape: 'star', sides: 5 })
    const doc = mergeStudioDoc({ layers: [layerOf(DEFAULT_CONFIG), layerOf({ ...DEFAULT_CONFIG, shape: 'star', sides: 5 })] })
    const stud = await renderStudio(doc)
    expect(stud.length).toBe(a.length + b.length)
    // Base layer's shapes come first (they render underneath).
    expect(stud.slice(0, a.length).map((s) => s.commands)).toEqual(a.map((s) => s.commands))
  })

  it('per-layer offset translates the whole mark', async () => {
    const base = await renderShapes(DEFAULT_CONFIG)
    const b0 = contentBounds(base)
    const doc = mergeStudioDoc({ layers: [layerOf(DEFAULT_CONFIG, { x: 100, y: 40 })] })
    const stud = await renderStudio(doc)
    const b1 = contentBounds(stud)
    // Bounds shift by exactly the offset; extent unchanged.
    expect(b1.minX).toBeCloseTo(b0.minX + 100, 3)
    expect(b1.minY).toBeCloseTo(b0.minY + 40, 3)
    expect(b1.w).toBeCloseTo(b0.w, 3)
    expect(b1.h).toBeCloseTo(b0.h, 3)
  })

  it('per-layer scale grows the mark about its centre', async () => {
    const base = await renderShapes(DEFAULT_CONFIG)
    const b0 = contentBounds(base)
    const doc = mergeStudioDoc({ layers: [layerOf(DEFAULT_CONFIG, { scale: 2 })] })
    const b1 = contentBounds(await renderStudio(doc))
    expect(b1.w).toBeCloseTo(b0.w * 2, 2)
    expect(b1.h).toBeCloseTo(b0.h * 2, 2)
  })

  it('studioFramePad follows the stack padding and the largest enabled stroke', () => {
    const doc = mergeStudioDoc({
      layers: [layerOf({ ...DEFAULT_CONFIG, strokeWidth: 8 }), layerOf({ ...DEFAULT_CONFIG, strokeWidth: 20 })],
      padding: 30,
    })
    // framePad({padding:30, strokeWidth:20}) === 30 + 10.
    expect(studioFramePad(doc)).toBe(framePad({ padding: 30, strokeWidth: 20 }))
    expect(studioFramePad(doc)).toBe(40)
  })

  it('studioFramePad applies the outline fallback PER LAYER', () => {
    // A hairline (0-width) outline layer still draws at 1 unit, so the stack
    // frame must reserve half of it — the same rule framePad applies to a
    // single mark.
    const doc = mergeStudioDoc({
      layers: [layerOf({ ...DEFAULT_CONFIG, strokeWidth: 0, paintTarget: 'outline' })],
      padding: 30,
    })
    expect(studioFramePad(doc)).toBe(30.5)
  })

  it('studioToSvg frames the union bounds and stays a valid document', async () => {
    const doc = mergeStudioDoc({
      layers: [layerOf(DEFAULT_CONFIG), layerOf({ ...DEFAULT_CONFIG, shape: 'star', sides: 5 }, { x: 300 })],
      padding: 20,
    })
    const svg = await studioToSvg(doc)
    expect(svg).toContain('<svg')
    const m = svg.match(/viewBox="([^"]+)"/)
    expect(m).toBeTruthy()
    const [, , w, h] = m![1].trim().split(/[\s,]+/).map(Number)
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
    // The union bounds (base + a star pushed +300 in x) exceed a single mark's width.
    const soloW = contentBounds(await renderShapes(DEFAULT_CONFIG)).w
    expect(w!).toBeGreaterThan(soloW)
  })

  it('defaultDoc renders a non-empty mark', async () => {
    const stud = await renderStudio(defaultDoc())
    expect(stud.length).toBeGreaterThanOrEqual(1)
  })
})
