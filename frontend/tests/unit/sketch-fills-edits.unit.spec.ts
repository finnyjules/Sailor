// tests/unit/sketch-fills-edits.unit.spec.ts
// Pen stage 7: the edits that rename or copy pieces carry fills themselves —
// Cut and Dissolve keep a seed on its piece, merging points renames it,
// Repeat and Mirror copy a fill whose whole area they copy (circles too,
// mirrored seeds on the other side), Copy / Paste take fills along (a paste
// turned upside down too; one side of an area takes none), Flip keeps a
// filled shape filled.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, FillSeed } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, repeatEntities, mirrorEntities } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { cutAt, dissolveAt, mergePoints } from '~/lib/sketch/trim'
import { extractPieces, insertPieces, scalePieces } from '~/lib/sketch/clipboard'
import { fillState, toggleFillAt, reconcileFills, flipSeeds, fillsWithin } from '~/lib/sketch/fills'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function poly(d: SketchDoc, pts: number[][]) {
  const ids = pts.map(([x, y]) => addPoint(d, x!, y!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
const anchorsOf = (d: SketchDoc, id: string) => (d.entities.find(e => e.id === id) as { anchors: string[] }).anchors

describe('Cut, Dissolve and merging points carry the seed', () => {
  it('four cuts and a dissolve leave the square filled by the same fill', () => {
    const d = doc()
    const P = poly(d, [[0, 0], [4, 0], [4, 4], [0, 4]])
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const id = d.fills![0]!.id
    for (let i = 0; i < 4; i++) {
      expect(cutAt(d, { kind: 'seg', pathId: P, segIndex: i * 2 }, 0.3)).toBeTruthy()
      expect(fillState(d).filled).toHaveLength(1)
    }
    expect(anchorsOf(d, P)).toHaveLength(8)
    expect(dissolveAt(d, P, 1, 1e-6, 0.5).ok).toBe(true)
    expect(fillState(d).filled).toHaveLength(1)
    expect(d.fills!.map(f => f.id)).toEqual([id])
  })
  it('a cut line entity: the seed moves to the half it lies on', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 2, 3)
    const L = addLine(d, a, b); addLine(d, b, c); addLine(d, c, a)
    toggleFillAt(d, { x: 2, y: 1 }, 0)
    for (const t of [0.25, 0.5]) {
      const lines = d.entities.filter(e => e.kind === 'line')
      for (const l of lines) cutAt(d, { kind: 'line', id: l.id }, t)
      expect(fillState(d).filled).toHaveLength(1)
    }
    expect(L).toBeTruthy()
  })
  it('merging a seed’s point into another renames it in the seed', () => {
    const d = doc()
    const P = poly(d, [[0, 0], [4, 0], [4, 4], [0, 4]])
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const from = d.fills![0]!.seed.a
    const at = d.entities.find(e => e.id === from) as { x: number; y: number }
    const x = addPoint(d, at.x, at.y)   // a second point on the same corner (a drop-to-join)
    expect(mergePoints(d, from, x)).toBe(true)
    expect(d.fills![0]!.seed.a === x || d.fills![0]!.seed.b === x).toBe(true)
    expect(fillState(d).filled).toHaveLength(1)
    expect(P).toBeTruthy()
  })
})

describe('copies carry the fills of what they copy whole', () => {
  it('Repeat: a filled petal ×6 is six filled petals', () => {
    const d = doc()
    const c = addPoint(d, 0, 0)
    const P = poly(d, [[3, -0.5], [5, 0], [3, 0.5]])
    toggleFillAt(d, { x: 3.5, y: 0 }, 0)
    repeatEntities(d, [P], c, 6)
    expect(d.fills).toHaveLength(6)
    expect(fillState(d).filled).toHaveLength(6)
  })
  it('Repeat: a filled circle ×4 is four filled circles', () => {
    const d = doc()
    const C = addCircle(d, addPoint(d, 4, 0), 1)
    toggleFillAt(d, { x: 4, y: 0.2 }, 0)
    repeatEntities(d, [C], addPoint(d, 0, 0), 4)
    expect(fillState(d).filled).toHaveLength(4)
  })
  it('Mirror: the copy is filled — lines and arcs', () => {
    const d = doc()
    const ax = addLine(d, addPoint(d, 0, -5), addPoint(d, 0, 5))
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    mirrorEntities(d, [P], ax)
    expect(fillState(d).filled).toHaveLength(2)
    const e = doc()
    const ax2 = addLine(e, addPoint(e, 0, -5), addPoint(e, 0, 5))
    const a = addPoint(e, 1, 0), b = addPoint(e, 3, 0)
    const Q = addPath(e, [a, b], [{ kind: 'arc', center: addPoint(e, 2, 0), sweep: 1 }, { kind: 'line' }], true)
    toggleFillAt(e, { x: 2, y: -0.5 }, 0)
    expect(fillState(e).filled).toHaveLength(1)
    mirrorEntities(e, [Q], ax2)
    expect(fillState(e).filled).toHaveLength(2)
  })
  it('Copy / Paste take the fill along — upside down too; one side of an area takes none', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0.1)
    const clip = extractPieces(d, [P], [])
    expect(clip.fills).toHaveLength(1)
    expect(clip.fillGap).toBe(0.1)
    insertPieces(d, clip, { x: 5, y: 0 })
    expect(fillState(d).filled).toHaveLength(2)
    insertPieces(d, scalePieces(clip, 2, true), { x: 12, y: 0 })
    expect(fillState(d).filled).toHaveLength(3)
    expect(extractPieces(d, [], [{ pathId: P, segIndex: 0 }]).fills).toBeUndefined()
    // pasting into a drawing without fills brings the copy's gap along
    const e = doc()
    insertPieces(e, clip, { x: 0, y: 0 })
    expect(e.fillGap).toBe(0.1)
    expect(fillState(e).filled).toHaveLength(1)
  })
  it('fillsWithin: only fills whose whole area is made of the given points', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    const all = new Set([P, ...anchorsOf(d, P)])
    expect(fillsWithin(d, all)).toHaveLength(1)
    expect(fillsWithin(d, new Set(anchorsOf(d, P).slice(0, 2)))).toHaveLength(0)
  })
})

