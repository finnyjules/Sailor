// tests/unit/sketch-fills.unit.spec.ts
// Pen stage 7: fills stored by a seed on an edge — the Fill tool's click
// (fill, empty), the hover target, following a drag, the owner's trimmed
// flower filled petal by petal without joining, the outline out, and the
// fields surviving a clone and a save / load (a drawing from before stage 7
// loads unchanged).
import { describe, it, expect } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addCircle, addPath } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { fillState, fillPathData, fillTarget, toggleFillAt, withoutFills, gapMarkers, resolveFill, fillFaces } from '~/lib/sketch/fills'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
function square(d: SketchDoc, x: number, y: number, s: number) {
  const ids = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([px, py]) => addPoint(d, px!, py!))
  return { id: addPath(d, ids, ids.map(() => ({ kind: 'line' as const })), true), ids }
}
/** A square centre with four petal arcs on its sides, each petal a separate open
 *  piece whose ends stop ~3 px (at 34 px per unit) short of the square's corners. */
function flower(d: SketchDoc) {
  const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
  square(d, 6, 2, 6)
  const dl = 0.03
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const cx = (x0! + x1!) / 2, cy = (y0! + y1!) / 2, r = 3
    const a0 = Math.atan2(y0! - cy, x0! - cx) + dl, a1 = a0 + Math.PI - 2 * dl
    const s = addPoint(d, cx + r * Math.cos(a0), cy + r * Math.sin(a0)), e = addPoint(d, cx + r * Math.cos(a1), cy + r * Math.sin(a1))
    addPath(d, [s, e], [{ kind: 'arc', center: addPoint(d, cx, cy), sweep: 1 }])
  }
}

describe('the Fill tool’s click', () => {
  it('fills the area under the point, empties it on a second click; the first fill fixes the gap, the last clears it', () => {
    const d = doc(); square(d, 0, 0, 4)
    expect(fillTarget(d, { x: 1, y: 1 }, 0.1)).toMatchObject({ filled: false })
    expect(toggleFillAt(d, { x: 1, y: 1 }, 0.1)).toBe(true)
    expect(d.fills).toHaveLength(1)
    expect(d.fillGap).toBe(0.1)
    expect(d.fills![0]!.seed).toMatchObject({ kind: 'line', side: expect.any(Number) })
    expect(fillPathData(d)).toBe('M 0 0 L 4 0 L 4 4 L 0 4 L 0 0 Z')
    expect(fillPathData(d, 0.5)).toBe('M 0 0 L 2 0 L 2 2 L 0 2 L 0 0 Z')
    expect(fillTarget(d, { x: 1, y: 1 }, 0.1)).toMatchObject({ filled: true })
    expect(toggleFillAt(d, { x: 1, y: 1 }, 0.1)).toBe(true)
    expect(d.fills).toBeUndefined()
    expect(d.fillGap).toBeUndefined()
    expect(fillPathData(d)).toBe('')
  })
  it('a click outside every area changes nothing', () => {
    const d = doc(); square(d, 0, 0, 4)
    expect(fillTarget(d, { x: 9, y: 9 }, 0)).toBeNull()
    expect(toggleFillAt(d, { x: 9, y: 9 }, 0)).toBe(false)
    expect(d.fills).toBeUndefined()
  })
  it('a circle’s fill is seeded on the circle itself', () => {
    const d = doc(); const c = addCircle(d, addPoint(d, 0, 0), 2)
    toggleFillAt(d, { x: 0.5, y: 0 }, 0)
    expect(d.fills![0]!.seed).toMatchObject({ kind: 'circle', a: c, b: c })
    expect(fillState(d).filled).toHaveLength(1)
  })
})

describe('a fill follows the drawing', () => {
  it('dragging a corner: the same fill, a bigger area', () => {
    const d = doc(); const s = square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const p = d.entities.find(e => e.id === s.ids[2]) as { x: number; y: number }
    p.x = 10; p.y = 10
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeGreaterThan(16)
  })
  it('the owner’s trimmed flower: the centre and all four petals fill without joining anything', () => {
    const d = doc(); flower(d)
    const gap = 6 / 34
    for (const p of [{ x: 9, y: 5 }, { x: 9, y: 0.2 }, { x: 13.8, y: 5 }, { x: 9, y: 9.8 }, { x: 4.2, y: 5 }]) {
      expect(toggleFillAt(d, p, gap)).toBe(true)
    }
    const st = fillState(d)
    expect(st.filled).toHaveLength(5)
    expect(st.asleep).toHaveLength(0)
    expect((fillPathData(d).match(/M /g) ?? []).length).toBe(5)
  })
})

