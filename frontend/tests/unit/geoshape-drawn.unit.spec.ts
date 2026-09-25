import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath, addCircle } from '~/lib/sketch/edit'
import { BASE_SHAPES, PICKABLE_SHAPES, baseShapePath, drawnPath } from '~/lib/geoshape/shapes'
import { mergeConfig, DEFAULT_CONFIG } from '~/lib/geoshape/config'
import { flattenPath } from '~/lib/compositor/pathFlatten'
import { reroll, rollShape } from '~/lib/geoshape/randomize'
import { GEO_CONTROLS } from '~/lib/geoshape/controls'

const tri = (): SketchDoc => {
  const d: SketchDoc = { entities: [], constraints: [] }
  const a = addPoint(d, 10, 10), b = addPoint(d, 70, 10), c = addPoint(d, 40, 50)
  addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
  return d
}
const bounds = (d: string) => {
  const pts = flattenPath(d).flatMap(s => s.pts)
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe('drawn base shape', () => {
  it('is appended after library and is not pickable', () => {
    expect(BASE_SHAPES.at(-1)).toBe('drawn')
    expect(BASE_SHAPES.at(-2)).toBe('library')
    expect(PICKABLE_SHAPES).not.toContain('drawn')
    expect(PICKABLE_SHAPES).toHaveLength(BASE_SHAPES.length - 1)
  })
  it('fits the larger side to size, centred on the origin', () => {
    const b = bounds(drawnPath(tri(), 120))
    expect(b.maxX - b.minX).toBeCloseTo(120, 6)          // 60 wide → larger side
    expect(b.maxY - b.minY).toBeCloseTo(80, 6)           // 40 × (120/60)
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6)
  })
  it('is empty for a missing or empty drawing, and never throws on a straight line', () => {
    expect(drawnPath(undefined, 100)).toBe('')
    expect(drawnPath({ entities: [], constraints: [] }, 100)).toBe('')
    const d: SketchDoc = { entities: [], constraints: [] }
    const a = addPoint(d, 0, 0), b = addPoint(d, 50, 0)
    addPath(d, [a, b], [{ kind: 'line' }], false)
    const line = bounds(drawnPath(d, 100))
    expect(line.maxX - line.minX).toBeCloseTo(100, 6)
  })
  it('keeps arcs exact — a circle stays two arcs whose radii scale with the fit', () => {
    const d: SketchDoc = { entities: [], constraints: [] }
    const c = addPoint(d, 30, 40)
    addCircle(d, c, 10)
    const out = drawnPath(d, 100)                        // 20 across → k = 5 → r = 50
    expect(out).toBe('M -50 0 A 50 50 0 0 1 50 0 A 50 50 0 0 1 -50 0 Z')
  })
  it('baseShapePath delegates for the drawn kind', () => {
    expect(baseShapePath('drawn', { sides: 6, starInner: 0.5, irregularSeed: 1, size: 120, roundCorners: 0, roundRadius: 0, sketch: tri() } as any)).toBe(drawnPath(tri(), 120))
  })
  it('mergeConfig keeps a sketch and drops junk in it', () => {
    const cfg = mergeConfig({ ...DEFAULT_CONFIG, shape: 'drawn', sketch: tri() })
    expect(cfg.shape).toBe('drawn')
    expect(cfg.sketch?.entities.length).toBe(4)
    expect(mergeConfig({ ...DEFAULT_CONFIG, sketch: 'nonsense' as any }).sketch?.entities ?? []).toEqual([])
    expect(mergeConfig({ ...DEFAULT_CONFIG }).sketch).toBeUndefined()
  })
  it('a config without a drawing keeps exactly its old key set', () => {
    expect('sketch' in DEFAULT_CONFIG).toBe(false)
    expect('sketch' in mergeConfig({ ...DEFAULT_CONFIG })).toBe(false)
    expect(Object.keys(mergeConfig({}))).toEqual(Object.keys(DEFAULT_CONFIG))
  })
  it('Blend shape B is never the drawing', () => {
    expect(mergeConfig({ ...DEFAULT_CONFIG, blendShape: 'drawn' }).blendShape).toBe(DEFAULT_CONFIG.blendShape)
    expect(GEO_CONTROLS.find(c => c.key === 'blendShape')!.options).not.toContain('drawn')
  })
  it('the shape menu reads in sentence case, one label per kind', () => {
    const c = GEO_CONTROLS.find(c => c.key === 'shape')! as any
    expect(c.options).toEqual(BASE_SHAPES)
    expect(c.optionLabels).toEqual([
      'Circle', 'Square', 'Triangle', 'Diamond', 'Pentagon', 'Hexagon',
      'Octagon', 'Star', 'Semicircle', 'Cross', 'Leaf', 'Irregular', 'Library shape', 'Drawn',
    ])
  })
})

