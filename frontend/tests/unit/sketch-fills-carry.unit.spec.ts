// tests/unit/sketch-fills-carry.unit.spec.ts
// Pen stage 7: fills carried across an edit (reconcileFills, run on every
// settled step): nothing changed → exactly the same fills; a line across a
// filled area → both halves; the divider trimmed → one fill; the area opened
// → the fill sleeps (gap rings) on an edge it still has, and wakes when the
// area closes; an emptied fill never comes back.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, PointEntity } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addCircle } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { removeSpan } from '~/lib/sketch/trim'
import { spanAt } from '~/lib/sketch/crossings'
import { fillState, toggleFillAt, addFillAt, reconcileFills, gapMarkers, resolveFill, fillFaces } from '~/lib/sketch/fills'
import { faceAt } from '~/lib/sketch/faces'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function square(d: SketchDoc, x: number, y: number, s: number) {
  const ids = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => addPoint(d, px!, py!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
/** what the pen's commit does: carry the fills from the last settled drawing */
function settle(before: SketchDoc, after: SketchDoc) {
  const f = reconcileFills(before, after)
  if (f.length) after.fills = f
  else { delete after.fills; delete after.fillGap }
}
const pathOf = (d: SketchDoc) => d.entities.find(e => e.kind === 'path') as { id: string; anchors: string[] }
const pt = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as PointEntity

describe('reconcileFills', () => {
  it('an edit that changes nothing leaves the fills exactly as they were', () => {
    const d = doc(); square(d, 0, 0, 4); square(d, 6, 0, 4)
    toggleFillAt(d, { x: 7, y: 1 }, 0); toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    expect(reconcileFills(before, cloneDoc(d))).toEqual(before.fills)
  })
  it('a drag keeps every fill and every seed as it was', () => {
    const d = doc(); const P = square(d, 0, 0, 4); square(d, 6, 0, 4)
    toggleFillAt(d, { x: 7, y: 1 }, 0); toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    const corner = pt(d, pathOf(d).anchors[2]!)
    expect(pathOf(d).id).toBe(P)
    corner.x += 1.5; corner.y += 0.7
    const out = reconcileFills(before, d)
    expect(out).toEqual(before.fills)
    expect(out[0]).toBe(d.fills![0])   // the same objects: nothing rewritten
  })
  it('dragging a corner slides where a divider meets an edge; the empty neighbour stays empty', () => {
    // a 4 × 4 square split by a divider whose ends rest on its bottom and top edges
    const d = doc(); square(d, 0, 0, 4)
    addLine(d, addPoint(d, 2, 0), addPoint(d, 2, 4))
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    // the bottom-right corner moves right: the divider's foot now sits at a
    // different place along the bottom edge (0.5 → 0.4545 of it)
    pt(d, pathOf(d).anchors[1]!).x += 0.4
    settle(before, d)
    expect(d.fills).toHaveLength(1)
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(faceAt(st.fs, { x: 1, y: 1 })).toBe(st.filled[0])
  })
  it('a line drawn across a filled area fills both halves; trimming the divider leaves one fill', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const b1 = cloneDoc(d)
    const line = addLine(d, addPoint(d, 2, -1), addPoint(d, 2, 5))
    expect(fillState(d).filled).toHaveLength(1)    // the seed alone finds one half…
    settle(b1, d)
    expect(d.fills).toHaveLength(2)                 // …the settle fills the other
    expect(fillState(d).filled).toHaveLength(2)
    const b2 = cloneDoc(d)
    expect(removeSpan(d, spanAt(d, { kind: 'line', id: line }, 0.5)!).ok).toBe(true)
    settle(b2, d)
    expect(d.fills).toHaveLength(1)
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(16, 6)
  })
  it('a merge whose fills were seeded on the divider keeps exactly one fill, on the merged area', () => {
    const d = doc(); square(d, 0, 0, 8)
    const a = addPoint(d, 4, 0), b = addPoint(d, 4, 8)
    const line = addLine(d, a, b)
    d.fills = [
      { id: 'F1', seed: { kind: 'line', a, b, t: 0.5, side: 1 } },
      { id: 'F2', seed: { kind: 'line', a, b, t: 0.5, side: -1 } },
    ]
    const fs = fillFaces(d)
    const both = d.fills.map(f => resolveFill(fs, f))
    expect(both.every(g => g != null)).toBe(true)
    expect(both[0]).not.toBe(both[1])
    const before = cloneDoc(d)
    expect(removeSpan(d, spanAt(d, { kind: 'line', id: line }, 0.5)!).ok).toBe(true)
    settle(before, d)
    expect(d.fills).toHaveLength(1)
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.asleep).toHaveLength(0)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(64, 6)
  })
  it('opening the area puts the fill to sleep with rings at the gap; closing it again wakes it', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const b1 = cloneDoc(d)
    const P = pathOf(d)
    const far = (P.anchors.indexOf(d.fills![0]!.seed.a) + 2) % 4   // the side opposite the seed
    expect(removeSpan(d, spanAt(d, { kind: 'seg', pathId: P.id, segIndex: far }, 0.5)!).ok).toBe(true)
    settle(b1, d)
    expect(d.fills).toHaveLength(1)
    expect(fillState(d).asleep).toHaveLength(1)
    expect(gapMarkers(d)).toHaveLength(2)
    const open = pathOf(d)
    const b2 = cloneDoc(d)
    addLine(d, open.anchors[0]!, open.anchors[open.anchors.length - 1]!)
    settle(b2, d)
    expect(fillState(d).filled).toHaveLength(1)
    expect(gapMarkers(d)).toHaveLength(0)
  })
  it('opening the area by trimming the seed’s own edge moves the sleeping fill onto an edge that is left', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    const P = pathOf(d)
    const own = P.anchors.indexOf(d.fills![0]!.seed.a)
    expect(removeSpan(d, spanAt(d, { kind: 'seg', pathId: P.id, segIndex: own }, 0.5)!).ok).toBe(true)
    settle(before, d)
    expect(d.fills).toHaveLength(1)
    expect(fillState(d).asleep).toHaveLength(1)
    expect(gapMarkers(d)).toHaveLength(2)
  })
  it('a fill emptied on purpose is never brought back', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const before = cloneDoc(d)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    expect(reconcileFills(before, d)).toEqual([])
  })
  it('a drawing with no fills does no face work and returns none', () => {
    const d = doc(); square(d, 0, 0, 4)
    expect(reconcileFills(cloneDoc(d), d)).toEqual([])
  })
})

