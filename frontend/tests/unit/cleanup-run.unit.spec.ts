// tests/unit/cleanup-run.unit.spec.ts
// Clean up's staged greedy solve (pen stage 5): the held solve, the guards
// (movement cap, broken arcs), and runCleanup end to end — the owner's
// trimmed flower joined into one loop, the same answer for the same switches,
// typed sizes that never move, fixes the other rules can't allow, rules the
// drawing already says, a Repeat's source only, a selection, an open-only
// pen, the size limit, and speed.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addPath, addConstraint, repeatEntities } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solveHeld, componentOf, windowOf, baselineOf, movedTooFar, arcBroken } from '~/lib/sketch/cleanup/guards'
import { runCleanup } from '~/lib/sketch/cleanup/run'
import type { CleanupOptions } from '~/lib/sketch/cleanup/types'

const U = 1 / 34
const blank = (): SketchDoc => ({ entities: [], constraints: [] })
const opts = (o: Partial<CleanupOptions> = {}): CleanupOptions => ({ unitsPerPx: U, strength: 'normal', ...o })
const P = (d: SketchDoc, id: EntityId) => d.entities.find(e => e.id === id) as any
const paths = (d: SketchDoc) => d.entities.filter(e => e.kind === 'path') as any[]
const maxRes = (d: SketchDoc) => Math.max(0, ...constraintResiduals(d).map(Math.abs))
const rad = (deg: number) => deg * Math.PI / 180
function lineAt(d: SketchDoc, x: number, y: number, deg: number, len: number) {
  const a = addPoint(d, x, y), b = addPoint(d, x + len * Math.cos(rad(deg)), y + len * Math.sin(rad(deg)))
  return { a, b, id: addLine(d, a, b) }
}
const len = (d: SketchDoc, l: { a: EntityId; b: EntityId }) => Math.hypot(P(d, l.b).x - P(d, l.a).x, P(d, l.b).y - P(d, l.a).y)
// the owner's trimmed flower: four petal arcs round a square, each ending 3.2 px short of the next one's start
function flower(d: SketchDoc): void {
  const C: [number, number][] = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + 0.08, ey = y1 + 0.05
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey), c = addPoint(d, (x0 + ex) / 2, (y0 + ey) / 2)
    addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
  }
}

// one connected drawing: n pieces (lines and shallow arcs in turn) round a ring,
// each ending a hair short of the next one's start
function ring(d: SketchDoc, n: number): void {
  const R = 1.2 * n / (2 * Math.PI)
  const at = (i: number) => { const t = 2 * Math.PI * i / n; return [R * Math.cos(t) + 50, R * Math.sin(t) + 50] as const }
  for (let i = 0; i < n; i++) {
    const [x0, y0] = at(i), [x1, y1] = at(i + 1)
    const ex = x1 + 0.04 * Math.cos(i), ey = y1 + 0.04 * Math.sin(i * 1.7)
    const s = addPoint(d, x0, y0), e = addPoint(d, ex, ey)
    if (i % 2) {
      const c = addPoint(d, (x0 + ex) / 2 - (ey - y0) * 2, (y0 + ey) / 2 + (ex - x0) * 2)
      addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    } else addPath(d, [s, e], [{ kind: 'line' }])
  }
}

describe('solveHeld and componentOf', () => {
  it('keeps held points and held circle radii where they are', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 3, 1)
    addConstraint(d, 'horizontal', [a, b])
    const c = addCircle(d, addPoint(d, 10, 0), 2), c2 = addCircle(d, addPoint(d, 20, 0), 3)
    addConstraint(d, 'equalRadius', [c, c2])
    expect(solveHeld(d, new Set([b, c]))).toBe(true)
    expect(P(d, b)).toMatchObject({ x: 3, y: 1 })
    expect(P(d, b).fixed).toBeUndefined()
    expect(P(d, a).y).toBeCloseTo(1, 6)
    expect(P(d, c).r).toBeCloseTo(2, 5)
    expect(P(d, c2).r).toBeCloseTo(2, 5)
  })
  it('the connected part a point belongs to', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0), l = addLine(d, a, b)
    const x = addPoint(d, 5, 5), y = addPoint(d, 6, 5), m = addLine(d, x, y)
    addConstraint(d, 'horizontal', [x, y])
    const part = componentOf(d, [a])
    expect(part.entities.map(e => e.id).sort()).toEqual([a, b, l].sort())
    expect(part.constraints).toEqual([])
    expect(componentOf(d, [y]).constraints).toHaveLength(1)
    expect(componentOf(d, [y]).entities.map(e => e.id).sort()).toEqual([x, y, m].sort())
  })
})

