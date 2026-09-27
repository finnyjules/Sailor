// tests/unit/sketch-fills-edits.unit.spec.ts
// Pen stage 7: the edits that rename or copy pieces carry fills themselves —
// Cut and Dissolve keep a seed on its piece, merging points renames it,
// Repeat and Mirror copy a fill whose whole area they copy (circles too,
// mirrored seeds on the other side), Copy / Paste take fills along (a paste
// turned upside down too; one side of an area takes none), Flip keeps a
// filled shape filled.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
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
