// tests/unit/sketch-corners.unit.spec.ts
// Pen stage 8: Round corner and Chamfer, pure — which points are corners
// (spliced into one path, or two separate pieces), the fillet (line–line,
// line–arc, arc–arc) and the chamfer, too big, the virtual sharp keeping
// rules on the corner, several corners tied Equal, fills carried, the
// preview, and speed on one connected drawing and a symmetric grid.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId, PathEntity } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint } from '~/lib/sketch/edit'
import { cloneDoc } from '~/lib/sketch/clone'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'
import { toggleFillAt, fillState } from '~/lib/sketch/fills'
import { cornerCheck, cornersOf, cornerAt, cornerGeom, sizeFromPointer, roundCorners, cornerPreview, fittingSize } from '~/lib/sketch/corners'
import { gear, rectGrid, squarePath } from './__fixtures__/penStage8'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const P = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as any
const allHold = (d: SketchDoc) => constraintResiduals(d).every(v => Math.abs(v) < 1e-7)
const pathOf = (d: SketchDoc, id: string) => d.entities.find(e => e.id === id) as PathEntity

describe('which points are corners', () => {
  it('every anchor of a closed square is a spliced corner; its sides run into and out of it', () => {
    const d = doc(); const { path, pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.corner.spliced).toBe(true)
    expect(c.corner.a).toMatchObject({ host: 'seg', id: path, segIndex: 3, far: pts[3], xIsStart: false, kind: 'line' })
    expect(c.corner.b).toMatchObject({ host: 'seg', id: path, segIndex: 0, far: pts[1], xIsStart: true, kind: 'line' })
    expect(cornersOf(d).size).toBe(4)
  })
  it('two line entities sharing an end make a corner that is not spliced', () => {
    const d = doc()
    const a = addPoint(d, 0, 4), x = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    addLine(d, a, x); addLine(d, x, b)
    const c = cornerCheck(d, x)
    expect(c.ok && !c.corner.spliced).toBe(true)
  })
  it('refuses: an open end, a T-junction, a centre, a Bézier side, a straight run, a guide', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 8, 0), t = addPoint(d, 4, 4)
    addPath(d, [a, b, c], [{ kind: 'line' }, { kind: 'line' }])
    addLine(d, b, t)
    expect(cornerCheck(d, a)).toEqual({ ok: false, why: 'notCorner' })   // an open end
    expect(cornerCheck(d, b)).toEqual({ ok: false, why: 'notCorner' })   // three pieces
    const d2 = doc()
    const p = addPoint(d2, 0, 0), q = addPoint(d2, 4, 0), r = addPoint(d2, 8, 0), h = addPoint(d2, 6, 2)
    addPath(d2, [p, q, r], [{ kind: 'line' }, { kind: 'cubic', h1: h, h2: null }])
    expect(cornerCheck(d2, q)).toEqual({ ok: false, why: 'curve' })
    const d3 = doc()
    const u = addPoint(d3, 0, 0), v = addPoint(d3, 4, 0), w = addPoint(d3, 8, 0)
    addPath(d3, [u, v, w], [{ kind: 'line' }, { kind: 'line' }])
    expect(cornerCheck(d3, v)).toEqual({ ok: false, why: 'smooth' })
    const d4 = doc()
    const g1 = addPoint(d4, 0, 4), gx = addPoint(d4, 0, 0), g2 = addPoint(d4, 4, 0)
    addLine(d4, g1, gx, { construction: true }); addLine(d4, gx, g2, { construction: true })
    expect(cornerCheck(d4, gx).ok).toBe(false)
  })
  it('cornerAt finds the nearest corner within the tolerance', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    expect(cornerAt(d, { x: 4.1, y: 3.9 }, 0.3)).toBe(pts[2])
    expect(cornerAt(d, { x: 2, y: 2 }, 0.3)).toBeNull()
  })
})

