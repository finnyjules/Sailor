// tests/unit/sketch-stage8-final-fixes.unit.spec.ts
// Pen stage 8, final fix wave (review-final-verdict.md): Clean up counts the
// collinear-held offset copy points as copies (I1), a virtual sharp never pins
// a scoped Clean up (I2), rules naming a rounded side follow it through trim
// and delete (I3), and deleting a rounded shape leaves no stray guide dots (I4).
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, PathEntity } from '~/lib/sketch/model'
import { getEntity } from '~/lib/sketch/model'
import { addPoint, addPath, addLine, addConstraint, deleteEntity, repeatEntities, translateEntities } from '~/lib/sketch/edit'
import { roundCorners } from '~/lib/sketch/corners'
import { offsetSource, applyOffset } from '~/lib/sketch/offset'
import { runCleanup } from '~/lib/sketch/cleanup'
import { copyPoints, heldForScope } from '~/lib/sketch/cleanup/context'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { removeSpan } from '~/lib/sketch/trim'
import { spanAt } from '~/lib/sketch/crossings'
import { squarePath } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })

/** a 10 × 7 rectangle tilted 2°, counter-clockwise, as one closed path */
function tiltedRect(d: SketchDoc): { path: EntityId; pts: EntityId[] } {
  const t = 2 * Math.PI / 180, c = Math.cos(t), s = Math.sin(t)
  const pts = [[0, 0], [10, 0], [10, 7], [0, 7]].map(([x, y]) => addPoint(d, x! * c - y! * s, x! * s + y! * c))
  return { path: addPath(d, pts, pts.map(() => ({ kind: 'line' as const })), true), pts }
}
const unmet = (d: SketchDoc) => constraintResiduals(d).filter(r => Math.abs(r) > 1e-7).length

describe('I1: offset copy points held by collinear at smooth joins are copies', () => {
  it('rounded tilted rectangle, offset +1: Clean up proposes nothing on the copy and every rule holds', () => {
    const d = doc()
    const { path, pts } = tiltedRect(d)
    expect(roundCorners(d, pts, 'round', 1.5).ok).toBe(true)
    const src = offsetSource(d, [path], [])
    expect(src.ok).toBe(true)
    const b = applyOffset(d, src.ok ? src.chains : [], 1)
    expect(b.ok).toBe(true)
    const copyPts = b.created.filter(id => getEntity(d, id)?.kind === 'point')
    const copies = copyPoints(d)
    for (const id of copyPts) expect(copies.has(id), id).toBe(true)
    for (const strength of ['normal', 'strong'] as const) {
      const r = runCleanup(d, { unitsPerPx: 0.05, strength, scope: null, off: new Set(), budgetMs: 1e9 })
      // no fix names a point of the copy (a fix id carries its points' ids)
      for (const f of r.fixes) for (const id of copyPts) expect(f.id.split(/[:~,@]/)).not.toContain(id)
      expect(r.fixes.map(f => f.kind).sort()).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical'])
      expect(unmet(r.doc)).toBe(0)
    }
  })
})

describe('I2: a virtual sharp never pins a scoped Clean up', () => {
  it('the rounded shape selected gets the same fixes as with nothing selected', () => {
    for (const kind of ['round', 'chamfer'] as const) {
      const d = doc()
      const { path, pts } = tiltedRect(d)
      expect(roundCorners(d, pts, kind, 1.5).ok).toBe(true)
      const opts = { unitsPerPx: 0.05, strength: 'normal' as const, off: new Set<string>(), budgetMs: 1e9 }
      const all = runCleanup(d, { ...opts, scope: null })
      const mine = runCleanup(d, { ...opts, scope: { entities: [path], segments: [] } })
      expect(all.fixes.length).toBe(4)
      expect(mine.fixes.map(f => f.id).sort()).toEqual(all.fixes.map(f => f.id).sort())
      expect(unmet(mine.doc)).toBe(0)
    }
  })
  it('a virtual sharp tied to an unselected piece stays held', () => {
    const d = doc()
    const { pts } = tiltedRect(d)
    expect(roundCorners(d, pts, 'round', 1.5).ok).toBe(true)
    const other = addPoint(d, 30, 30), other2 = addPoint(d, 40, 30)
    const line = addPath(d, [other, other2], [{ kind: 'line' }])
    addConstraint(d, 'distance', [pts[0]!, other], 5)
    const held = heldForScope(d, { entities: [line], segments: [] })
    expect(held.has(pts[0]!)).toBe(true)
  })
})

