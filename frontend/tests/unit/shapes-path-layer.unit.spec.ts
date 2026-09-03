import { describe, it, expect } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'
import { shapeById } from '../../app/lib/shapes/catalog'
import { shapeGeometry, createShapeLayer, swapShapeLayer, SHAPE_LAYER_DEFAULT_WIDTH } from '../../app/lib/shapes/pathLayer'

// A 20×40 rectangle whose ink box starts at (10,10): centre (20,30).
const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'evenodd', box: [10, 10, 20, 40], sourceColor: '#123456' }

/** Parse "M1,2L3,4…Z" back into number pairs for assertions. */
const pairs = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

describe('shapeGeometry', () => {
  it('recentres on the ink box and scales to the target width', () => {
    const g = shapeGeometry(tall, 0.5)
    // k = 0.5 / 20 = 0.025 → half extents 0.25 × 0.5
    expect(g.bbox.w).toBeCloseTo(0.5, 9)
    expect(g.bbox.h).toBeCloseTo(1.0, 9)
    const xs = pairs(g.d).filter((_, i) => i % 2 === 0)
    const ys = pairs(g.d).filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-0.25, 9); expect(Math.max(...xs)).toBeCloseTo(0.25, 9)
    expect(Math.min(...ys)).toBeCloseTo(-0.5, 9); expect(Math.max(...ys)).toBeCloseTo(0.5, 9)
    expect(g.d.replace(/[0-9.,-]/g, '')).toBe('MLLLZ')
  })
  it('keeps cubic commands and the fill rule', () => {
    const s = shapeById('circle')!
    const g = shapeGeometry(s, 0.3)
    expect(g.d.startsWith('M')).toBe(true)
    expect(g.d).toMatch(/C/)
    expect(g.bbox.w).toBeCloseTo(0.3, 9)
    expect(g.bbox.h).toBeCloseTo(0.3 * s.box[3] / s.box[2], 9)
  })
  it('rejects a command letter outside M L C Z and a degenerate box', () => {
    expect(() => shapeGeometry({ ...tall, d: 'M0,0A5,5 0 0 1 10,10' }, 0.3)).toThrow(/unsupported/)
    expect(() => shapeGeometry({ ...tall, box: [0, 0, 0, 10] }, 0.3)).toThrow(/tall/)
  })
  it('rejects an odd coordinate count when the stray value is interior, not only at end of string', () => {
    expect(() => shapeGeometry({ ...tall, d: 'M10,10,20L30,10Z' }, 0.3)).toThrow(/odd coordinate count/)
  })
  it('rejects an odd coordinate count at end of string', () => {
    expect(() => shapeGeometry({ ...tall, d: 'M10,10L30' }, 0.3)).toThrow(/odd coordinate count/)
  })
})

describe('createShapeLayer', () => {
  it('builds a centred path layer at the default width with provenance', () => {
    const l = createShapeLayer(tall)
    expect(l.kind).toBe('path')
    expect(l.shapeId).toBe('tall')
    expect(l.x).toBe(0.5); expect(l.y).toBe(0.5); expect(l.rotation).toBe(0); expect(l.opacity).toBe(1)
    expect(l.scale).toBe(1)
    expect(l.bbox.w).toBeCloseTo(SHAPE_LAYER_DEFAULT_WIDTH, 9)
    expect(l.fill).toBe('#3b82f6')
    expect(l.fillRule).toBe('evenodd')
    expect(l.stroke).toBe(''); expect(l.strokeWidth).toBe(0)
    expect(l.id).toMatch(/^shape-/)
  })
  it('honours position, width, fill and id', () => {
    const l = createShapeLayer(tall, { x: 0.2, y: 0.8, targetWidth: 0.1, fill: '#ff0000', id: 'my-shape' })
    expect([l.x, l.y, l.fill, l.id]).toEqual([0.2, 0.8, '#ff0000', 'my-shape'])
    expect(l.bbox.w).toBeCloseTo(0.1, 9)
  })
  it('survives a JSON round trip with its shapeId', () => {
    const l = createShapeLayer(tall)
    expect(JSON.parse(JSON.stringify(l)).shapeId).toBe('tall')
  })
})

describe('swapShapeLayer', () => {
  it('keeps the layout and paint, replaces the geometry', () => {
    const base = { ...createShapeLayer(tall, { x: 0.3, y: 0.6, targetWidth: 0.4, fill: '#00ff00', id: 'k' }), rotation: 15, opacity: 0.5, stroke: '#000000', strokeWidth: 0.01, scale: 1.5 }
    const circle = shapeById('circle')!
    const out = swapShapeLayer(base, circle)
    expect(out.id).toBe('k'); expect(out.x).toBe(0.3); expect(out.y).toBe(0.6)
    expect(out.rotation).toBe(15); expect(out.opacity).toBe(0.5); expect(out.scale).toBe(1.5)
    expect(out.fill).toBe('#00ff00'); expect(out.stroke).toBe('#000000'); expect(out.strokeWidth).toBe(0.01)
    expect(out.bbox.w).toBeCloseTo(0.4, 9)
    expect(out.shapeId).toBe('circle')
    expect(out.fillRule).toBe(circle.fillRule)
    expect(out.d).not.toBe(base.d)
  })
})