describe('geometry', () => {
  it('a right-angle line corner: touch points r back, centre on the bisector', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!); if (!c.ok) throw new Error()
    const g = cornerGeom(d, c.corner, 'round', 1)!
    expect(g.fits).toBe(true)
    expect(g.t1.x).toBeCloseTo(0, 9); expect(g.t1.y).toBeCloseTo(1, 9)   // on the side from (0,4)
    expect(g.t2.x).toBeCloseTo(1, 9); expect(g.t2.y).toBeCloseTo(0, 9)   // on the side to (4,0)
    expect(g.c!.x).toBeCloseTo(1, 9); expect(g.c!.y).toBeCloseTo(1, 9)
    expect(g.fa).toBeCloseTo(0.25, 9); expect(g.fb).toBeCloseTo(0.25, 9)
  })
  it('a chamfer: equal straight setbacks', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[1]!); if (!c.ok) throw new Error()
    const g = cornerGeom(d, c.corner, 'chamfer', 1.5)!
    expect(Math.hypot(g.t1.x - 4, g.t1.y)).toBeCloseTo(1.5, 9)
    expect(Math.hypot(g.t2.x - 4, g.t2.y)).toBeCloseTo(1.5, 9)
  })
  it('a line into an arc: the fillet touches both, inside the turn', () => {
    const d = doc()
    const a = addPoint(d, -4, 0), x = addPoint(d, 0, 0), e = addPoint(d, 3, 3), ca = addPoint(d, 3, 0)
    addPath(d, [a, x, e], [{ kind: 'line' }, { kind: 'arc', center: ca, sweep: 0 }])
    const c = cornerCheck(d, x); if (!c.ok) throw new Error(JSON.stringify(c))
    const g = cornerGeom(d, c.corner, 'round', 0.5)!
    expect(g.fits).toBe(true)
    // the corner turns from "left along the line" to "up along the arc": the
    // fillet sits up and to the left, touching the arc's circle from outside
    expect(g.c!.x).toBeLessThan(0); expect(g.c!.y).toBeGreaterThan(0)
    expect(Math.abs(g.c!.y - g.t1.y)).toBeCloseTo(0.5, 6)                              // r from the line
    expect(Math.hypot(g.c!.x - 3, g.c!.y)).toBeCloseTo(3 + 0.5, 6)
    expect(Math.hypot(g.t2.x - 3, g.t2.y)).toBeCloseTo(3, 6)
    expect(Math.hypot(g.t2.x - g.c!.x, g.t2.y - g.c!.y)).toBeCloseTo(0.5, 6)
  })
  it('two arcs (a lens’ tip): the fillet sits inside, touching both circles from inside', () => {
    const d = doc()
    const L = addPoint(d, -3, 0), R = addPoint(d, 3, 0), cu = addPoint(d, 0, -3), cl = addPoint(d, 0, 3)
    addPath(d, [L, R], [{ kind: 'arc', center: cu, sweep: 0 }, { kind: 'arc', center: cl, sweep: 0 }], true)
    const c = cornerCheck(d, R); if (!c.ok) throw new Error(JSON.stringify(c))
    expect(c.corner.spliced).toBe(true)
    const g = cornerGeom(d, c.corner, 'round', 0.3)!
    expect(g.fits).toBe(true)
    const R0 = Math.hypot(3, 3)
    expect(Math.hypot(g.c!.x, g.c!.y + 3)).toBeCloseTo(R0 - 0.3, 6)
    expect(Math.hypot(g.c!.x, g.c!.y - 3)).toBeCloseTo(R0 - 0.3, 6)
    expect(g.c!.x).toBeLessThan(3); expect(Math.abs(g.c!.y)).toBeLessThan(1e-6)
    const work = cloneDoc(d)
    expect(roundCorners(work, [R], 'round', 0.3).ok).toBe(true)
    expect(allHold(work)).toBe(true)
  })
  it('too big: a radius longer than a side does not fit; fittingSize halves until it does', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!); if (!c.ok) throw new Error()
    expect(cornerGeom(d, c.corner, 'round', 5)!.fits).toBe(false)
    expect(fittingSize(d, [pts[0]!], 'round', 20)).toBeCloseTo(2.5, 9)
  })
  it('the size follows the pointer along the bisector', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const c = cornerCheck(d, pts[0]!); if (!c.ok) throw new Error()
    // the arc's middle for r = 1 sits at (1 − √½, 1 − √½)
    const m = 1 - Math.SQRT1_2
    expect(sizeFromPointer(d, c.corner, 'round', { x: m, y: m })).toBeCloseTo(1, 9)
    expect(sizeFromPointer(d, c.corner, 'chamfer', { x: 0.75, y: 0.75 })).toBeCloseTo(1.5, 9)
    expect(sizeFromPointer(d, c.corner, 'round', { x: -1, y: -1 })).toBe(0)
  })
})

