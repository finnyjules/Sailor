import { beforeEach, describe, expect, it } from 'vitest'
import { alignPieces, clearMorphCache, prepareMorph, ringsFromD, splitPieces } from '~/lib/vector/morphPieces'

const sq = (x: number, y: number, s: number) => `M${x} ${y} L${x + s} ${y} L${x + s} ${y + s} L${x} ${y + s} Z`
const bbox = (d: string) => {
  const r = ringsFromD(d).flat()
  const xs = r.map(p => p[0]), ys = r.map(p => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

beforeEach(() => clearMorphCache())

describe('pieces', () => {
  it('reads a path into closed rings', () => {
    const r = ringsFromD(sq(0, 0, 10))
    expect(r).toHaveLength(1)
    expect(r[0]!.length).toBeGreaterThanOrEqual(4)
  })
  it('groups holes with the ring around them, in reading order', () => {
    // "o" at x=100 (ring + hole), "l" at x=0, "i" at x=50 (stem + dot above)
    const d = sq(100, 0, 40) + sq(110, 10, 20) + sq(0, 0, 10) + sq(50, 10, 10) + sq(50, -10, 10)
    const p = splitPieces(ringsFromD(d))
    expect(p).toHaveLength(4)
    expect(p.map(x => Math.round(x.cx))).toEqual([5, 55, 55, 120])
    expect(p[3]!.rings).toHaveLength(2)
  })
})

// A w×h box with its top-left at (x, y).
const box = (x: number, y: number, w: number, h: number) => `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`

describe('pieces: lines (final review #5)', () => {
  it('two lines with tight leading stay two lines when a line-1 letter hangs 30% into line 2', () => {
    // Line 1: four letters 0..100; the last hangs to 130 (a descender dipping into line 2's
    // capitals, beside them). Line 2: three letters 100..200, zero gap. Given scrambled.
    const d = box(60, 100, 20, 100) + box(0, 0, 20, 100) + box(90, 0, 20, 130) + box(0, 100, 20, 100)
      + box(60, 0, 20, 100) + box(30, 100, 20, 100) + box(30, 0, 20, 100)
    const p = splitPieces(ringsFromD(d))
    expect(p.map(x => [Math.round(x.cx), Math.round(x.cy)])).toEqual([
      [10, 50], [40, 50], [70, 50], [100, 65], // line 1, left to right
      [10, 150], [40, 150], [70, 150], //         line 2, left to right
    ])
  })
  it('an `i` (stem + small dot above) stays on its own line, stem before dot', () => {
    // A line above (y −120..−20), then "hil": h 0..100, i's stem 40..100 and dot 15..27, l 0..100.
    const d = box(0, -120, 20, 100) + box(30, -120, 20, 100)
      + box(30, 15, 10, 12) + box(0, 0, 20, 100) + box(30, 40, 10, 60) + box(50, 0, 10, 100)
    const p = splitPieces(ringsFromD(d))
    expect(p.map(x => [Math.round(x.cx), Math.round(x.cy)])).toEqual([
      [10, -70], [40, -70],
      [10, 50], [35, 70], [35, 21], [55, 50],
    ])
  })
})

describe('alignPieces', () => {
  it('pairs one to one when counts match', () => {
    expect(alignPieces(3, 3)).toEqual([{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: 2, b: 2 }])
  })
  it('keeps order and gives every extra a partner when counts differ', () => {
    const links = alignPieces(2, 4)
    expect(links.filter(l => l.a != null && l.b != null)).toHaveLength(2)
    const extras = links.filter(l => l.a == null)
    expect(extras).toHaveLength(2)
    for (const e of extras) expect(links[e.partner!]!.a).not.toBeNull()
    // Controller ruling: the brief's "all links' b sorted" assertion can never
    // hold because extras are appended after the matched links. Instead check
    // that the MATCHED links, in the order they appear, have strictly
    // increasing a AND strictly increasing b.
    const matched = links.filter(l => l.a != null && l.b != null)
    const as = matched.map(l => l.a!)
    const bs = matched.map(l => l.b!)
    expect(as).toEqual([...as].sort((x, y) => x - y))
    expect(new Set(as).size).toBe(as.length)
    expect(bs).toEqual([...bs].sort((x, y) => x - y))
    expect(new Set(bs).size).toBe(bs.length)
  })
})

describe('prepareMorph', () => {
  const A = sq(0, 0, 20) + sq(40, 0, 20)
  const B = sq(0, 100, 30) + sq(60, 100, 30) + sq(120, 100, 30)
  for (const style of ['letters', 'shape'] as const) {
    it(`${style}: starts as A, ends as B, no NaN between`, () => {
      const f = prepareMorph(A, B, style)
      expect(bbox(f(0)).map(Math.round)).toEqual(bbox(A).map(Math.round))
      expect(bbox(f(1)).map(Math.round)).toEqual(bbox(B).map(Math.round))
      expect(f(0.5)).not.toMatch(/NaN/)
    })
  }
  it('caches by outline pair and style', () => {
    expect(prepareMorph(A, B, 'letters')).toBe(prepareMorph(A, B, 'letters'))
    expect(prepareMorph(A, B, 'shape')).not.toBe(prepareMorph(A, B, 'letters'))
  })
  it('returns an empty path for an empty side', () => {
    expect(prepareMorph('', B, 'letters')(0.5)).toBe('')
  })
  // USER 09-24: "letter by letter doesnt seem to work" — it paired letters but turned them all at
  // once, so it looked like Whole shape. Letters now start one after another across the bar.
  it('letters: turns one letter after another; shape turns them together', () => {
    const a = sq(0, 0, 10) + sq(100, 0, 10), b = sq(0, 0, 30) + sq(100, 0, 30)
    const width = (d: string, right: boolean) => {
      const xs = ringsFromD(d).filter(r => (r[0]![0] > 50) === right).flat().map(p => p[0])
      return Math.max(...xs) - Math.min(...xs)
    }
    const widthLeft = (d: string) => width(d, false), widthRight = (d: string) => width(d, true)
    const L = prepareMorph(a, b, 'letters'), S = prepareMorph(a, b, 'shape')
    expect(widthLeft(L(0.25))).toBeGreaterThan(12)            // the first letter is under way…
    expect(widthRight(L(0.25))).toBeCloseTo(10, 0)            // …the last has not started
    expect(widthLeft(L(0.75))).toBeCloseTo(30, 0)             // the first has landed…
    expect(widthRight(L(0.75))).toBeLessThan(28)              // …the last is still turning
    expect(widthRight(S(0.25))).toBeGreaterThan(12)           // whole shape: all at once
  })
})