describe('Flip', () => {
  it('a filled triangle flipped in place stays filled', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    const before = cloneDoc(d)
    flipSeeds(d, new Set([P, ...anchorsOf(d, P)]), 'h')
    for (const e of d.entities) if (e.kind === 'point') e.x = 4 - e.x
    expect(fillState(d).filled).toHaveLength(1)
    const next = reconcileFills(before, d)
    expect(next).toHaveLength(1)
  })
})

describe('carrying never guesses', () => {
  it('a cut arc: the seed moves onto the half it lies on (either way round)', () => {
    const d = doc()
    const a = addPoint(d, -2, 0), b = addPoint(d, 2, 0)
    const Q = addPath(d, [a, b], [{ kind: 'arc', center: addPoint(d, 0, 0), sweep: 1 }, { kind: 'line' }], true)
    toggleFillAt(d, { x: 0, y: -1 }, 0)
    const id = d.fills![0]!.id
    for (const t of [0.2, 0.7, 0.5]) {
      const seg = (d.entities.find(e => e.id === Q) as { segments: { kind: string }[] }).segments.findIndex(s => s.kind === 'arc')
      expect(cutAt(d, { kind: 'seg', pathId: Q, segIndex: seg }, t)).toBeTruthy()
      expect(fillState(d).filled).toHaveLength(1)
      expect(fillState(d).asleep).toHaveLength(0)
    }
    expect(d.fills!.map(f => f.id)).toEqual([id])
  })
  it('Repeat of a square without its diagonal copies neither half’s fill', () => {
    const d = doc()
    const P = poly(d, [[2, 0], [4, 0], [4, 2], [2, 2]])
    const [p0, , p2] = anchorsOf(d, P)
    addLine(d, p0!, p2!)
    toggleFillAt(d, { x: 3.5, y: 0.5 }, 0)
    expect(fillState(d).filled).toHaveLength(1)
    repeatEntities(d, [P], addPoint(d, 0, 0), 2)
    expect(d.fills).toHaveLength(1)
  })
  it('Copy of two of a triangle’s three sides takes no fill', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0)
    expect(extractPieces(d, [], [{ pathId: P, segIndex: 0 }, { pathId: P, segIndex: 1 }]).fills).toBeUndefined()
    const all = extractPieces(d, [], [0, 1, 2].map(i => ({ pathId: P, segIndex: i })))
    expect(all.fills).toHaveLength(1)
  })
  it('a paste into a drawing with gap-less fills leaves it gap-less', () => {
    const d = doc()
    const P = poly(d, [[1, 0], [3, 0], [2, 2]])
    toggleFillAt(d, { x: 2, y: 0.5 }, 0.1)
    const clip = extractPieces(d, [P], [])
    const e = doc()
    poly(e, [[10, 0], [12, 0], [11, 2]])
    toggleFillAt(e, { x: 11, y: 0.5 }, 0)
    expect(e.fillGap).toBeUndefined()
    insertPieces(e, clip, { x: 0, y: 0 })
    expect(e.fillGap).toBeUndefined()
    expect(fillState(e).filled).toHaveLength(2)
  })
})