describe('construction', () => {
  it('rounds a square’s corner into its path: one more piece, an arc, every rule holding', () => {
    const d = doc(); const { path, pts } = squarePath(d, 0, 0, 4)
    const r = roundCorners(d, [pts[0]!], 'round', 1)
    expect(r.ok).toBe(true)
    const p = pathOf(d, path)
    expect(p.anchors).toHaveLength(5)
    expect(p.segments.filter(s => s.kind === 'arc')).toHaveLength(1)
    expect(P(d, pts[0]!).construction).toBe(true)             // the virtual sharp
    expect(p.anchors.includes(pts[0]!)).toBe(false)
    expect(allHold(d)).toBe(true)
    expect(r.rules.length).toBeGreaterThanOrEqual(5)
  })
  it('a rule on the corner still holds after rounding, and a drag keeps the arc tangent', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    addConstraint(d, 'perpendicular', [pts[3]!, pts[0]!, pts[0]!, pts[1]!])   // a right angle at the corner
    roundCorners(d, [pts[0]!], 'round', 1)
    expect(allHold(d)).toBe(true)
    expect(solve(d, { drag: { point: pts[1]!, x: 5, y: 0.5 } }).converged).toBe(true)
    expect(allHold(d)).toBe(true)
  })
  it('two separate lines: their ends move to the touch points and the arc is its own piece', () => {
    const d = doc()
    const a = addPoint(d, 0, 4), x = addPoint(d, 0, 0), b = addPoint(d, 4, 0)
    const l1 = addLine(d, a, x), l2 = addLine(d, x, b)
    const r = roundCorners(d, [x], 'chamfer', 1)
    expect(r.ok).toBe(true)
    expect([P(d, l1).p1, P(d, l1).p2]).not.toContain(x)
    expect([P(d, l2).p1, P(d, l2).p2]).not.toContain(x)
    expect(d.entities.filter(e => e.kind === 'path')).toHaveLength(1)
    expect(allHold(d)).toBe(true)
  })
  it('several corners get one size, tied Equal to the first', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const r = roundCorners(d, pts, 'round', 1)
    expect(r.ok).toBe(true)
    const equals = d.constraints.filter(c => c.kind === 'equalDist' && c.refs[0] !== c.refs[2])
    expect(equals).toHaveLength(3)
    expect(allHold(d)).toBe(true)
  })
  it('refuses the whole set when one corner is too big, and says which', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const r = roundCorners(d, [pts[0]!, pts[1]!], 'round', 2.5)   // 2.5 + 2.5 > 4 on the shared side
    expect(r.ok).toBe(false)
    expect(r.bad).toEqual([pts[1]])
  })
  it('a filled square stays filled when one corner, then every corner, is rounded', () => {
    const d = doc(); squarePath(d, 0, 0, 4)
    expect(toggleFillAt(d, { x: 2, y: 2 }, 0)).toBe(true)
    const one = cloneDoc(d)
    const c0 = [...cornersOf(one).keys()][0]!
    roundCorners(one, [c0], 'round', 1)
    expect(fillState(one).filled).toHaveLength(1)
    const all = cloneDoc(d)
    roundCorners(all, [...cornersOf(all).keys()], 'chamfer', 1)
    const st = fillState(all)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(16 - 4 * 0.5, 6)
  })
})