describe('reconcileFills — speed (one connected drawing, a symmetric grid)', () => {
  // 64 two-arc petals round a circle, a spoke to every other one (161 pieces)
  function ring(): SketchDoc {
    const d = doc()
    const O = addPoint(d, 0, 0); addCircle(d, O, 10)
    for (let k = 0; k < 64; k++) {
      const a0 = (k / 64) * Math.PI * 2, a1 = ((k + 2) / 64) * Math.PI * 2, am = (a0 + a1) / 2
      const s = addPoint(d, 10 * Math.cos(a0), 10 * Math.sin(a0)), e = addPoint(d, 10 * Math.cos(a1), 10 * Math.sin(a1))
      addPath(d, [s, e], [
        { kind: 'arc', center: addPoint(d, 9 * Math.cos(am), 9 * Math.sin(am)), sweep: 1 },
        { kind: 'arc', center: addPoint(d, 14 * Math.cos(am), 14 * Math.sin(am)), sweep: 1 },
      ], true)
      if (k % 2 === 0) addLine(d, O, s)
    }
    return d
  }
  function fillSome(d: SketchDoc, n: number) {
    const fs = fillFaces(d)
    let made = 0
    for (let k = 0; k < 64 && made < n; k += 8) {
      const a = ((k + 0.5) / 32) * Math.PI
      for (const r of [3, 9.5, 11]) {
        const p = { x: r * Math.cos(a), y: r * Math.sin(a) }
        if (faceAt(fs, p) != null && addFillAt(d, p)) made++
      }
    }
    return made
  }
  // the best of three honest commits (a loaded machine stalls single runs):
  // the last settled step's faces are cached (the overlay and the hover read
  // them), the new drawing's are not
  function timeCommit(d: SketchDoc, edit: (d: SketchDoc) => void): { ms: number; before: SketchDoc; after: SketchDoc } {
    let best = Infinity
    let before = d, after = d
    for (let i = 0; i < 6; i++) {
      before = cloneDoc(d)
      fillFaces(before)
      after = cloneDoc(d)
      edit(after)
      const t = performance.now()
      const out = reconcileFills(before, after)
      if (i >= 3) best = Math.min(best, performance.now() - t)   // the first three warm up the JIT
      after.fills = out
      // perturb the next copy's geometry so its faces are cold again
      const first = d.entities.find(e => e.kind === 'point') as PointEntity
      first.x += 1e-7
    }
    return { ms: best, before, after }
  }

  it('the 161-piece ring with several fills settles within 20 ms (nothing changed, a drag, a split)', () => {
    const d = ring()
    expect(fillSome(d, 6)).toBeGreaterThanOrEqual(5)
    const n = d.fills!.length

    // nothing changed: both cached
    const same = cloneDoc(d)
    reconcileFills(d, same)
    let t = performance.now()
    const outSame = reconcileFills(d, same)
    const idle = performance.now() - t
    expect(outSame).toEqual(d.fills)
    expect(idle).toBeLessThan(20)

    // a drag of one petal tip (the new drawing's faces are cold)
    const petalPt = (d.entities.filter(e => e.kind === 'point') as PointEntity[])[5]!.id
    const drag = timeCommit(d, a => { const p = pt(a, petalPt); p.x += 0.05; p.y += 0.03 })
    expect(drag.after.fills).toHaveLength(n)
    expect(drag.ms).toBeLessThan(20)

    // a line across the inner disc (splits a filled sector)
    const split = timeCommit(d, a => { addLine(a, addPoint(a, -12, 0.3), addPoint(a, 12, 0.3)) })
    expect(split.after.fills!.length).toBeGreaterThanOrEqual(n)
    expect(split.ms).toBeLessThan(20)
  })

  it('a 21 × 21 grid with several fills settles within 20 ms after a drag', () => {
    const g = doc()
    for (let i = 0; i <= 20; i++) {
      addLine(g, addPoint(g, -1, i), addPoint(g, 21, i))
      addLine(g, addPoint(g, i, -1), addPoint(g, i, 21))
    }
    for (const [x, y] of [[0.5, 0.5], [5.5, 7.5], [10.5, 10.5], [19.5, 3.5], [12.5, 18.5], [3.5, 15.5]]) toggleFillAt(g, { x: x!, y: y! }, 0)
    expect(g.fills).toHaveLength(6)
    const lineEnd = (g.entities.filter(e => e.kind === 'point') as PointEntity[])[1]!.id   // the first row's right end
    const drag = timeCommit(g, a => { pt(a, lineEnd).y += 0.02 })
    expect(drag.after.fills).toHaveLength(6)
    expect(drag.ms).toBeLessThan(20)
  })
})