describe('windowOf', () => {
  it('reaches two hops along pieces and rules, and frees the radius of a circle centred in it', () => {
    const d = blank()
    const p = addPoint(d, 0, 0), q = addPoint(d, 1, 0), c = addPoint(d, 2, 0), far = addPoint(d, 9, 9)
    addLine(d, p, q); addLine(d, q, c)
    const circ = addCircle(d, c, 1)
    const x = addPoint(d, 20, 0), y = addPoint(d, 21, 0), z = addPoint(d, 22, 0)
    addLine(d, x, y); addLine(d, y, z)
    addConstraint(d, 'horizontal', [p, far])        // a rule is a hop
    const w = windowOf(d, [p])
    for (const id of [p, q, c, circ, far]) expect(w.has(id)).toBe(true)
    for (const id of [x, y, z]) expect(w.has(id)).toBe(false)
  })
})

describe('guards', () => {
  it('a point may move 8 px, or a tenth of its smallest piece when that is more', () => {
    const d = blank()
    const a = addPoint(d, 0, 0), b = addPoint(d, 1, 0)
    addLine(d, a, b)                                   // 34 px long: the 8 px floor wins
    const base = baselineOf(d, U)
    const w = cloneDoc(d)
    P(w, b).x += 7 * U
    expect(movedTooFar(w, base)).toBe(false)
    P(w, b).x += 2 * U
    expect(movedTooFar(w, base)).toBe(true)
    const long = blank()
    const p = addPoint(long, 0, 0), q = addPoint(long, 10, 0)
    addLine(long, p, q)                                // 340 px long: 34 px allowed
    const lb = baselineOf(long, U), lw = cloneDoc(long)
    P(lw, q).x += 30 * U
    expect(movedTooFar(lw, lb)).toBe(false)
  })
  const arcDoc = () => {
    const d = blank()
    const A = addPoint(d, 0, 0), B = addPoint(d, 4, 0), C = addPoint(d, 2, 3)
    addPath(d, [A, B], [{ kind: 'arc', center: C, sweep: 1 }])   // a shallow arc below its ends
    return { d, A, B, C }
  }
  it('an arc that jumps from small to large is broken', () => {
    const { d, C } = arcDoc()
    const base = baselineOf(d, U)
    expect(arcBroken(cloneDoc(d), base, id => id)).toBe(false)
    const w = cloneDoc(d)
    P(w, C).y = -3
    expect(arcBroken(w, base, id => id)).toBe(true)
  })
  it('an arc squeezed under 2 px is broken', () => {
    const { d, A, B, C } = arcDoc()
    const base = baselineOf(d, U)
    const w = cloneDoc(d)
    Object.assign(P(w, A), { x: 0, y: 0 }); Object.assign(P(w, B), { x: 0.04, y: 0 }); Object.assign(P(w, C), { x: 0.02, y: 0.01 })
    expect(arcBroken(w, base, id => id)).toBe(true)
  })
})