// The list re-roll drew from before `drawn` existed — copied, not imported.
const OLD_SHAPES = [
  'circle', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon',
  'octagon', 'star', 'semicircle', 'cross', 'leaf', 'irregular', 'library',
]
// randomize.ts's pick, re-run here against OLD_SHAPES (xmur3 → mulberry32, first draw of the 'shape' stream).
function oldPick(seed: string, salt: string): string {
  const str = seed + '|' + salt
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19) }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909)
  let a = (h ^= h >>> 16) >>> 0
  a |= 0; a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return OLD_SHAPES[Math.floor(u * OLD_SHAPES.length) % OLD_SHAPES.length]!
}
const fnv = (s: string) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0 } return x.toString(16).padStart(8, '0') }

// Pinned at HEAD 5db881855 (before `drawn`): [config seed, rolled shape, rolled blend shape,
// FNV-1a of JSON.stringify(the whole re-rolled config)].
const PINNED: [number, string, string, string][] = [
  [7919, 'leaf', 'square', '439713eb'],
  [15838, 'square', 'pentagon', '2b59724f'],
  [23757, 'star', 'diamond', '070ea9b0'],
  [31676, 'octagon', 'hexagon', '0b86a270'],
  [39595, 'leaf', 'leaf', 'c07792c2'],
  [47514, 'diamond', 'diamond', '4375cad8'],
  [55433, 'library', 'hexagon', '27ebb58f'],
  [63352, 'leaf', 'triangle', '69c9064d'],
  [71271, 'hexagon', 'semicircle', '67b3ba6c'],
  [79190, 'triangle', 'circle', 'ed94c1cf'],
  [87109, 'irregular', 'leaf', '16486e6d'],
  [95028, 'hexagon', 'irregular', '2ceeaef0'],
  [102947, 'square', 'circle', 'ca5ad37d'],
  [110866, 'library', 'diamond', 'b39127ed'],
  [118785, 'cross', 'triangle', 'fde5cb65'],
  [126704, 'hexagon', 'leaf', '8d01caa3'],
  [134623, 'cross', 'hexagon', 'fb76be12'],
  [142542, 'circle', 'hexagon', '63a90628'],
  [150461, 'irregular', 'library', 'e8a750cc'],
  [158380, 'pentagon', 'pentagon', '635aef43'],
]

describe('re-roll never picks drawn (same seed, same roll as before)', () => {
  it('PICKABLE_SHAPES is exactly the old 13-item list', () => {
    expect(PICKABLE_SHAPES).toEqual(OLD_SHAPES)
  })
  it('rollShape picks what the old list picked, for 20 seeds', () => {
    for (let s = 1; s <= 20; s++) {
      const seed = String(s * 104729)
      expect(rollShape(seed).shape, seed).toBe(oldPick(seed, 'shape'))
    }
  })
  it('the whole re-rolled config is byte-identical to the pinned snapshot, for 20 seeds', () => {
    for (const [seed, shape, blendShape, hash] of PINNED) {
      const r = reroll(mergeConfig({ ...DEFAULT_CONFIG, seed }), {})
      expect(r.shape, String(seed)).toBe(shape)
      expect(r.blendShape, String(seed)).toBe(blendShape)
      expect(fnv(JSON.stringify(r)), String(seed)).toBe(hash)
    }
  })
})
