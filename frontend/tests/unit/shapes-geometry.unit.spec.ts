import { describe, it, expect } from 'vitest'
import type { LibraryShape } from '../../shared/shape-library'
import { fitShapePath, transformShapePath } from '../../app/lib/shapes/geometry'
import { shapeById } from '../../app/lib/shapes/catalog'

const tall: LibraryShape = { id: 'tall', name: 'Tall', d: 'M10,10L30,10L30,50L10,50Z', fillRule: 'nonzero', box: [10, 10, 20, 40], sourceColor: '#000' }
const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

describe('transformShapePath', () => {
  it('recentres on (cx, cy) and scales by k, keeping only M L C Z', () => {
    expect(transformShapePath(tall, 0.5, 20, 30)).toBe('M-5,-10L5,-10L5,10L-5,10Z')
  })
  it('rejects arcs and a leading number', () => {
    expect(() => transformShapePath({ ...tall, d: 'M0,0A1,1 0 0 1 2,2' }, 1, 0, 0)).toThrow(/unsupported/)
    expect(() => transformShapePath({ ...tall, d: '1,2L3,4Z' }, 1, 0, 0)).toThrow(/must start with a command/)
  })
})

describe('fitShapePath', () => {
  it('fits the larger ink side to size, centred on the origin', () => {
    const g = fitShapePath(tall, 100)          // 20×40 box → height is the larger side → k = 2.5
    expect(g.w).toBeCloseTo(50, 9); expect(g.h).toBeCloseTo(100, 9)
    const xs = nums(g.d).filter((_, i) => i % 2 === 0), ys = nums(g.d).filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeCloseTo(-25, 9); expect(Math.max(...xs)).toBeCloseTo(25, 9)
    expect(Math.min(...ys)).toBeCloseTo(-50, 9); expect(Math.max(...ys)).toBeCloseTo(50, 9)
  })
  it('a real wide shape fits by width', () => {
    const s = shapeById('sun-rectangle')!
    const [, , bw, bh] = s.box
    const g = fitShapePath(s, 180)
    if (bw >= bh) { expect(g.w).toBeCloseTo(180, 6); expect(g.h).toBeCloseTo(180 * bh / bw, 6) }
    else { expect(g.h).toBeCloseTo(180, 6) }
  })
  it('throws on a degenerate box, naming the shape', () => {
    expect(() => fitShapePath({ ...tall, box: [0, 0, 0, 5] }, 10)).toThrow(/tall/)
  })
})