describe('construction — more shapes (added by the implementer)', () => {
  it('four separate lines, filled: rounding one corner makes a one-piece path and the area stays filled', () => {
    const d = doc()
    const q = [[0, 0], [4, 0], [4, 4], [0, 4]].map(([x, y]) => addPoint(d, x!, y!))
    for (let i = 0; i < 4; i++) addLine(d, q[i]!, q[(i + 1) % 4]!)
    expect(toggleFillAt(d, { x: 2, y: 2 }, 0)).toBe(true)
    const r = roundCorners(d, [q[0]!], 'round', 1)
    expect(r.ok).toBe(true)
    const paths = d.entities.filter(e => e.kind === 'path') as PathEntity[]
    expect(paths).toHaveLength(1)
    expect(paths[0]!.anchors).toHaveLength(2)
    expect(paths[0]!.segments[0]!.kind).toBe('arc')
    expect(allHold(d)).toBe(true)
    const st = fillState(d)
    expect(st.filled).toHaveLength(1)
    expect(st.fs.faces[st.filled[0]!]!.area).toBeCloseTo(16 - (1 - Math.PI / 4), 6)
  })
  it('a filled lens stays filled when a tip (arc into arc) is rounded', () => {
    const d = doc()
    const L = addPoint(d, -3, 0), R = addPoint(d, 3, 0), cu = addPoint(d, 0, -3), cl = addPoint(d, 0, 3)
    addPath(d, [L, R], [{ kind: 'arc', center: cu, sweep: 0 }, { kind: 'arc', center: cl, sweep: 0 }], true)
    expect(toggleFillAt(d, { x: 0, y: 0 }, 0)).toBe(true)
    const before = fillState(d)
    const a0 = before.fs.faces[before.filled[0]!]!.area
    for (const x of [R, L]) {
      const work = cloneDoc(d)
      expect(roundCorners(work, [x], 'round', 0.3).ok).toBe(true)
      const st = fillState(work)
      expect(st.filled).toHaveLength(1)
      const a = st.fs.faces[st.filled[0]!]!.area
      expect(a).toBeLessThan(a0); expect(a).toBeGreaterThan(a0 - 0.5)
    }
  })
  it('an open path whose ends meet: the corner closes it into one closed path', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), c = addPoint(d, 4, 4), e = addPoint(d, 0, 4)
    const path = addPath(d, [a, b, c, e, a], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }])
    const chk = cornerCheck(d, a)
    expect(chk.ok).toBe(true)
    const r = roundCorners(d, [a], 'chamfer', 1)
    expect(r.ok).toBe(true)
    const p = pathOf(d, path)
    expect(p.closed).toBe(true)
    expect(p.anchors).toHaveLength(5)
    expect(p.segments).toHaveLength(5)
    expect(p.anchors.includes(a)).toBe(false)
    expect(allHold(d)).toBe(true)
  })
  it('a chamfer keeps a rule on the corner too; the Equal tie reads the setbacks', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    addConstraint(d, 'horizontal', [pts[0]!, pts[1]!])
    const r = roundCorners(d, [pts[0]!, pts[2]!], 'chamfer', 1)
    expect(r.ok).toBe(true)
    expect(r.rules.every(id => d.constraints.some(k => k.id === id))).toBe(true)
    expect(allHold(d)).toBe(true)
    expect(solve(d, { drag: { point: pts[1]!, x: 5, y: 0 } }).converged).toBe(true)
    expect(allHold(d)).toBe(true)
  })
})

