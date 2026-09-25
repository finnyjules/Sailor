import { describe, it, expect } from 'vitest'
import { baseShapePath, BASE_SHAPES, DEFAULT_LIBRARY_SHAPE } from '~/lib/geoshape/shapes'
import { isShapeId } from '~/lib/shapes/catalog'

const base = { sides: 6, starInner: 0.45, irregularSeed: 1, size: 180, roundCorners: 6, roundRadius: 0 }

describe('geoshape base shapes', () => {
  it('every base shape produces a closed path d', () => {
    // `drawn` is the user's own drawing — empty without one; covered by geoshape-drawn.unit.spec.ts.
    for (const kind of BASE_SHAPES.filter(k => k !== 'drawn')) {
      const d = baseShapePath(kind, base)
      expect(d, kind).toMatch(/^M/)
      expect(d.trim().endsWith('Z'), kind).toBe(true)
      expect(d.length, kind).toBeGreaterThan(10)
    }
  })
  it('the 14 named shapes are all present', () => {
    expect(BASE_SHAPES).toEqual([
      'circle', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon',
      'octagon', 'star', 'semicircle', 'cross', 'leaf', 'irregular', 'library', 'drawn',
    ])
  })
  it('curved shapes (circle/semicircle/leaf) use arc/curve commands', () => {
    expect(baseShapePath('circle', base)).toMatch(/A/)      // arc
    expect(baseShapePath('semicircle', base)).toMatch(/A/)
    expect(baseShapePath('leaf', base)).toMatch(/Q/)         // quadratic
  })
  it('polygonal shapes differ from each other (triangle ≠ hexagon ≠ octagon)', () => {
    const t = baseShapePath('triangle', base)
    const h = baseShapePath('hexagon', base)
    const o = baseShapePath('octagon', base)
    expect(t).not.toBe(h)
    expect(h).not.toBe(o)
  })
  it('irregular is deterministic in its seed and differs across seeds', () => {
    expect(baseShapePath('irregular', base)).toBe(baseShapePath('irregular', base))
    expect(baseShapePath('irregular', base)).not.toBe(baseShapePath('irregular', { ...base, irregularSeed: 2 }))
  })
})

describe('library base shape', () => {
  it('library is second to last, drawn last', () => {
    expect(BASE_SHAPES[BASE_SHAPES.length - 2]).toBe('library')
    expect(BASE_SHAPES[BASE_SHAPES.length - 1]).toBe('drawn')
    expect(BASE_SHAPES.length).toBe(14)
  })
  it('renders a library shape fitted to size', () => {
    const d = baseShapePath('library', { ...base, libraryShape: 'circle' })
    expect(d).toMatch(/^M/); expect(d.trim().endsWith('Z')).toBe(true); expect(d).toMatch(/C/)
    const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(base.size, 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(base.size, 1)
  })
  it('falls back to the default library shape for an unknown id', () => {
    expect(baseShapePath('library', { ...base, libraryShape: 'unicorn' })).toBe(baseShapePath('library', { ...base, libraryShape: DEFAULT_LIBRARY_SHAPE }))
    // …which only holds while the fallback id is itself in the catalog. Pin it:
    // a rename that orphaned DEFAULT_LIBRARY_SHAPE would silently drop every
    // library mark to the catalog's first shape instead.
    expect(isShapeId(DEFAULT_LIBRARY_SHAPE)).toBe(true)
  })
})