// which areas are filled, by their boxes — the halves of a cut piece border
// DIFFERENT areas below (a spoke or a chord splits them), so a seed moved onto
// the wrong half, at the wrong t, or reflected the wrong way fills the wrong one
function filledBoxes(d: SketchDoc) {
  const st = fillState(d)
  expect(st.asleep).toHaveLength(0)
  return st.filled.map(f => st.fs.faces[f]!.box)
}
const midX = (b: { x0: number; x1: number }) => (b.x0 + b.x1) / 2
const midY = (b: { y0: number; y1: number }) => (b.y0 + b.y1) / 2
const setSeed = (d: SketchDoc, seed: FillSeed) => { d.fills = [{ id: 'F1', seed }] }
const segOf = (d: SketchDoc, P: string, a: string) => anchorsOf(d, P).indexOf(a)

describe('the seed lands on the right half (faces split by a spoke or a chord)', () => {
  // square 0..2 with a spoke at x = 1; the fill is the LEFT half, seeded on
  // the bottom side at x = 0.8 (near the spoke, so a t off by the
  // dissolve's share lands on the right half) — named along the side and the other way round
  for (const way of ['along', 'reversed'] as const) {
    it(`square + spoke: cuts at 0.5 then 0.25, then dissolves — the left half stays filled (seed ${way})`, () => {
      const d = doc()
      const P = poly(d, [[0, 0], [2, 0], [2, 2], [0, 2]])
      addLine(d, addPoint(d, 1, 0), addPoint(d, 1, 2))
      const [a0, a1] = anchorsOf(d, P) as [string, string]
      setSeed(d, way === 'along' ? { kind: 'line', a: a0, b: a1, t: 0.4, side: 1 } : { kind: 'line', a: a1, b: a0, t: 0.6, side: -1 })
      const left = () => { const bs = filledBoxes(d); expect(bs).toHaveLength(1); expect(bs[0]!.x1).toBeLessThan(1 + 1e-6); expect(bs[0]!.x0).toBeLessThan(1e-6) }
      left()
      const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!   // x at (1, 0): the seed is on a0→x, t 0.8
      left()
      const y = cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.25)!  // y at (0.25, 0): the seed is on y→x
      left()
      const s = d.fills![0]!.seed
      expect([s.a, s.b].sort()).toEqual([x, y].sort())
      expect(dissolveAt(d, P, segOf(d, P, y), 1e-6, 0.5).ok).toBe(true)
      left()
      expect(dissolveAt(d, P, segOf(d, P, x), 1e-6, 0.5).ok).toBe(true)
      left()
      expect(anchorsOf(d, P)).toHaveLength(4)
    })
  }
  it('square + spoke: a seed on the right half stays on the right half', () => {
    const d = doc()
    const P = poly(d, [[0, 0], [2, 0], [2, 2], [0, 2]])
    addLine(d, addPoint(d, 1, 0), addPoint(d, 1, 2))
    const [a0, a1] = anchorsOf(d, P) as [string, string]
    setSeed(d, { kind: 'line', a: a0, b: a1, t: 0.75, side: 1 })
    const x = cutAt(d, { kind: 'seg', pathId: P, segIndex: 0 }, 0.5)!
    cutAt(d, { kind: 'seg', pathId: P, segIndex: 1 }, 0.25)
    let bs = filledBoxes(d); expect(bs).toHaveLength(1); expect(bs[0]!.x0).toBeGreaterThan(1 - 1e-6)
    expect(dissolveAt(d, P, segOf(d, P, x) + 1, 1e-6, 0.5).ok).toBe(true)
    expect(dissolveAt(d, P, segOf(d, P, x), 1e-6, 0.5).ok).toBe(true)
    bs = filledBoxes(d); expect(bs).toHaveLength(1); expect(bs[0]!.x0).toBeGreaterThan(1 - 1e-6)
  })
  // half-disc of radius 2 (the arc below for sweep 1, above for sweep 0) with
  // a spoke from the centre to the arc's middle; the fill is the LEFT quarter,
  // seeded on the arc 0.4 of the way from its start (near the spoke)
  for (const sweep of [1, 0] as const) {
    for (const way of ['along', 'reversed'] as const) {
      it(`half-disc (sweep ${sweep}) + spoke: arc cuts at 0.7 then 0.1, then dissolves — the left quarter stays filled (seed ${way})`, () => {
        const d = doc()
        const a = addPoint(d, -2, 0), b = addPoint(d, 2, 0), o = addPoint(d, 0, 0)
        const Q = addPath(d, [a, b], [{ kind: 'arc', center: o, sweep }, { kind: 'line' }], true)
        addLine(d, addPoint(d, 0, 0), addPoint(d, 0, sweep === 1 ? -2 : 2))
        const ccw = sweep === 1, side: 1 | -1 = ccw ? 1 : -1
        setSeed(d, way === 'along' ? { kind: 'arc', a, b, c: o, ccw, t: 0.4, side } : { kind: 'arc', a: b, b: a, c: o, ccw: !ccw, t: 0.6, side: side === 1 ? -1 : 1 })
        const leftQuarter = () => {
          const bs = filledBoxes(d); expect(bs).toHaveLength(1)
          expect(bs[0]!.x1).toBeLessThan(1e-6); expect(bs[0]!.x0).toBeLessThan(-1.9)
          expect(Math.sign(midY(bs[0]!))).toBe(sweep === 1 ? -1 : 1)
        }
        leftQuarter()
        const x = cutAt(d, { kind: 'seg', pathId: Q, segIndex: 0 }, 0.7)!
        leftQuarter()
        const y = cutAt(d, { kind: 'seg', pathId: Q, segIndex: 0 }, 0.1)!
        leftQuarter()
        expect(dissolveAt(d, Q, segOf(d, Q, y), 1e-6, 0.5).ok).toBe(true)
        leftQuarter()
        expect(dissolveAt(d, Q, segOf(d, Q, x), 1e-6, 0.5).ok).toBe(true)
        leftQuarter()
        expect(anchorsOf(d, Q)).toHaveLength(2)
      })
    }
  }
})