describe('fix round 1 (review)', () => {
  // the fillet's direction of travel at a touch point, and the side's there
  const arcDir = (C: { x: number; y: number }, T: { x: number; y: number }, ccw: boolean) => {
    const r = Math.hypot(T.x - C.x, T.y - C.y), k = ccw ? 1 : -1
    return { x: (-k * (T.y - C.y)) / r, y: (k * (T.x - C.x)) / r }
  }
  const dot = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x * b.x + a.y * b.y

  it('a refused set leaves the drawing byte-identical', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    toggleFillAt(d, { x: 2, y: 2 }, 0)
    const before = JSON.stringify(d)
    const r = roundCorners(d, [pts[0]!, pts[1]!], 'round', 2.5)
    expect(r.ok).toBe(false)
    expect(r.bad).toEqual([pts[1]])
    expect(JSON.stringify(d)).toBe(before)
  })

  it('a fillet always runs on smoothly into both sides — an arc that crosses back over the line gives no cusp', () => {
    let refused = 0, built = 0
    for (let deg = 95; deg <= 175; deg += 5) {
      for (const sweep of [0, 1] as const) {
        const d = doc()
        const a = addPoint(d, -4, 0), x = addPoint(d, 0, 0)
        const th = (deg * Math.PI) / 180, R = 3
        const C = { x: R * Math.cos(th), y: R * Math.sin(th) }
        // the arc's far end, a quarter turn round C from x in the arc's own way
        const phi = Math.atan2(-C.y, -C.x) + (sweep ? 1 : -1) * Math.PI / 2
        const e = addPoint(d, C.x + R * Math.cos(phi), C.y + R * Math.sin(phi)), ca = addPoint(d, C.x, C.y)
        addPath(d, [a, x, e], [{ kind: 'line' }, { kind: 'arc', center: ca, sweep }])
        const chk = cornerCheck(d, x); if (!chk.ok) continue
        for (const r of [0.2, 0.5, 1]) {
          const g = cornerGeom(d, chk.corner, 'round', r)
          if (!g || !g.fits) { refused++; continue }
          built++
          const ccw = g.sweep === 1
          // side a runs (−4,0) → x: +x; the fillet must leave t1 that way
          expect(dot(arcDir(g.c!, g.t1, ccw), { x: 1, y: 0 })).toBeGreaterThan(0.999)
          // and arrive at t2 running the arc's own way
          expect(dot(arcDir(g.c!, g.t2, ccw), arcDir(C, g.t2, sweep === 1))).toBeGreaterThan(0.999)
          const work = cloneDoc(d)
          expect(roundCorners(work, [x], 'round', r).ok).toBe(true)
          expect(allHold(work)).toBe(true)
        }
      }
    }
    expect(built).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })

  it('an arc into a line (the other way round) and a reflex corner are smooth too', () => {
    const d = doc()
    const e = addPoint(d, 3, 3), x = addPoint(d, 0, 0), a = addPoint(d, -4, 0), ca = addPoint(d, 3, 0)
    addPath(d, [e, x, a], [{ kind: 'arc', center: ca, sweep: 1 }, { kind: 'line' }])
    const chk = cornerCheck(d, x); if (!chk.ok) throw new Error(JSON.stringify(chk))
    const g = cornerGeom(d, chk.corner, 'round', 0.5)!
    expect(g.fits).toBe(true)
    expect(dot(arcDir(g.c!, g.t2, g.sweep === 1), { x: -1, y: 0 })).toBeGreaterThan(0.999)
    expect(dot(arcDir(g.c!, g.t1, g.sweep === 1), arcDir({ x: 3, y: 0 }, g.t1, true))).toBeGreaterThan(0.999)
    // the L's inner (reflex) corner: centre outside the L
    const l = doc()
    const q = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]].map(([px, py]) => addPoint(l, px!, py!))
    addPath(l, q, q.map(() => ({ kind: 'line' as const })), true)
    const c = cornerCheck(l, q[3]!); if (!c.ok) throw new Error()
    const gl = cornerGeom(l, c.corner, 'round', 0.5)!
    expect(gl.c!.x).toBeCloseTo(2.5, 9); expect(gl.c!.y).toBeCloseTo(2.5, 9)
    expect(roundCorners(l, [q[3]!], 'round', 0.5).ok).toBe(true)
    expect(allHold(l)).toBe(true)
  })

  it('every rule the build adds is reported, the arc side’s own rule included', () => {
    const d = doc()
    const a = addPoint(d, -4, 0), x = addPoint(d, 0, 0), e = addPoint(d, 3, 3), ca = addPoint(d, 3, 0)
    addPath(d, [a, x, e], [{ kind: 'line' }, { kind: 'arc', center: ca, sweep: 0 }])
    d.constraints = []   // an arc with no rule of its own
    const before = new Set(d.constraints.map(k => k.id))
    const r = roundCorners(d, [x], 'round', 0.5)
    expect(r.ok).toBe(true)
    const added = d.constraints.filter(k => !before.has(k.id)).map(k => k.id).sort()
    expect([...r.rules].sort()).toEqual(added)
  })

  it('the preview draws only the new and shortened pieces of a spliced corner', () => {
    const { doc: g, anchors } = gear(150)
    const pv = cornerPreview(g, [anchors[0]!], 'round', 0.1)
    expect(pv.fits).toBe(true)
    expect((pv.d.match(/M /g) ?? []).length).toBe(3)
    const r = Number(/ A (\S+) /.exec(pv.d)![1])
    expect(r).toBeCloseTo(0.1, 9)
  })
})