describe('I3: rules that named a side by its corner follow the drawn side after a round', () => {
  it('offset a square, round a source corner, trim the source side: no rule left pointing through the guide dot', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 10)
    const src = offsetSource(d, [path], [])
    expect(applyOffset(d, src.ok ? src.chains : [], -1).ok).toBe(true)
    const B = pts[1]!
    expect(roundCorners(d, [B], 'round', 2).ok).toBe(true)
    // the offsetLines of both sides at B now name the drawn sides, not the guide
    expect(d.constraints.filter(c => c.kind === 'offsetLine' && c.refs.includes(B))).toHaveLength(0)
    const p = getEntity(d, path) as PathEntity
    const T1 = p.anchors[p.anchors.indexOf(pts[0]!) + 1]!
    expect(d.constraints.filter(c => c.kind === 'offsetLine' && c.refs[0] === pts[0] && c.refs[1] === T1)).toHaveLength(2)
    expect(unmet(d)).toBe(0)
    // trim the source piece pts[0] → T1
    const seg = p.anchors.indexOf(pts[0]!)
    const r = removeSpan(d, spanAt(d, { kind: 'seg', pathId: path, segIndex: seg }, 0.5)!)
    expect(r.ok).toBe(true)
    // nothing but the guide's own ties still names B
    const onB = d.constraints.filter(c => c.refs.includes(B))
    expect(onB.every(c => c.kind === 'collinear' && c.refs[2] === B)).toBe(true)
    expect(d.constraints.filter(c => c.kind === 'offsetLine' && c.refs.includes(B))).toHaveLength(0)
  })
  it('Horizontal on a rounded side follows it (still holds, names the touch point)', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 10)
    const h = addConstraint(d, 'horizontal', [pts[0]!, pts[1]!])
    expect(roundCorners(d, [pts[1]!], 'chamfer', 2).ok).toBe(true)
    const k = d.constraints.find(c => c.id === h)!
    expect(k.refs[0]).toBe(pts[0])
    expect(k.refs[1]).not.toBe(pts[1])
    expect((getEntity(d, path) as PathEntity).anchors).toContain(k.refs[1])
    expect(unmet(d)).toBe(0)
  })
  it('a typed length on the side through the corner stays on the corner (its value is the sharp length)', () => {
    const d = doc()
    const { pts } = squarePath(d, 0, 0, 10)
    const L = addConstraint(d, 'distance', [pts[0]!, pts[1]!], 10)
    expect(roundCorners(d, [pts[1]!], 'round', 2).ok).toBe(true)
    expect(d.constraints.find(c => c.id === L)!.refs).toEqual([pts[0], pts[1]])
    expect(unmet(d)).toBe(0)
  })
})

describe('I4: deleting a rounded or chamfered shape leaves no stray guide dots', () => {
  it('a square with all four corners chamfered (or rounded), deleted: no construction points, no rules', () => {
    for (const kind of ['chamfer', 'round'] as const) {
      const d = doc()
      const { path, pts } = squarePath(d, 0, 0, 10)
      expect(roundCorners(d, pts, kind, 2).ok).toBe(true)
      deleteEntity(d, path)
      expect(d.entities).toHaveLength(0)
      expect(d.constraints).toHaveLength(0)
    }
  })
  it('a guide still tied to something that stays is kept, and so is its rule', () => {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 10)
    const keep = addPoint(d, 30, 0)
    addPath(d, [keep, addPoint(d, 40, 0)], [{ kind: 'line' }])
    const k = addConstraint(d, 'distance', [pts[1]!, keep], 20)
    expect(roundCorners(d, pts, 'round', 2).ok).toBe(true)
    deleteEntity(d, path)
    expect(d.entities.some(e => e.id === pts[1])).toBe(true)
    expect(d.constraints.map(c => c.id)).toEqual([k])
    expect(d.entities.filter(e => e.kind === 'point' && e.construction).map(e => e.id)).toEqual([pts[1]])
  })
  it('deleting only the fillet between two separate lines keeps the sharp (the sides still use its ties)', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), x = addPoint(d, 10, 0), b = addPoint(d, 10, 10)
    addLine(d, a, x); addLine(d, x, b)
    expect(roundCorners(d, [x], 'round', 2).ok).toBe(true)
    const fillet = d.entities.find(e => e.kind === 'path')!.id
    deleteEntity(d, fillet)
    expect(getEntity(d, x)).toBeTruthy()
  })
  it('a radial centre guide point is never taken by a delete', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 2)
    const c = addPoint(d, 10, 10, { construction: true })
    const copies = repeatEntities(d, [path], c, 3)
    expect(copies.length).toBeGreaterThan(0)
    deleteEntity(d, path)
    expect(getEntity(d, c)).toBeTruthy()
  })
})