describe('copies fill the copied area, not its neighbour (a circle cut by a chord)', () => {
  // unit circle about (cx, cy) with a chord at y = cy + 0.5; the CAP (above
  // the chord) is filled, seeded on the circle at the top (t = 0.25)
  function capped(d: SketchDoc, cx: number, cy: number) {
    const o = addPoint(d, cx, cy)
    const C = addCircle(d, o, 1)
    const h = Math.sqrt(0.75)
    const L = addLine(d, addPoint(d, cx - h, cy + 0.5), addPoint(d, cx + h, cy + 0.5))
    setSeed(d, { kind: 'circle', a: C, b: C, c: o, t: 0.25, side: 1 })
    const bs = filledBoxes(d)
    expect(bs).toHaveLength(1); expect(bs[0]!.y0).toBeGreaterThan(cy + 0.49)
    return [C, L]
  }
  it('Mirror across a horizontal axis: the copy’s cap is below its chord', () => {
    const d = doc()
    const ids = capped(d, 0, 0)
    const ax = addLine(d, addPoint(d, -5, -3), addPoint(d, 5, -3))
    mirrorEntities(d, ids, ax)
    const bs = filledBoxes(d).sort((p, q) => midY(p) - midY(q))
    expect(bs).toHaveLength(2)
    expect(bs[0]!.y1).toBeLessThan(-6.49)      // the copy: centre (0, −6), cap y < −6.5
    expect(bs[1]!.y0).toBeGreaterThan(0.49)
  })
  it('Repeat ×4: each copy’s cap turns with it (the 90° copy’s at x < −0.5)', () => {
    const d = doc()
    const ids = capped(d, 4, 0)
    repeatEntities(d, ids, addPoint(d, 0, 0), 4)
    const bs = filledBoxes(d)
    expect(bs).toHaveLength(4)
    const near = (x: number, y: number) => bs.find(b => Math.hypot(midX(b) - x, midY(b) - y) < 1.2)!
    expect(near(4, 0).y0).toBeGreaterThan(0.49)          // the source, cap above
    expect(near(0, 4).x1).toBeLessThan(-0.49)            // 90°: cap to the left
    expect(near(-4, 0).y1).toBeLessThan(-0.49)           // 180°: cap below
    expect(near(0, -4).x0).toBeGreaterThan(0.49)         // 270°: cap to the right
  })
  it('a paste from another host turned upside down: the cap is below the chord', () => {
    const d = doc()
    const ids = capped(d, 0, 0)
    const clip = extractPieces(d, ids, [])
    expect(clip.fills).toHaveLength(1)
    insertPieces(d, scalePieces(clip, 1, true), { x: 10, y: 0 })
    const bs = filledBoxes(d).sort((p, q) => midX(p) - midX(q))
    expect(bs).toHaveLength(2)
    expect(midX(bs[1]!)).toBeCloseTo(10, 5)
    expect(bs[1]!.y1).toBeLessThan(-0.49)
  })
})