describe('seeds and sleeping fills', () => {
  it('a seed naming its piece the other way round finds the same area', () => {
    const d = doc(); square(d, 0, 0, 4)
    toggleFillAt(d, { x: 1, y: 1 }, 0)
    const f = d.fills![0]!
    const s = f.seed
    const flipped = { id: 'F9', seed: { ...s, a: s.b, b: s.a, t: 1 - s.t, side: (s.side === 1 ? -1 : 1) as 1 | -1 } }
    const fs = fillFaces(d)
    expect(resolveFill(fs, flipped)).toBe(resolveFill(fs, f))
    expect(resolveFill(fs, f)).not.toBeNull()
  })
  it('an opened area sleeps and marks the open ends nearest its seed; closed again it wakes', () => {
    const d = doc(); const s = square(d, 0, 0, 4)
    // seeded on the bottom edge (0,0)→(4,0), area on its left (inside)
    d.fills = [{ id: 'F1', seed: { kind: 'line', a: s.ids[0]!, b: s.ids[1]!, t: 0.5, side: 1 } }]
    expect(fillState(d).filled).toHaveLength(1)
    const path = d.entities.find(e => e.id === s.id) as { closed: boolean; segments: unknown[] }
    path.closed = false; path.segments.pop()
    const st = fillState(d)
    expect(st.filled).toHaveLength(0)
    expect(st.asleep).toHaveLength(1)
    expect(fillPathData(d)).toBe('')
    const m = gapMarkers(d)
    expect(m).toHaveLength(2)
    expect(m.map(p => `${p.x},${p.y}`).sort()).toEqual(['0,0', '0,4'])
    path.closed = true; path.segments.push({ kind: 'line' })
    expect(fillState(d).asleep).toHaveLength(0)
    expect(gapMarkers(d)).toEqual([])
  })
})

describe('an opened area inside a closed shape', () => {
  it('sleeps with two gap markers instead of handing its fill to the shape around it', () => {
    const d = doc(); addCircle(d, addPoint(d, 2, 2), 10); const s = square(d, 0, 0, 4)
    expect(toggleFillAt(d, { x: 1, y: 1 }, 0)).toBe(true)
    let st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(16, 6)
    const path = d.entities.find(e => e.id === s.id) as { closed: boolean; segments: unknown[] }
    path.closed = false; path.segments.pop()
    st = fillState(d)
    expect(st.filled).toHaveLength(0)
    expect(st.asleep).toHaveLength(1)
    expect(fillPathData(d)).toBe('')
    expect(gapMarkers(d)).toHaveLength(2)
  })
})

describe('the fill gap', () => {
  it('a drawing with fills but no stored gap uses no gap, for hover too, and never pins one later', () => {
    const d = doc(); square(d, 0, 0, 4)
    // a C bent open by 0.1: closes at a gap of 0.2, not at 0
    const ids = [[10, 0], [14, 0], [14, 4], [10, 4], [10, 0.1]].map(([x, y]) => addPoint(d, x!, y!))
    addPath(d, ids, ids.slice(1).map(() => ({ kind: 'line' as const })))
    expect(toggleFillAt(d, { x: 1, y: 1 }, 0)).toBe(true)
    expect(d.fillGap).toBeUndefined()
    expect(fillTarget(d, { x: 12, y: 2 }, 0.2)).toBeNull()
    expect(toggleFillAt(d, { x: 12, y: 2 }, 0.2)).toBe(false)
    expect(d.fillGap).toBeUndefined()
    expect(d.fills).toHaveLength(1)
    // before any fill, the hover's gap applies
    const e = doc(); e.entities = d.entities; e.constraints = d.constraints
    expect(fillTarget(e, { x: 12, y: 2 }, 0.2)).toMatchObject({ filled: false })
  })
})

describe('storage', () => {
  it('a clone and a save / load keep fills; a drawing from before fills loads unchanged; broken seeds are dropped', () => {
    const d = doc(); square(d, 0, 0, 4); addCircle(d, addPoint(d, 10, 2), 1)
    toggleFillAt(d, { x: 1, y: 1 }, 0.2); toggleFillAt(d, { x: 10, y: 2 }, 0.2)
    const c = cloneDoc(d)
    expect(c.fills).toEqual(d.fills); expect(c.fills).not.toBe(d.fills); expect(c.fillGap).toBe(0.2)
    const loaded = mergeSketchDoc(JSON.parse(JSON.stringify(d)))
    expect(loaded.fills).toEqual(d.fills); expect(loaded.fillGap).toBe(0.2)
    expect(fillState(loaded).filled).toHaveLength(2)
    const old = mergeSketchDoc(JSON.parse(JSON.stringify({ entities: d.entities, constraints: d.constraints })))
    expect('fills' in old).toBe(false); expect('fillGap' in old).toBe(false)
    expect(JSON.stringify(cloneDoc(old))).toBe(JSON.stringify(old))
    const broken = JSON.parse(JSON.stringify(d)); broken.fills[0].seed.a = 'nope'
    const b = mergeSketchDoc(broken)
    expect(b.fills).toEqual([d.fills![1]]); expect(b.fillGap).toBe(0.2)
    // (a load lists paths after the other entities, as it always has)
    const byId = (a: { id: string }, z: { id: string }) => a.id.localeCompare(z.id)
    expect([...b.entities].sort(byId)).toEqual([...d.entities].sort(byId)); expect(b.constraints).toEqual(d.constraints)
    const allBroken = JSON.parse(JSON.stringify(d)); allBroken.fills[0].seed.a = 'nope'; allBroken.fills[1].seed.side = 0
    const nb = mergeSketchDoc(allBroken)
    expect(nb.fills).toBeUndefined(); expect(nb.fillGap).toBeUndefined()
  })
  it('withoutFills drops both fields and leaves the rest', () => {
    const d = doc(); square(d, 0, 0, 4); toggleFillAt(d, { x: 1, y: 1 }, 0.2)
    const w = withoutFills(d)
    expect('fills' in w).toBe(false); expect('fillGap' in w).toBe(false)
    expect(w.entities).toBe(d.entities)
    const plain = doc()
    expect(withoutFills(plain)).toBe(plain)
  })
})