describe('preview', () => {
  it('draws the new pieces, changes nothing, and goes red with the too-big corners', () => {
    const d = doc(); const { pts } = squarePath(d, 0, 0, 4)
    const before = JSON.stringify(d)
    const ok = cornerPreview(d, [pts[0]!], 'round', 1)
    expect(ok.fits).toBe(true)
    expect(ok.d).toMatch(/ A 1 1 /)
    expect(JSON.stringify(d)).toBe(before)
    const bad = cornerPreview(d, [pts[0]!], 'round', 9)
    expect(bad.fits).toBe(false)
    expect(bad.bad).toHaveLength(1)
    expect(bad.bad[0]!.d).not.toBe('')
  })
})

describe('speed (one connected drawing, a symmetric grid)', () => {
  it('one gear corner: a preview frame stays well inside 16 ms', () => {
    const { doc: g, anchors } = gear(150)
    cornerPreview(g, [anchors[0]!], 'round', 0.1)   // warm up
    const t = performance.now()
    for (let i = 0; i < 10; i++) expect(cornerPreview(g, [anchors[0]!], 'round', 0.1 + i * 0.01).fits).toBe(true)
    expect((performance.now() - t) / 10).toBeLessThan(16)
  })
  it('all 150 gear corners at once: a rare, one-off frame', () => {
    const { doc: g, anchors } = gear(150)
    const t = performance.now()
    const every = cornerPreview(g, anchors, 'round', 0.05)
    expect(performance.now() - t).toBeLessThan(16 * 4)
    expect(every.fits).toBe(true)
  })
  it('the corner list is one quick pass', () => {
    const { doc: g } = gear(150)
    expect(cornersOf(g).size).toBe(150)
    const t = performance.now(); for (let i = 0; i < 20; i++) cornersOf(g); expect((performance.now() - t) / 20).toBeLessThan(4)
  })
  it('the grid: a preview frame of a quarter of its corners stays inside 16 ms', () => {
    const { doc: grid } = rectGrid(37)
    const gm = cornersOf(grid)
    expect(gm.size).toBe(148)
    const some = [...gm.keys()].filter((_, i) => i % 4 === 0)
    const t = performance.now()
    for (let i = 0; i < 10; i++) expect(cornerPreview(grid, some, 'chamfer', 0.1).fits).toBe(true)
    expect((performance.now() - t) / 10).toBeLessThan(16)
  })
})