describe('a merge that collapses the seed’s own piece', () => {
  // four line entities round a square; the fill is seeded on the bottom a→b
  function square() {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 2, 0), c = addPoint(d, 2, 2), e = addPoint(d, 0, 2)
    addLine(d, a, b); addLine(d, b, c); const top = addLine(d, c, e); addLine(d, e, a)
    setSeed(d, { kind: 'line', a, b, t: 0.5, side: 1 })
    expect(filledBoxes(d)).toHaveLength(1)
    return { d, a, b, top }
  }
  it('a live fill: its seed is left on no piece, and the settle re-picks it on what is left', () => {
    const { d, a, b } = square()
    const before = cloneDoc(d)
    expect(mergePoints(d, a, b)).toBe(true)   // the bottom collapses; a triangle is left
    expect(d.fills![0]!.seed.a).toBe(b)
    expect(fillState(d).filled).toHaveLength(0)
    d.fills = reconcileFills(before, d)
    expect(d.fills.map(f => f.id)).toEqual(['F1'])
    expect(filledBoxes(d)).toHaveLength(1)
  })
  it('a sleeping fill: nothing is left to carry it, so it is dropped', () => {
    const { d, a, b, top } = square()
    const closed = cloneDoc(d)
    d.entities = d.entities.filter(e => e.id !== top)   // opened: the fill sleeps on its seed
    d.fills = reconcileFills(closed, d)
    expect(fillState(d).asleep.map(f => f.id)).toEqual(['F1'])
    const before = cloneDoc(d)
    expect(mergePoints(d, a, b)).toBe(true)
    expect(reconcileFills(before, d)).toEqual([])
  })
})
