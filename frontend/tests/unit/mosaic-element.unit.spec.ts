/**
 * The Mosaic element: a playgrnd-style generative composition as ONE layer, added
 * from the toolbar's Shapes menu and tuned in the inspector. Internally it is the
 * `deal` layer kind (persisted data untouched); "Mosaic" is the label people see.
 */
import { describe, it, expect } from 'vitest'
import { TOOLBAR_SHAPES, resolveShapeFace, shapeFaceLabel } from '~/lib/compositor/toolbarMenus'
import { newMosaicLayer } from '~/composables/useCompositorLayers'

describe('Mosaic in the Shapes menu', () => {
  it('is a row beside the primitive shapes, after Star and before the library', () => {
    const ids = TOOLBAR_SHAPES.map(s => s.id)
    expect(ids).toContain('mosaic')
    expect(ids.indexOf('mosaic')).toBe(ids.indexOf('star') + 1)
    expect(ids.indexOf('mosaic')).toBe(ids.indexOf('library') - 1)
    expect(TOOLBAR_SHAPES.find(s => s.id === 'mosaic')!.label).toBe('Mosaic')
  })
  it('can be worn as the last-used face, titled "Add mosaic" by the face button', () => {
    expect(resolveShapeFace('mosaic')).toBe('mosaic')
    expect('Add ' + shapeFaceLabel('mosaic').toLowerCase()).toBe('Add mosaic')
  })
})

describe('newMosaicLayer — what the stamp creates', () => {
  it('is a frame-filling deal layer in the Modular style', () => {
    const l = newMosaicLayer(9 / 16)
    expect(l.kind).toBe('deal')
    expect(l.cellFill).toBe('modular')
    expect(l).toMatchObject({ x: 0.5, y: 0.5, w: 1, h: 9 / 16, rotation: 0, opacity: 1 })
    expect(l.modular).toBeDefined()
    // A fresh mosaic has its own generated grid (never the frame's), so it is non-empty.
    expect(l.grid.mode).toBe('generated')
    expect(l.grid.gen.seed).toBeGreaterThan(0)
  })
  it('a portrait frame gives h > 1; a bad aspect falls back to square', () => {
    expect(newMosaicLayer(4 / 3).h).toBeCloseTo(4 / 3)
    expect(newMosaicLayer(0).h).toBe(1)
    expect(newMosaicLayer(Number.NaN).h).toBe(1)
  })
  it('two stamps are distinct layers', () => {
    expect(newMosaicLayer(1).id).not.toBe(newMosaicLayer(1).id)
  })
})
