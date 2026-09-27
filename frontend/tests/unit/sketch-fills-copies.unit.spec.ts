// tests/unit/sketch-fills-copies.unit.spec.ts
// Pen stage 7 (final review): a copy that lands over other pieces is cut into
// several areas by them — Paste, Repeat and Mirror fill EVERY area inside the
// copied filled area, not just the one its seed finds, and nothing outside it.
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath, addCircle, addLine, repeatEntities, mirrorEntities } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { extractPieces, insertPieces } from '~/lib/sketch/clipboard'
import { fillState, toggleFillAt, reconcileFills, deepPoint, fillPathData } from '~/lib/sketch/fills'
import { findFaces, faceAt } from '~/lib/sketch/faces'
import type { Vec2 } from '~/lib/sketch/geom'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function settle(before: SketchDoc, now: SketchDoc) {
  const n = reconcileFills(before, now)
  if (n.length) now.fills = n; else delete now.fills
}
function poly(d: SketchDoc, pts: number[][]) {
  const ids = pts.map(([x, y]) => addPoint(d, x!, y!))
  return addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true)
}
// every face of d: filled exactly when `want` says its deep point should be
function expectFilledWhere(d: SketchDoc, want: (p: Vec2) => boolean) {
  const st = fillState(d)
  expect(st.fs.faces.length).toBeGreaterThan(1)
  st.fs.faces.forEach((_, g) => {
    const p = deepPoint(st.fs, g)!
    expect(p).toBeTruthy()
    expect({ at: p, filled: st.filled.includes(g) }).toEqual({ at: p, filled: want(p) })
  })
}
const inSq = (x0: number, y0: number, s: number) => (p: Vec2) => p.x > x0 && p.x < x0 + s && p.y > y0 && p.y < y0 + s

describe('Paste over the original fills the whole copy', () => {
  const sq = [[0, 0], [4, 0], [4, 4], [0, 4]]
  for (let r = 0; r < 4; r++) {
    for (const off of [[1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
      it(`anchor ${r}, offset ${off.join(',')}`, () => {
        const d = doc()
        // an empty frame around: the area between it and the squares stays empty
        poly(d, [[-10, -10], [14, -10], [14, 14], [-10, 14]])
        const pts = [...sq.slice(r), ...sq.slice(0, r)]
        const P = poly(d, pts)
        toggleFillAt(d, { x: 2, y: 2 }, 0)
        const clip = extractPieces(d, [P], [])
        expect(clip.fills).toHaveLength(1)
        const before = cloneDoc(d)
        insertPieces(d, clip, { x: off[0], y: off[1] })
        settle(before, d)
        const orig = inSq(0, 0, 4), copy = inSq(off[0], off[1], 4)
        expectFilledWhere(d, p => orig(p) || copy(p))
        // the Frame's outline has no hole: the union of both squares
        const fd = fillPathData(d)
        expect(fd).not.toBe('')
      })
    }
  }
})

describe('Repeat and Mirror over overlapping neighbours fill each copy whole', () => {
  it('a filled circle petal repeated ×6 (neighbours overlap)', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0)
    const src = addCircle(d, addPoint(d, 2, 0), 1.6)
    toggleFillAt(d, { x: 2, y: 0 }, 0)
    const before = cloneDoc(d)
    repeatEntities(d, [src], ctr, 6)
    settle(before, d)
    const centres = [0, 1, 2, 3, 4, 5].map(k => ({ x: 2 * Math.cos(k * Math.PI / 3), y: 2 * Math.sin(k * Math.PI / 3) }))
    expectFilledWhere(d, p => centres.some(c => Math.hypot(p.x - c.x, p.y - c.y) < 1.6))
    // the middle (inside no petal) is a face of its own, left empty
    const st = fillState(d)
    const mid = faceAt(st.fs, { x: 0, y: 0 })
    expect(mid).not.toBeNull()
    expect(st.filled.includes(mid!)).toBe(false)
  })
  it('a filled diamond petal repeated ×6 (neighbours overlap)', () => {
    const d = doc()
    const ctr = addPoint(d, 0, 0)
    const src = poly(d, [[0.3, 0], [2, -1.4], [3.7, 0], [2, 1.4]])
    toggleFillAt(d, { x: 2, y: 0 }, 0)
    const before = cloneDoc(d)
    repeatEntities(d, [src], ctr, 6)
    settle(before, d)
    const diamonds = [0, 1, 2, 3, 4, 5].map(k => k * Math.PI / 3)
    const inDiamond = (p: Vec2) => diamonds.some(a => {
      // turn p back by a, then test the source diamond |x−2|/1.7 + |y|/1.4 < 1
      const x = p.x * Math.cos(-a) - p.y * Math.sin(-a), y = p.x * Math.sin(-a) + p.y * Math.cos(-a)
      return Math.abs(x - 2) / 1.7 + Math.abs(y) / 1.4 < 1
    })
    expectFilledWhere(d, inDiamond)
  })
  it('a filled circle mirrored across a line it overlaps', () => {
    const d = doc()
    const ax = addLine(d, addPoint(d, 0, -10), addPoint(d, 0, 10), { construction: true })
    const src = addCircle(d, addPoint(d, 1, 0), 2)
    toggleFillAt(d, { x: 1, y: 0 }, 0)
    const before = cloneDoc(d)
    mirrorEntities(d, [src], ax)
    settle(before, d)
    expectFilledWhere(d, p => Math.hypot(p.x - 1, p.y) < 2 || Math.hypot(p.x + 1, p.y) < 2)
  })
  it('a copy that overlaps nothing is one area, filled once', () => {
    const d = doc()
    const P = poly(d, [[0, 0], [4, 0], [4, 4], [0, 4]])
    toggleFillAt(d, { x: 2, y: 2 }, 0)
    const clip = extractPieces(d, [P], [])
    insertPieces(d, clip, { x: 10, y: 0 })
    expect(d.fills).toHaveLength(2)
    expect(fillState(d).filled).toHaveLength(2)
  })
  it('an unfilled overlapped area of the target never fills', () => {
    const d = doc()
    // an empty square the copy lands half over: only its part inside the copy fills
    poly(d, [[5, 0], [9, 0], [9, 4], [5, 4]])
    const P = poly(d, [[0, 0], [4, 0], [4, 4], [0, 4]])
    toggleFillAt(d, { x: 2, y: 2 }, 0)
    const clip = extractPieces(d, [P], [])
    const before = cloneDoc(d)
    insertPieces(d, clip, { x: 3, y: 1 })
    settle(before, d)
    expectFilledWhere(d, p => inSq(0, 0, 4)(p) || inSq(3, 1, 4)(p))
    expect(findFaces(d).faces.length).toBeGreaterThan(3)
  })
})