describe('runCleanup', () => {
  it('joins the trimmed flower into one closed loop and leaves the drawing it was given alone', () => {
    const d = blank(); flower(d)
    const before = JSON.stringify(d)
    const r = runCleanup(d, opts())
    expect(JSON.stringify(d)).toBe(before)
    expect(r.refused).toBeUndefined()
    expect(r.fixes.filter(f => f.kind === 'join' && f.on)).toHaveLength(4)
    const ps = paths(r.doc)
    expect(ps).toHaveLength(1)
    expect(ps[0].closed).toBe(true)
    expect(ps[0].segments.map((s: any) => s.kind)).toEqual(['arc', 'arc', 'arc', 'arc'])
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
  })
  it('gives the same answer for the same switches', () => {
    const d = blank(); flower(d)
    const a = runCleanup(d, opts()), b = runCleanup(d, opts())
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    const joinId = a.fixes.find(f => f.kind === 'join')!.id
    const off = runCleanup(d, opts({ off: new Set([joinId]) }))
    expect(off.fixes.find(f => f.id === joinId)!.on).toBe(false)
    // the other joins are found and kept either way (later fixes may pair differently once a gap stays open)
    const others = a.fixes.filter(f => f.kind === 'join' && f.id !== joinId).map(f => f.id)
    expect(others).toHaveLength(3)
    for (const id of others) expect(off.fixes.find(f => f.id === id)?.on).toBe(true)
    expect(paths(off.doc)).toHaveLength(1)
    expect(paths(off.doc)[0].closed).toBe(false)
    expect(JSON.stringify(runCleanup(d, opts({ off: new Set() })))).toBe(JSON.stringify(a))
  })
  it('typed sizes never move: a nearly equal line takes the typed length', () => {
    const d = blank()
    const t = lineAt(d, 0, 0, 20, 5.1)
    addConstraint(d, 'distance', [t.a, t.b], 5.1)
    const u = lineAt(d, 10, 0, 70, 5)
    const r = runCleanup(d, opts())
    expect(r.fixes.find(f => f.kind === 'equalLength')?.on).toBe(true)
    expect(len(r.doc, t)).toBeCloseTo(5.1, 5)
    expect(len(r.doc, u)).toBeCloseTo(5.1, 5)
  })
  it('drops a fix the other rules can’t allow', () => {
    const d = blank()
    const k = Math.tan(rad(3))
    const A = addPoint(d, 0, 0, { fixed: true }), B = addPoint(d, 1, k), C = addPoint(d, 1, 1 + k, { fixed: true })
    addLine(d, A, B); addLine(d, B, C)
    addConstraint(d, 'vertical', [B, C]); addConstraint(d, 'distance', [B, C], 1)
    const r = runCleanup(d, opts())
    expect(r.fixes.some(f => f.kind === 'horizontal')).toBe(false)
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
  })
  it('adds nothing the drawing already says', () => {
    const d = blank()
    const p = ([[0, 0], [4, 0], [4, 4], [0, 4]] as const).map(([x, y]) => addPoint(d, x, y))
    addPath(d, p, [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    addConstraint(d, 'horizontal', [p[0]!, p[1]!]); addConstraint(d, 'vertical', [p[1]!, p[2]!])
    addConstraint(d, 'horizontal', [p[2]!, p[3]!]); addConstraint(d, 'vertical', [p[3]!, p[0]!])
    const r = runCleanup(d, opts())
    expect(r.fixes.filter(f => ['horizontal', 'vertical', 'parallel', 'perpendicular'].includes(f.kind))).toEqual([])
  })
  it('Parallel adds nothing after Horizontal on both lines, and Square nothing after Horizontal and Vertical', () => {
    const d = blank()
    const l1 = lineAt(d, 0, 0, 2, 8), l2 = lineAt(d, 0, 5, -1.5, 8)
    const r = runCleanup(d, opts())
    expect(r.fixes.filter(f => f.kind === 'horizontal' && f.on)).toHaveLength(2)
    expect(r.fixes.some(f => f.kind === 'parallel')).toBe(false)
    expect(r.doc.constraints.filter(c => c.kind === 'parallel')).toEqual([])
    expect(P(r.doc, l1.b).y).toBeCloseTo(P(r.doc, l1.a).y, 6)
    expect(P(r.doc, l2.b).y).toBeCloseTo(P(r.doc, l2.a).y, 6)
    // an L corner: level and upright, so the corner is already square
    const e = blank()
    const A = addPoint(e, 0, 0), B = addPoint(e, 8, 0.2), C = addPoint(e, 8.15, 6)
    addLine(e, A, B); addLine(e, B, C)
    const q = runCleanup(e, opts())
    expect(q.fixes.filter(f => (f.kind === 'horizontal' || f.kind === 'vertical') && f.on)).toHaveLength(2)
    expect(q.fixes.some(f => f.kind === 'perpendicular')).toBe(false)
    expect(q.doc.constraints.filter(c => c.kind === 'perpendicular')).toEqual([])
  })
  it('a rule the drawing already implies is not a fix: Horizontal on the second of two parallel lines', () => {
    const d = blank()
    const l1 = lineAt(d, 0, 0, 2, 8), l2 = lineAt(d, 0, 5, 2, 6)
    addConstraint(d, 'parallel', [l1.a, l1.b, l2.a, l2.b])
    const r = runCleanup(d, opts())
    expect(r.fixes.filter(f => f.kind === 'horizontal' && f.on)).toHaveLength(1)
    expect(r.doc.constraints.filter(c => c.kind === 'horizontal')).toHaveLength(1)
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
    expect(P(r.doc, l2.b).y).toBeCloseTo(P(r.doc, l2.a).y, 6)
  })
  it('looks at a Repeat’s source only', () => {
    const d = blank()
    const centre = addPoint(d, 0, 0, { fixed: true })
    const a = addPoint(d, 3, 0), b = addPoint(d, 6, 3 * Math.tan(rad(3)))
    const l = addLine(d, a, b)
    repeatEntities(d, [l], centre, 4)
    const r = runCleanup(d, opts())
    const dirs = r.fixes.filter(f => f.kind === 'horizontal' || f.kind === 'vertical')
    expect(dirs).toHaveLength(1)
    expect(dirs[0]!.id).toBe(`horizontal:${[a, b].sort().join('~')}`)
    expect(dirs[0]!.on).toBe(true)
  })
  it('works on the selection, and leaves the rest exactly where it was', () => {
    const d = blank()
    const l1 = lineAt(d, 0, 0, 2, 8), l2 = lineAt(d, 0, 5, 2, 8)
    const r = runCleanup(d, opts({ scope: { entities: [l1.id], segments: [] } }))
    expect(r.fixes.filter(f => f.kind === 'horizontal' && f.on)).toHaveLength(1)
    for (const id of [l2.a, l2.b]) expect({ x: P(r.doc, id).x, y: P(r.doc, id).y }).toEqual({ x: P(d, id).x, y: P(d, id).y })
  })
  it('in an open-only pen a join never closes a path', () => {
    const d = blank()
    const A = addPoint(d, 0, 0), B = addPoint(d, 5, 0)
    addPath(d, [A, B], [{ kind: 'arc', center: addPoint(d, 2.5, 0), sweep: 1 }])
    const C = addPoint(d, 5.1, 0.05), D = addPoint(d, 0.08, 0.05)
    addPath(d, [C, D], [{ kind: 'arc', center: addPoint(d, 2.59, 0.05), sweep: 1 }])
    const open = runCleanup(d, opts({ openOnly: true }))
    expect(open.fixes.filter(f => f.kind === 'join' && f.on)).toHaveLength(1)
    expect(paths(open.doc).some(p => p.closed)).toBe(false)
    expect(paths(runCleanup(d, opts()).doc).some(p => p.closed)).toBe(true)
  })
  it('a short line tied by a rule to another line is never squeezed to nothing', () => {
    for (const px of [6, 10, 12, 14]) {
      const d = blank()
      const A = lineAt(d, 0, 0, 3, px * U)
      const B = lineAt(d, 0, 3, 3, 4)
      addConstraint(d, 'parallel', [A.a, A.b, B.a, B.b])
      const r = runCleanup(d, opts())
      expect(len(r.doc, A) / U).toBeGreaterThan(2)
      expect(maxRes(r.doc)).toBeLessThan(1e-3)
    }
  })
  it('a short straight path segment tied by a rule to another line is never squeezed to nothing', () => {
    for (const px of [6, 10, 12, 14]) {
      const d = blank()
      const a = addPoint(d, 0, 0), b = addPoint(d, px * U * Math.cos(rad(3)), px * U * Math.sin(rad(3)))
      addPath(d, [a, b], [{ kind: 'line' }])
      const B = lineAt(d, 0, 3, 3, 4)
      addConstraint(d, 'parallel', [a, b, B.a, B.b])
      const r = runCleanup(d, opts())
      expect(len(r.doc, { a, b }) / U).toBeGreaterThan(2)
      expect(maxRes(r.doc)).toBeLessThan(1e-3)
    }
  })
  it('never joins two ends that may not move', () => {
    const d = blank()
    const A = addPoint(d, 0, 0), B = addPoint(d, 5, 0, { fixed: true })
    const C = addPoint(d, 5.1, 0.05, { fixed: true }), D = addPoint(d, 9, 3)
    addLine(d, A, B); addLine(d, C, D)
    const r = runCleanup(d, opts())
    expect(r.fixes.some(f => f.kind === 'join')).toBe(false)
    expect(r.doc.entities.filter(e => e.kind === 'point')).toHaveLength(4)
    // control: with one end free the same gap is joined
    const e = blank()
    const A2 = addPoint(e, 0, 0), B2 = addPoint(e, 5, 0, { fixed: true })
    const C2 = addPoint(e, 5.1, 0.05), D2 = addPoint(e, 9, 3)
    addLine(e, A2, B2); addLine(e, C2, D2)
    expect(runCleanup(e, opts()).fixes.some(f => f.kind === 'join' && f.on)).toBe(true)
  })
  it('a mirror pair the rules can’t allow leaves no guide behind', () => {
    const make = (fixed: boolean) => {
      const d = blank()
      addCircle(d, addPoint(d, 0, 0, { fixed }), 1)
      addCircle(d, addPoint(d, 10, 0.1, { fixed }), 1)
      return d
    }
    // control: free centres are mirrored about a new upright guide
    const free = runCleanup(make(false), opts())
    expect(free.fixes.some(f => f.kind === 'mirror' && f.on)).toBe(true)
    expect(free.doc.entities.some(e => e.kind === 'line' && e.construction)).toBe(true)
    // fixed centres at different heights can't mirror: the guide it made goes away with it
    const d = make(true)
    const r = runCleanup(d, opts())
    expect(r.fixes.some(f => f.kind === 'mirror')).toBe(false)
    expect(r.doc.entities).toHaveLength(d.entities.length)
    expect(r.doc.entities.some(e => e.kind !== 'circle' && e.construction)).toBe(false)
    expect(r.doc.constraints.map(c => c.kind)).toEqual(r.fixes.some(f => f.kind === 'equalRadius' && f.on) ? ['equalRadius'] : [])
  })
  it('a rounded size leaves no rule behind', () => {
    const d = blank()
    const l = lineAt(d, 0, 0, 30, 5.05)
    const r = runCleanup(d, opts())
    expect(r.fixes.find(f => f.kind === 'round')).toMatchObject({ on: true, label: 'Rounded to 5' })
    expect(len(r.doc, l)).toBeCloseTo(5, 5)
    expect(r.doc.constraints).toEqual([])
  })
  it('refuses a drawing of more than 150 pieces', () => {
    const d = blank()
    for (let i = 0; i < 151; i++) addLine(d, addPoint(d, i * 3, 0), addPoint(d, i * 3 + 1, 1))
    const r = runCleanup(d, opts())
    expect(r.refused).toBe('tooBig')
    expect(r.fixes).toEqual([])
  })
  it('cleans a 40-piece drawing in a few seconds', () => {
    const d = blank()
    for (let i = 0; i < 8; i++) {
      const x = (i % 4) * 8, y = Math.floor(i / 4) * 8
      const p = ([[0, 0], [4, 0.1], [4.05, 4], [0, 4.1]] as const).map(([dx, dy]) => addPoint(d, x + dx, y + dy))
      addPath(d, p, [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    }
    for (let i = 0; i < 8; i++) addLine(d, addPoint(d, i * 4, 20), addPoint(d, i * 4 + 3, 20.1))
    const t0 = performance.now()
    const r = runCleanup(d, opts())
    expect(performance.now() - t0).toBeLessThan(8000)
    expect(r.fixes.some(f => f.on)).toBe(true)
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
  })
  it('cleans one connected drawing of 120 pieces fast enough to re-run on every switch', () => {
    const d = blank(); ring(d, 120)
    const t0 = performance.now()
    const r = runCleanup(d, opts())
    const ms = performance.now() - t0
    expect(r.fixes.filter(f => f.kind === 'join' && f.on)).toHaveLength(120)
    expect(paths(r.doc)).toHaveLength(1)
    expect(paths(r.doc)[0].closed).toBe(true)
    expect(maxRes(r.doc)).toBeLessThan(1e-3)
    const t1 = performance.now()
    runCleanup(d, opts({ off: new Set([r.fixes[0]!.id]) }))
    expect(Math.max(ms, performance.now() - t1)).toBeLessThan(4000)   // ~0.2–0.8 s here; it took ~20 s before the window solve
  })
})