describe('Minor 5: deleting every linear copy removes the dashed guide line', () => {
  it('guide line and its ends go once no copy names them; they stay while one does', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 2)
    const f = addPoint(d, 0, 5, { construction: true }), t = addPoint(d, 4, 5, { construction: true })
    const g = addLine(d, f, t, { construction: true })
    const copies = translateEntities(d, [path], f, t, 3, 'step')
    expect(copies).toHaveLength(2)
    const copyPath = (ids: EntityId[]) => ids.find(id => getEntity(d, id)?.kind === 'path')!
    deleteEntity(d, copyPath(copies[0]!))
    expect(getEntity(d, g)).toBeTruthy()
    deleteEntity(d, copyPath(copies[1]!))
    expect(getEntity(d, g)).toBeUndefined()
    expect(getEntity(d, f)).toBeUndefined()
    expect(getEntity(d, t)).toBeUndefined()
    expect(d.constraints.filter(c => c.kind === 'translatedFrom')).toHaveLength(0)
  })
  it('a guide line the user drew (no linear copies ever) is never touched by a delete', () => {
    const d = doc()
    const { path } = squarePath(d, 0, 0, 2)
    const g = addLine(d, addPoint(d, 0, 5, { construction: true }), addPoint(d, 4, 5, { construction: true }), { construction: true })
    deleteEntity(d, path)
    expect(getEntity(d, g)).toBeTruthy()
  })
})

describe('re-review Minor 1: a length rule on a rounded side goes when that side does', () => {
  function roundedSquare(kind: 'round' | 'chamfer') {
    const d = doc()
    const { path, pts } = squarePath(d, 0, 0, 10)
    const L = addConstraint(d, 'distance', [pts[0]!, pts[1]!], 10)
    const E = addConstraint(d, 'equalDist', [pts[0]!, pts[1]!, pts[2]!, pts[3]!])
    expect(roundCorners(d, [pts[1]!], kind, 2).ok).toBe(true)
    return { d, path, pts, L, E }
  }
  it('trim the side A → T1: the distance and the segment Equal naming A and the hidden corner go, counted', () => {
    for (const kind of ['round', 'chamfer'] as const) {
      const { d, path, pts, L, E } = roundedSquare(kind)
      const p = getEntity(d, path) as PathEntity
      const n0 = d.constraints.length
      const r = removeSpan(d, spanAt(d, { kind: 'seg', pathId: path, segIndex: p.anchors.indexOf(pts[0]!) }, 0.5)!)
      expect(r.ok).toBe(true)
      expect(d.constraints.some(c => c.id === L || c.id === E)).toBe(false)
      expect(r.droppedRules).toBe(n0 - d.constraints.length)
      expect(r.droppedRules).toBeGreaterThanOrEqual(2)
    }
  })
  it('trimming the other side leaves the length on A → B alone', () => {
    const { d, path, pts, L } = roundedSquare('round')
    const p = getEntity(d, path) as PathEntity
    const r = removeSpan(d, spanAt(d, { kind: 'seg', pathId: path, segIndex: p.anchors.indexOf(pts[2]!) }, 0.5)!)
    expect(r.ok).toBe(true)
    expect(d.constraints.some(c => c.id === L)).toBe(true)
  })
  it('deleting a separate line side takes its length on the hidden corner too', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), x = addPoint(d, 10, 0), b = addPoint(d, 10, 10)
    const side = addLine(d, a, x); addLine(d, x, b)
    const L = addConstraint(d, 'distance', [a, x], 10)
    expect(roundCorners(d, [x], 'round', 2).ok).toBe(true)
    deleteEntity(d, side)
    expect(d.constraints.some(c => c.id === L)).toBe(false)
  })
})
