// tests/sketch-draw.spec.ts
import { test, expect } from '@playwright/test'

test('draw a line and a tangent circle via the API, then drag keeps it solved', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // draw a horizontal-ish line: two clicks
    D.setTool('line'); D.place(1, 2); D.place(12, 2)
    // draw a circle whose radius lands it tangent to that line:
    // center at (6,5), then a radius click 3 below → r≈3, bottom touches y=2 line
    D.setTool('circle'); D.place(6, 5); D.place(6, 2)
  })

  const info = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    return { ents: D.entityCount(), cons: D.constraintCount(), doc: D.doc }
  })
  // line(1) + its 2 pts + circle(1) + its center pt = 5 entities; at least the tangent constraint exists
  expect(info.ents).toBeGreaterThanOrEqual(5)
  expect(info.cons).toBeGreaterThanOrEqual(1)

  // perpendicular distance from the circle's center to the line == radius (tangent)
  const perp = () => page.evaluate(() => {
    const d = (window as any).__sketchDraw.doc
    const line = d.entities.find((e: any) => e.kind === 'line')
    const circle = d.entities.find((e: any) => e.kind === 'circle')
    const P = (id: string) => d.entities.find((e: any) => e.id === id)
    const a = P(line.p1), b = P(line.p2), c = P(circle.center)
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
    return { perp: Math.abs((dx * (c.y - a.y) - dy * (c.x - a.x)) / L), r: circle.r }
  })
  const before = await perp()
  expect(Math.abs(before.perp - before.r)).toBeLessThan(0.05)

  // drag the second line endpoint; tangency must survive
  await page.evaluate(() => {
    const d = (window as any).__sketchDraw.doc
    const line = d.entities.find((e: any) => e.kind === 'line')
    ;(window as any).__sketchDraw.drag(line.p2, 12, 6)
  })
  const after = await perp()
  expect(after.perp).toBeCloseTo(after.r, 1)
})

test('select two circles and apply concentric via the API', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('circle'); D.place(3, 5); D.place(3, 7)   // circle A, center (3,5)
    D.setTool('circle'); D.place(9, 5); D.place(9, 6)   // circle B, center (9,5) elsewhere
  })

  // select both circles, assert 'concentric' is an available verb, apply it
  const verbs = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    const circles = D.doc.entities.filter((e: any) => e.kind === 'circle')
    D.clearSel(); D.pick(circles[0].id); D.pick(circles[1].id, true)
    return D.availableConstraints().map((v: any) => v.kind)
  })
  expect(verbs).toContain('concentric')

  await page.evaluate(() => (window as any).__sketchDraw.apply('concentric'))

  const centers = await page.evaluate(() => {
    const d = (window as any).__sketchDraw.doc
    const cs = d.entities.filter((e: any) => e.kind === 'circle')
    const C = (id: string) => d.entities.find((e: any) => e.id === id)
    return cs.map((c: any) => C(c.center))
  })
  // concentric ⇒ the two centers coincide
  expect(Math.hypot(centers[0].x - centers[1].x, centers[0].y - centers[1].y)).toBeLessThan(0.01)
})

test('knot: unit path repeated 6x stays symmetric and welded under drag', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const result = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // center (fixed) via point tool then fix through the doc
    D.setTool('point'); D.place(8, 6)
    const ctr = D.doc.entities.find((e: any) => e.kind === 'point').id
    D.doc.entities.find((e: any) => e.id === ctr).fixed = true
    // unit: line up + arc over — drawn with the path tool API
    D.setTool('path')
    D.place(8, 1); D.place(8, 3)                     // line segment
    D.setNextSegment('arc'); D.place(10.5, 4.5)      // arc segment
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    // repeat 6x about the center
    D.repeat([path.id], ctr, 6)
    const paths = D.doc.entities.filter((e: any) => e.kind === 'path')
    const rotCount = D.doc.constraints.filter((c: any) => c.kind === 'rotatedFrom').length
    // drag the unit's outer anchor; symmetry must hold through the rules
    const outer = path.anchors[2]
    D.drag(outer, 11, 5.5)
    // check: every 60° copy of `outer` equals rotate(outer, k*60) about ctr
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const o = P(outer), c = P(ctr)
    let maxErr = 0
    for (const k of [1, 2, 3, 4, 5]) {
      const con = D.doc.constraints.find((x: any) => x.kind === 'rotatedFrom' && x.refs[1] === outer && Math.round(x.value) === k * 60)
      const cp = P(con.refs[0])
      const a = k * 60 * Math.PI / 180
      const rx = c.x + Math.cos(a) * (o.x - c.x) - Math.sin(a) * (o.y - c.y)
      const ry = c.y + Math.sin(a) * (o.x - c.x) + Math.cos(a) * (o.y - c.y)
      maxErr = Math.max(maxErr, Math.hypot(cp.x - rx, cp.y - ry))
    }
    return { paths: paths.length, rotCount, maxErr, status: D.status(), svg: D.copySvg().length }
  })

  expect(result.paths).toBe(6)
  expect(result.rotCount).toBeGreaterThanOrEqual(15)   // ≥3 pts × 5 copies
  expect(result.maxErr).toBeLessThan(0.01)             // symmetry held under drag
  expect(result.svg).toBeGreaterThan(50)               // real SVG came out
})

test('path: click-and-drag bows a segment into a circular arc', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const result = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(2, 2); D.pathUp(2, 2)          // first anchor, plain click
    D.pathDown(8, 2)                          // second anchor — appends a line segment
    D.pathMove(5, 4.5)                        // drag past the threshold → bows live
    D.pathUp(5, 4.5)                          // release → commits the arc
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const arcSeg = path.segments.find((s: any) => s.kind === 'arc')
    const center = arcSeg ? P(arcSeg.center) : null
    const p0 = P(path.anchors[0]), p1 = P(path.anchors[1])
    const dCenter = center ? Math.abs(Math.hypot(center.x - p0.x, center.y - p0.y) - Math.hypot(center.x - p1.x, center.y - p1.y)) : Infinity
    return { hasArc: !!arcSeg, dCenter, pathData: D.pathData() }
  })

  expect(result.hasArc).toBe(true)
  expect(result.dCenter).toBeLessThan(1e-6)
  expect(result.pathData).toContain(' A ')
})

test('tangent joint: arc snaps tangent to the previous line and stays smooth', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    // a horizontal line a→J
    D.pathDown(1, 3); D.pathUp(1, 3)
    D.pathDown(6, 3); D.pathUp(6, 3)              // J = (6,3), segment 0 = line
    // bow an arc off J, dragging near-tangent (pointer near the exact-tangent
    // circle's own boundary point (8,5) — see m3-task-2's report: the brief's
    // literal pointer here (6.2,5) is only 0.2 off the straight J→Pnew chord,
    // which is ~78° off tangentDir under the documented free-arc-tangent-angle
    // rule (verified against ~/lib/sketch/infer.ts directly, and the identical
    // shape/tolerance is exercised by tests/unit/sketch-tangent-joint.unit.spec.ts's
    // own (2.2,2)-vs-(3,2) fixtures for the same span=4 case) — so it can never
    // snap. 8.2 mirrors that fix, translated to this J=(6,3): ~5.4° off horizontal,
    // inside the 12° tolerance)
    D.pathDown(6, 7)                               // Pnew above
    D.pathMove(8.2, 5)                             // near-tangent bulge
    D.pathUp(8.2, 5)
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const perpRule = D.doc.constraints.find((c: any) => c.kind === 'perpendicular')
    // tangent invariant: at J, the line direction ⊥ (arcCenter − J)
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const arcSeg = path.segments[1]
    const J = P(path.anchors[1]), C = P(arcSeg.center), La = P(path.anchors[0])
    const lineDir = { x: J.x - La.x, y: J.y - La.y }
    const radial = { x: C.x - J.x, y: C.y - J.y }
    const dotBefore = Math.abs(lineDir.x * radial.x + lineDir.y * radial.y)
    // now drag the line's far endpoint; tangency must hold
    D.drag(path.anchors[0], 1, 5)
    const J2 = P(path.anchors[1]), C2 = P(arcSeg.center), La2 = P(path.anchors[0])
    const ld2 = { x: J2.x - La2.x, y: J2.y - La2.y }, rd2 = { x: C2.x - J2.x, y: C2.y - J2.y }
    const dotAfter = Math.abs(ld2.x * rd2.x + ld2.y * rd2.y)
    return { hasPerp: !!perpRule, segKinds: path.segments.map((s: any) => s.kind), dotBefore, dotAfter, d: D.pathData() }
  })

  expect(out.segKinds).toEqual(['line', 'arc'])
  expect(out.hasPerp).toBe(true)                 // tangent joint captured
  expect(out.dotBefore).toBeLessThan(0.01)       // tangent at commit (line ⊥ radius)
  expect(out.dotAfter).toBeLessThan(0.05)        // still tangent after dragging the line
  expect(out.d).toContain(' A ')
})

test('select two lines at an angle and apply perpendicular via the API', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // two lines at an arbitrary (non-perpendicular, non-parallel) angle
    D.setTool('line'); D.place(1, 1); D.place(8, 2)     // line A, shallow slope
    D.setTool('line'); D.place(2, 6); D.place(6, 9)      // line B, steep slope

    const lines = D.doc.entities.filter((e: any) => e.kind === 'line')
    D.clearSel(); D.pick(lines[0].id); D.pick(lines[1].id, true)
    const verbs = D.availableConstraints().map((v: any) => v.kind)

    D.apply('perpendicular')

    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const [l1, l2] = lines.map((l: any) => ({ p1: P(l.p1), p2: P(l.p2) }))
    const dot = (l1.p2.x - l1.p1.x) * (l2.p2.x - l2.p1.x) + (l1.p2.y - l1.p1.y) * (l2.p2.y - l2.p1.y)
    return { verbs, cons: D.constraintCount(), status: D.status(), dot }
  })

  expect(out.verbs).toContain('perpendicular')
  expect(out.verbs).toContain('parallel')
  expect(out.status).toMatch(/^solved/)
  expect(Math.abs(out.dot)).toBeLessThan(0.01)   // direction vectors now orthogonal
})

test('select a bent path\'s corner and apply Right angle via the API', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // a bent path — 3 anchors, 2 line segments, an arbitrary non-90 corner
    // angle. pathDown/pathUp with no move in between keeps both segments
    // straight lines (no bow past the drag threshold).
    D.setTool('path')
    D.pathDown(1, 1); D.pathUp(1, 1)      // a0
    D.pathDown(5, 1); D.pathUp(5, 1)      // a1 — corner
    D.pathDown(7, 5); D.pathUp(7, 5)      // a2
    D.finishPath(false)

    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const corner = path.anchors[1]

    D.clearSel(); D.pick(corner)
    const verbs = D.availableConstraints()
    const hasRightAngle = verbs.some((v: any) => v.kind === 'perpendicular' && v.label === 'Right angle')

    D.apply('perpendicular')

    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a0 = P(path.anchors[0]), a1 = P(path.anchors[1]), a2 = P(path.anchors[2])
    const u = { x: a1.x - a0.x, y: a1.y - a0.y }
    const v = { x: a2.x - a1.x, y: a2.y - a1.y }
    const dot = u.x * v.x + u.y * v.y
    return { hasRightAngle, segKinds: path.segments.map((s: any) => s.kind), status: D.status(), dot }
  })

  expect(out.segKinds).toEqual(['line', 'line'])
  expect(out.hasRightAngle).toBe(true)
  expect(out.status).toMatch(/^solved/)
  expect(Math.abs(out.dot)).toBeLessThan(0.01)   // the two segment directions are now orthogonal
})

test('path: Shift constrains a placed segment to the nearest 45° increment', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(2, 2); D.pathUp(2, 2)      // first anchor, plain click
    // shift-place near-horizontal — should snap the segment flat to y=2
    D.placeShift(9, 2.4)
    D.pathUp(9, 2.4)
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a0 = P(path.anchors[0]), a1 = P(path.anchors[1])
    return { a0, a1, segKinds: path.segments.map((s: any) => s.kind) }
  })

  expect(out.segKinds).toEqual(['line'])
  // axis-aligned: dy is (near-)zero, dx is not — the raw click's dy (0.4) is gone
  expect(Math.abs(out.a1.y - out.a0.y)).toBeLessThan(1e-6)
  expect(out.a1.y).toBeCloseTo(2, 6)
  expect(Math.abs(out.a1.x - out.a0.x)).toBeGreaterThan(1)
})

test('path: Shift snaps a near-vertical segment to exactly vertical', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(3, 1); D.pathUp(3, 1)      // first anchor
    // shift-place near-vertical (small x drift) — should snap flat to x=3
    D.placeShift(3.3, 8)
    D.pathUp(3.3, 8)
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a0 = P(path.anchors[0]), a1 = P(path.anchors[1])
    return { a0, a1 }
  })

  expect(Math.abs(out.a1.x - out.a0.x)).toBeLessThan(1e-6)
  expect(out.a1.x).toBeCloseTo(3, 6)
  expect(Math.abs(out.a1.y - out.a0.y)).toBeGreaterThan(1)
})

test('path: Shift-snapped horizontal segment captures a persistent constraint that survives dragging', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(3, 3); D.pathUp(3, 3)      // prev anchor
    // shift-place near-horizontal — snaps flat, and should now also capture
    // a `horizontal` constraint on the two anchor points (not just the position)
    D.placeShift(11, 3.4)
    D.pathUp(11, 3.4)
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const a0id = path.anchors[0], a1id = path.anchors[1]
    const hasHorizontal = D.doc.constraints.some((c: any) =>
      c.kind === 'horizontal' && c.refs.includes(a0id) && c.refs.includes(a1id))

    // drag one endpoint off-axis; the solver should snap it back onto the horizontal
    D.drag(a1id, 11, 9)

    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a0 = P(a0id), a1 = P(a1id)
    return { hasHorizontal, a0, a1, status: D.status() }
  })

  expect(out.hasHorizontal).toBe(true)
  expect(out.status).toMatch(/^solved/)
  expect(Math.abs(out.a1.y - out.a0.y)).toBeLessThan(0.01)
})

test('undo/redo restores and reapplies drawing state', async ({ page }) => {
  await page.goto('/dev/sketch-draw'); await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(2, 2); D.place(5, 5)   // two points
    const after2 = D.entityCount()
    D.undo()                                            // remove 2nd point
    const afterUndo = D.entityCount()
    D.redo()                                            // bring it back
    const afterRedo = D.entityCount()
    D.undo(); D.undo()                                  // back to empty (both points gone)
    return { after2, afterUndo, afterRedo, afterTwoUndo: D.entityCount() }
  })
  expect(out.after2).toBe(2)
  expect(out.afterUndo).toBe(1)
  expect(out.afterRedo).toBe(2)
  expect(out.afterTwoUndo).toBe(0)
})

test('path tool: removeLastAnchor steps back one anchor, cancelPath fully aborts with no ghost on undo', async ({ page }) => {
  await page.goto('/dev/sketch-draw'); await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    const baseline = D.entityCount()
    D.setTool('path')
    D.pathDown(1, 1); D.pathUp(1, 1)   // anchor 0 — its own committed history entry
    D.pathDown(4, 1); D.pathUp(4, 1)   // anchor 1 — another committed history entry
    const afterTwo = D.entityCount()
    const pendingAfterTwo = D.doc.entities.filter((e: any) => e.kind === 'point').length

    D.removeLastAnchor()               // back to 1 anchor — still pending, not cancelled; commits
    const pendingAfterBackspace = D.doc.entities.filter((e: any) => e.kind === 'point').length

    D.cancelPath()                     // abort entirely — deletes anchor 0 too; must ALSO commit,
                                        // or the next undo() below would skip straight over this
                                        // step and resurrect the already-removed anchor 1 (the
                                        // ghost-on-undo bug the brief calls out)
    const afterCancel = D.entityCount()
    const pathsAfterCancel = D.doc.entities.filter((e: any) => e.kind === 'path').length

    // one undo() should land on the state right before cancelPath (anchor 0
    // alone, baseline+1) — NOT jump past it back to baseline+2 (both anchors,
    // including the already-removed anchor 1 reappearing as a ghost)
    D.undo()
    const afterUndo = D.entityCount()

    return { baseline, afterTwo, pendingAfterTwo, pendingAfterBackspace, afterCancel, pathsAfterCancel, afterUndo }
  })

  expect(out.afterTwo).toBe(out.baseline + 2)          // two anchor points placed
  expect(out.pendingAfterTwo).toBe(2)
  expect(out.pendingAfterBackspace).toBe(1)             // removeLastAnchor dropped anchor 1
  expect(out.pathsAfterCancel).toBe(0)                  // no path entity ever committed
  expect(out.afterCancel).toBe(out.baseline)            // back to baseline — anchor 0 cleaned up too
  expect(out.afterUndo).toBe(out.baseline + 1)          // steps back ONE state (anchor 0), no ghost jump
})

test('path tool: selectTool (toolbar tool switch) cleans up a pending path AND commits — no ghost anchor on undo', async ({ page }) => {
  await page.goto('/dev/sketch-draw'); await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    const baseline = D.entityCount()
    D.setTool('path')
    D.pathDown(1, 1); D.pathUp(1, 1)   // anchor 0 — its own committed history entry
    D.pathDown(4, 1); D.pathUp(4, 1)   // anchor 1 — another committed history entry
    const afterTwo = D.entityCount()
    const idsAfterTwo = D.doc.entities.map((e: any) => e.id).sort()

    // real repro: click a DIFFERENT toolbar tool button mid-draw — setTool()
    // is the exact path selectTool() takes, wired to the toolbar's @click.
    // Both pending anchors are unreferenced (no path ever committed) so
    // cleanupPendingPath deletes them both — this call MUST also commit, or
    // the deletion never lands its own history entry and a single undo()
    // below jumps to a stale intermediate snapshot, resurrecting anchor 0
    // alone as an orphan ghost (present in the doc, but no longer part of
    // any pending path or committed path — selectTool already reset
    // pendingPath to null).
    D.setTool('point')
    const afterSwitch = D.entityCount()
    const pathsAfterSwitch = D.doc.entities.filter((e: any) => e.kind === 'path').length

    // one undo() must land EXACTLY on the full state right before the switch
    // (both anchors, matching what was actually on screen) — not a partial
    // ghost state with only one of the two deleted anchors resurrected.
    D.undo()
    const afterUndo = D.entityCount()
    const idsAfterUndo = D.doc.entities.map((e: any) => e.id).sort()

    return { baseline, afterTwo, idsAfterTwo, afterSwitch, pathsAfterSwitch, afterUndo, idsAfterUndo }
  })

  expect(out.afterTwo).toBe(out.baseline + 2)
  expect(out.afterSwitch).toBe(out.baseline)              // both pending anchors cleaned up on tool switch
  expect(out.pathsAfterSwitch).toBe(0)                    // no path entity ever committed
  expect(out.afterUndo).toBe(out.afterTwo)                // undo restores the FULL prior state...
  expect(out.idsAfterUndo).toEqual(out.idsAfterTwo)       // ...both original anchors, not a partial ghost
})

// M4 review Fix 1: undo()/redo() used to leave `pendingPath` (and pathDrag)
// intact after rolling `doc` back — every anchor placement commits history,
// so a mid-draw ⌘Z rewinds the doc to before the pending anchors while
// `pendingPath.anchors` still names those now-absent ids. The NEXT anchor
// placement then continues the stale pendingPath (it's still non-null), and
// finishPath builds a path entity whose `anchors` array names a point id
// that no longer exists in the doc — a dangling reference. Without the fix
// (undo/redo now null pendingPath/pending/pathDrag/cursor, same as
// selectTool/cancelPath), this exact sequence produces a 'path' entity with
// 4 anchors, one of them dangling; with the fix, undo discards the pending
// draw entirely, so the single anchor placed afterward is too few to finish
// a path and finishPath(false) is a no-op.
test('path tool: undo mid-draw clears the pending path — no dangling-anchor corruption on finish', async ({ page }) => {
  await page.goto('/dev/sketch-draw'); await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    // place 3 anchors of ONE still-open path — none of these commits a
    // 'path' entity; they're pending anchors accumulating in pendingPath
    D.pathDown(1, 1); D.pathUp(1, 1)   // anchor 0
    D.pathDown(4, 1); D.pathUp(4, 1)   // anchor 1
    D.pathDown(4, 4); D.pathUp(4, 4)   // anchor 2
    const afterThree = D.entityCount()

    D.undo()                            // rewind mid-draw, past anchor 2's placement
    const afterUndo = D.entityCount()

    // "place a 4th anchor": with pendingPath cleared by the fix, this starts
    // a BRAND NEW path with just this one anchor — too few to finish. Under
    // the bug, it instead continues the stale 3-anchor pendingPath (whose
    // last anchor no longer exists post-undo), reaching 4 anchors — enough
    // for finishPath to build a corrupt path entity.
    D.pathDown(7, 7); D.pathUp(7, 7)
    const afterFourth = D.entityCount()

    D.finishPath(false)
    const status = D.status()
    const paths = D.doc.entities.filter((e: any) => e.kind === 'path')
    const pointIds = new Set(D.doc.entities.filter((e: any) => e.kind === 'point').map((e: any) => e.id))
    const danglingAnchors = paths.flatMap((p: any) => p.anchors).filter((id: string) => !pointIds.has(id))

    return { afterThree, afterUndo, afterFourth, status, pathCount: paths.length, danglingAnchors }
  })

  expect(out.afterThree).toBeGreaterThan(out.afterUndo)   // undo actually rewound the doc
  // the fix: undo cleared pendingPath, so the next single anchor placement
  // starts a fresh path (1 anchor) — too few for finishPath to build
  // anything at all, let alone a corrupt one
  expect(out.pathCount).toBe(0)
  expect(out.danglingAnchors).toEqual([])                 // no path anchor ever names a missing point
  expect(out.status).not.toMatch(/^NOT converged/)        // no corrupt path ever reached the solver
})

// M4 review Fix 2: commitHistory() used to push a snapshot on every settle,
// even when the action was a genuine no-op (Delete with an empty selection,
// dragging a fixed point, etc.) — a dead undo step that visibly "does
// nothing" the first time ⌘Z is pressed. Now it compares against the current
// top-of-history entry and skips the push when nothing changed.
test('commitHistory: a no-op action (Delete with empty selection) does not push a dead undo step', async ({ page }) => {
  await page.goto('/dev/sketch-draw'); await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(2, 2)
    const afterPlace = D.entityCount()

    D.clearSel()
    D.del()                             // selection is empty — must be a true no-op
    const afterNoopDelete = D.entityCount()

    D.undo()                            // a single undo must land straight on the empty doc —
    const afterOneUndo = D.entityCount() // NOT get stuck on a duplicate "afterNoopDelete" entry

    return { afterPlace, afterNoopDelete, afterOneUndo }
  })

  expect(out.afterPlace).toBe(1)
  expect(out.afterNoopDelete).toBe(1)   // nothing selected — nothing deleted
  expect(out.afterOneUndo).toBe(0)      // one undo fully reverts the point placement
})

test('select a point and nudge() moves it by a world delta; undo restores it', async ({ page }) => {
  await page.goto('/dev/sketch-draw'); await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(4, 4)
    const pt = D.doc.entities.find((e: any) => e.kind === 'point')
    const before = { x: pt.x, y: pt.y }

    D.clearSel(); D.pick(pt.id)
    D.nudge(1, 0)
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const after = { x: P(pt.id).x, y: P(pt.id).y }

    D.undo()
    const restored = { x: P(pt.id).x, y: P(pt.id).y }

    return { before, after, restored }
  })

  expect(out.after.x).toBeCloseTo(out.before.x + 1, 6)
  expect(out.after.y).toBeCloseTo(out.before.y, 6)
  expect(out.restored.x).toBeCloseTo(out.before.x, 6)
  expect(out.restored.y).toBeCloseTo(out.before.y, 6)
})

test('pan & zoom: viewport is view state — wheel zooms toward the cursor, panBy pans, fitView resets, undo never touches it', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  // Vue's DOM update from a doc/viewport mutation is async (flushed on
  // nextTick, a microtask) — each step below is its own page.evaluate
  // round-trip so that microtask queue drains before the next read, rather
  // than reading the DOM synchronously mid-script inside one giant evaluate.
  const screenPos = (id: string) => page.evaluate((pointId) => {
    const circle = document.querySelector(`circle[data-point="${pointId}"]`) as SVGCircleElement
    return { x: Number(circle.getAttribute('cx')), y: Number(circle.getAttribute('cy')) }
  }, id)

  const initial = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    return D.getViewport()
  })
  expect(initial).toEqual({ scale: 34, panX: 40, panY: 400 })

  // place a point at world (5,5) and read its screen position straight off
  // the rendered circle (the sx/sy the template actually used) — no local
  // reimplementation of the mapping.
  const ptId = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.setTool('point'); D.place(5, 5)
    D.setTool('select')
    return D.doc.entities.find((e: any) => e.kind === 'point').id
  })
  const before = await screenPos(ptId)

  // zoom by 2x centered exactly on the point's current screen position — the
  // world point under the zoom center must stay under the same pixel.
  const afterZoom = await page.evaluate(({ x, y }) => {
    const D = (window as any).__sketchDraw
    D.zoomAt(x, y, 2)
    return D.getViewport()
  }, before)
  expect(afterZoom.scale).toBeCloseTo(68, 5)
  const afterZoomPos = await screenPos(ptId)
  // the zoom center (the point's own screen pos) stays put within a couple px
  expect(Math.abs(afterZoomPos.x - before.x)).toBeLessThan(2)
  expect(Math.abs(afterZoomPos.y - before.y)).toBeLessThan(2)

  // pan by (50, 0) — panX shifts +50, and the point's screen x shifts +50
  const afterPan = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.panBy(50, 0)
    return D.getViewport()
  })
  expect(afterPan.panX).toBeCloseTo(afterZoom.panX + 50, 5)
  expect(afterPan.panY).toBeCloseTo(afterZoom.panY, 5)
  const afterPanPos = await screenPos(ptId)
  expect(afterPanPos.x).toBeCloseTo(afterZoomPos.x + 50, 1)
  expect(afterPanPos.y).toBeCloseTo(afterZoomPos.y, 1)

  // place a second point at a known world coord post-zoom/pan — drawing must
  // still land at the mapping's own sx/sy, not the stale defaults.
  const { pt2Id, expectedScreen } = await page.evaluate((firstPtId) => {
    const D = (window as any).__sketchDraw
    D.setTool('point'); D.place(2, 3)
    D.setTool('select')
    const pt2Id = D.doc.entities.filter((e: any) => e.kind === 'point').find((e: any) => e.id !== firstPtId).id
    const vp = D.getViewport()
    return { pt2Id, expectedScreen: { x: vp.panX + 2 * vp.scale, y: vp.panY - 3 * vp.scale } }
  }, ptId)
  const newPointPos = await screenPos(pt2Id)
  // drawing still correct post-zoom/pan: the new point lands exactly where
  // the current sx/sy mapping says it should
  expect(newPointPos.x).toBeCloseTo(expectedScreen.x, 1)
  expect(newPointPos.y).toBeCloseTo(expectedScreen.y, 1)

  // fit/reset back to defaults
  const afterFit = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.fitView()
    return D.getViewport()
  })
  expect(afterFit).toEqual({ scale: 34, panX: 40, panY: 400 })

  // undo must NEVER touch the viewport — zoom/pan is view state, not model.
  // Re-zoom, then undo() (there IS history from the two placed points), and
  // confirm the viewport is unchanged.
  const { beforeUndo, afterUndo } = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.zoomAt(300, 200, 1.5)
    const beforeUndo = D.getViewport()
    D.undo()
    const afterUndo = D.getViewport()
    return { beforeUndo, afterUndo }
  })
  expect(afterUndo).toEqual(beforeUndo)   // undo did NOT touch the viewport
})

test('editable dimension chips: pin an arc radius, drag holds it, re-edit updates in place, undo removes the pin', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  // same bow recipe as the "click-and-drag bows a segment into a circular
  // arc" test above — a single arc segment (segIndex 0) is enough to exercise
  // the chip; the handler resolves center/startAnchor from any segment index.
  const drawn = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(2, 2); D.pathUp(2, 2)          // first anchor, plain click
    D.pathDown(8, 2)                          // second anchor — appends a line segment
    D.pathMove(5, 4.5)                        // drag past the threshold → bows live
    D.pathUp(5, 4.5)                          // release → commits the arc
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const seg = path.segments[0]
    return { pathId: path.id, segIndex: 0, centerId: seg.center, startAnchorId: path.anchors[0] }
  })
  const { pathId, segIndex, centerId, startAnchorId } = drawn

  const radiusOf = () => page.evaluate(({ centerId, startAnchorId }) => {
    const d = (window as any).__sketchDraw.doc
    const P = (id: string) => d.entities.find((e: any) => e.id === id)
    const c = P(centerId), s = P(startAnchorId)
    return Math.hypot(c.x - s.x, c.y - s.y)
  }, { centerId, startAnchorId })

  const distanceConstraints = () => page.evaluate(() =>
    (window as any).__sketchDraw.doc.constraints.filter((c: any) => c.kind === 'distance'))

  expect((await distanceConstraints()).length).toBe(0)   // no pin before the first edit

  // pin the radius to 4 via the same code path a chip click uses
  await page.evaluate(({ pathId, segIndex }) => (window as any).__sketchDraw.setArcRadius(pathId, segIndex, 4), { pathId, segIndex })
  let pins = await distanceConstraints()
  expect(pins.length).toBe(1)
  expect(pins[0].value).toBe(4)
  expect([pins[0].refs[0], pins[0].refs[1]].sort()).toEqual([centerId, startAnchorId].sort())
  expect(await radiusOf()).toBeCloseTo(4, 1)
  const pinId = pins[0].id

  // drag the start anchor a bit — the pinned radius must hold
  await page.evaluate(({ startAnchorId }) => (window as any).__sketchDraw.drag(startAnchorId, 2.5, 2.8), { startAnchorId })
  expect(await radiusOf()).toBeCloseTo(4, 1)

  // edit the SAME chip again to 2 — updates the existing constraint in place,
  // never stacks a duplicate
  await page.evaluate(({ pathId, segIndex }) => (window as any).__sketchDraw.setArcRadius(pathId, segIndex, 2), { pathId, segIndex })
  pins = await distanceConstraints()
  expect(pins.length).toBe(1)
  expect(pins[0].id).toBe(pinId)
  expect(pins[0].value).toBe(2)
  expect(await radiusOf()).toBeCloseTo(2, 1)

  // undo back past the update, the drag, and the first pin — the constraint
  // itself must disappear (radius no longer forced)
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.undo(); D.undo(); D.undo()
  })
  expect((await distanceConstraints()).length).toBe(0)
})

test('editable dimension chips: setConstraintValue updates an existing distance constraint in place', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const info = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(1, 1); D.place(5, 1)
    D.setTool('select')
    const pts = D.doc.entities.filter((e: any) => e.kind === 'point')
    D.pick(pts[0].id); D.pick(pts[1].id, true)
    D.apply('distance', 3)
    const con = D.doc.constraints.find((c: any) => c.kind === 'distance')
    return { conId: con.id, p1: pts[0].id, p2: pts[1].id }
  })

  const distOf = () => page.evaluate(({ p1, p2 }) => {
    const d = (window as any).__sketchDraw.doc
    const P = (id: string) => d.entities.find((e: any) => e.id === id)
    const a = P(p1), b = P(p2)
    return Math.hypot(a.x - b.x, a.y - b.y)
  }, { p1: info.p1, p2: info.p2 })

  expect(await distOf()).toBeCloseTo(3, 1)

  await page.evaluate((conId) => (window as any).__sketchDraw.setConstraintValue(conId, 7), info.conId)
  const con = await page.evaluate((conId) =>
    (window as any).__sketchDraw.doc.constraints.find((c: any) => c.id === conId), info.conId)
  expect(con.value).toBe(7)
  expect(await distOf()).toBeCloseTo(7, 1)
})

test('select tool: marquee box-select, click-empty-deselect, plain-click-replaces, shift-click-adds', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point')
    D.place(2, 2)
    D.place(5, 5)
    D.place(9, 9)
    D.setTool('select')
    const pts = D.doc.entities.filter((e: any) => e.kind === 'point')
    return { a: pts[0].id, b: pts[1].id, c: pts[2].id }
  })

  // marqueeSelect a world rect covering exactly (2,2) and (5,5), missing (9,9)
  const marqueeSel = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.marqueeSelect(1, 1, 6, 6)
    return D.selection as string[]
  })
  expect(new Set(marqueeSel)).toEqual(new Set([ids.a, ids.b]))
  expect(marqueeSel.length).toBe(2)

  // clearSel resets to empty
  const afterClear = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.clearSel()
    return D.selection as string[]
  })
  expect(afterClear).toEqual([])

  // plain pick(a) then shift-add pick(b, true) → both selected
  const shiftAdd = await page.evaluate((ids) => {
    const D = (window as any).__sketchDraw
    D.pick(ids.a)
    D.pick(ids.b, true)
    return D.selection as string[]
  }, ids)
  expect(new Set(shiftAdd)).toEqual(new Set([ids.a, ids.b]))
  expect(shiftAdd.length).toBe(2)

  // plain (non-additive) pick(c) replaces the whole selection with just c
  const replaced = await page.evaluate((ids) => {
    const D = (window as any).__sketchDraw
    D.pick(ids.c)
    return D.selection as string[]
  }, ids)
  expect(replaced).toEqual([ids.c])

  // shift-marquee ADDS to the existing selection instead of replacing it
  const shiftMarquee = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    // rect covering only (2,2) — c ((9,9)) stays selected from the prior step
    D.marqueeSelect(1, 1, 3, 3, true)
    return D.selection as string[]
  })
  expect(new Set(shiftMarquee)).toEqual(new Set([ids.a, ids.c]))
  expect(shiftMarquee.length).toBe(2)

  // a non-additive marquee over empty space replaces selection with nothing
  const emptyMarquee = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.marqueeSelect(20, 20, 25, 25)
    return D.selection as string[]
  })
  expect(emptyMarquee).toEqual([])
})

test('select a point + a line and apply Midpoint via the API; holds under dragging a line endpoint', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(4, 8)                 // the point to pin to the midpoint
    D.setTool('line'); D.place(0, 0); D.place(10, 2)   // the line/segment

    const pt = D.doc.entities.find((e: any) => e.kind === 'point')
    const line = D.doc.entities.find((e: any) => e.kind === 'line')
    D.clearSel(); D.pick(pt.id); D.pick(line.id, true)
    const verbs = D.availableConstraints().map((v: any) => v.kind)

    D.apply('midpoint')

    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a = P(line.p1), b = P(line.p2), p = P(pt.id)
    const err0 = Math.hypot(p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2)

    // drag one endpoint of the line — the midpoint constraint must hold
    D.drag(line.p2, 12, 8)
    const a2 = P(line.p1), b2 = P(line.p2), p2 = P(pt.id)
    const err1 = Math.hypot(p2.x - (a2.x + b2.x) / 2, p2.y - (a2.y + b2.y) / 2)

    return { verbs, err0, err1, status: D.status() }
  })

  expect(out.verbs).toContain('midpoint')
  expect(out.status).toMatch(/^solved/)
  expect(out.err0).toBeLessThan(0.01)   // within 1e-2 right after applying
  expect(out.err1).toBeLessThan(0.01)   // still holds after the drag
})

test('draw two circles of different radius, select both, apply Equal via the API', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('circle'); D.place(3, 5); D.place(3, 8)      // circle A, center (3,5), r=3
    D.setTool('circle'); D.place(12, 5); D.place(12, 6.5)  // circle B, center (12,5), r=1.5

    const circles = D.doc.entities.filter((e: any) => e.kind === 'circle')
    D.clearSel(); D.pick(circles[0].id); D.pick(circles[1].id, true)
    const verbs = D.availableConstraints().map((v: any) => v.kind)

    D.apply('equalRadius')

    const cs = D.doc.entities.filter((e: any) => e.kind === 'circle')
    return { verbs, radii: cs.map((c: any) => c.r), status: D.status() }
  })

  expect(out.verbs).toContain('equalRadius')
  expect(out.status).toMatch(/^solved/)
  expect(Math.abs(out.radii[0] - out.radii[1])).toBeLessThan(0.01)
})

test('removeConstraintById drops a tangent-joint perpendicular constraint; solve still converges; undo restores it', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    // same line→arc tangent-joint draw as the "tangent joint" test above —
    // a horizontal line a→J, then an arc bowed near-tangent off J, which
    // captures a 'perpendicular' constraint at the joint (see that test's
    // comment for why the bow pointer lands at 8.2,5)
    D.pathDown(1, 3); D.pathUp(1, 3)
    D.pathDown(6, 3); D.pathUp(6, 3)              // J = (6,3), segment 0 = line
    D.pathDown(6, 7)                               // Pnew above
    D.pathMove(8.2, 5)                             // near-tangent bulge
    D.pathUp(8.2, 5)
    D.finishPath(false)

    const consBefore = D.constraintCount()
    const perp = D.doc.constraints.find((c: any) => c.kind === 'perpendicular')

    D.removeConstraintById(perp.id)
    const consAfterRemove = D.constraintCount()
    const goneAfterRemove = !D.doc.constraints.some((c: any) => c.id === perp.id)
    const statusAfterRemove = D.status()

    D.undo()
    const consAfterUndo = D.constraintCount()
    const restored = D.doc.constraints.find((c: any) => c.id === perp.id)

    return {
      hadPerpBefore: !!perp, consBefore, consAfterRemove, goneAfterRemove, statusAfterRemove,
      consAfterUndo, restoredBack: !!restored, restoredKind: restored?.kind,
    }
  })

  expect(out.hadPerpBefore).toBe(true)                      // tangent joint captured a perpendicular
  expect(out.consAfterRemove).toBe(out.consBefore - 1)       // exactly one constraint removed
  expect(out.goneAfterRemove).toBe(true)
  expect(out.statusAfterRemove).toMatch(/^solved/)           // solving still converges without it
  expect(out.consAfterUndo).toBe(out.consBefore)             // undo restores the count
  expect(out.restoredBack).toBe(true)
  expect(out.restoredKind).toBe('perpendicular')
})

test('live click: a glyph-only badge is removed by a plain click; a value chip needs shift+click to remove (plain click edits)', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const info = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // a distance constraint (value chip, m.text set) between two points
    D.setTool('point'); D.place(1, 1); D.place(5, 1)
    D.setTool('select')
    const pts = D.doc.entities.filter((e: any) => e.kind === 'point')
    D.pick(pts[0].id); D.pick(pts[1].id, true)
    D.apply('distance', 4)

    // a horizontal constraint on a line (glyph-only badge, no value)
    D.setTool('line'); D.place(1, 4); D.place(4, 6)
    const line = D.doc.entities.find((e: any) => e.kind === 'line')
    D.setTool('select'); D.clearSel(); D.pick(line.id)
    D.apply('horizontal')

    const dist = D.doc.constraints.find((c: any) => c.kind === 'distance')
    const horiz = D.doc.constraints.find((c: any) => c.kind === 'horizontal')
    return { distId: dist.id, horizId: horiz.id, consBefore: D.constraintCount() }
  })

  const cons = () => page.evaluate(() => (window as any).__sketchDraw.doc.constraints)

  // plain click on the glyph-only (horizontal) badge removes it
  const horizBadge = page.locator(`[data-constraint="${info.horizId}"]`)
  await expect(horizBadge).toBeVisible()
  await horizBadge.click()
  let after = await cons()
  expect(after.some((c: any) => c.id === info.horizId)).toBe(false)
  expect(after.length).toBe(info.consBefore - 1)

  // plain click on the value (distance) chip edits — window.prompt is
  // auto-dismissed by Playwright (cancel), so the value is untouched, but
  // critically the constraint itself is NOT removed
  const distBadge = page.locator(`[data-constraint="${info.distId}"]`)
  await expect(distBadge).toBeVisible()
  await distBadge.click()
  after = await cons()
  expect(after.some((c: any) => c.id === info.distId)).toBe(true)

  // shift+click on the same value chip removes it
  await distBadge.click({ modifiers: ['Shift'] })
  after = await cons()
  expect(after.some((c: any) => c.id === info.distId)).toBe(false)
})

test('Escape aborts a live marquee drag: clears it without deselecting or touching the doc', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(2, 2)
    D.setTool('select')
    const pt = D.doc.entities.find((e: any) => e.kind === 'point')
    D.pick(pt.id)   // pre-select, so we can prove Escape doesn't clear it
  })

  const svg = page.locator('svg[width="680"][height="460"]')   // the sketch canvas — Nuxt DevTools/overlays add other <svg>s
  const box = await svg.boundingBox()
  if (!box) throw new Error('svg bounding box not found')
  // start well away from the point at (2,2) (screen ≈ 108,332) so the
  // pointerdown lands on empty canvas and starts a marquee candidate
  const startX = box.x + 500, startY = box.y + 60

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 120, startY + 90, { steps: 5 })   // past the 3px threshold

  await expect(page.locator('[data-marquee]')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('[data-marquee]')).toHaveCount(0)   // gesture aborted

  await page.mouse.up()   // release off-gesture must be a true no-op now

  const result = await page.evaluate(() => ({
    sel: (window as any).__sketchDraw.selection,
    ents: (window as any).__sketchDraw.entityCount(),
  }))
  expect(result.sel.length).toBe(1)   // pre-existing selection survived
  expect(result.ents).toBe(1)         // no stray marquee-select mutation
})

test('segment selection: pick 2 line segments on a bent path, apply Perpendicular via the API', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // a bent path — 3 anchors, 2 line segments, an arbitrary non-90 corner
    // angle. pathDown/pathUp with no move in between keeps both segments
    // straight lines (no bow past the drag threshold) — same recipe as the
    // corner "Right angle" test above.
    D.setTool('path')
    D.pathDown(1, 1); D.pathUp(1, 1)      // a0
    D.pathDown(5, 1); D.pathUp(5, 1)      // a1 — corner
    D.pathDown(7, 5); D.pathUp(7, 5)      // a2
    D.finishPath(false)

    const path = D.doc.entities.find((e: any) => e.kind === 'path')

    D.setTool('select')
    D.pickSegment(path.id, 0)
    D.pickSegment(path.id, 1, true)
    const segsAfterPick = D.selectedSegments
    const entitySelAfterPick = D.selection
    const verbs = D.availableConstraints().map((v: any) => v.kind)

    D.apply('perpendicular')

    const segsAfterApply = D.selectedSegments   // apply() clears segment selection
    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a0 = P(path.anchors[0]), a1 = P(path.anchors[1]), a2 = P(path.anchors[2])
    const u = { x: a1.x - a0.x, y: a1.y - a0.y }
    const v = { x: a2.x - a1.x, y: a2.y - a1.y }
    const dot = u.x * v.x + u.y * v.y

    return { segsAfterPick, entitySelAfterPick, verbs, segsAfterApply, status: D.status(), dot }
  })

  expect(out.segsAfterPick.length).toBe(2)              // both segments selected
  expect(out.entitySelAfterPick).toEqual([])             // mutually exclusive with entity selection
  expect(out.verbs).toContain('perpendicular')
  expect(out.verbs).toContain('parallel')
  expect(out.verbs).toContain('equalDist')
  expect(out.segsAfterApply).toEqual([])                 // apply cleared the segment selection
  expect(out.status).toMatch(/^solved/)
  expect(Math.abs(out.dot)).toBeLessThan(0.01)           // the two segments are now orthogonal
})

test('segment selection: pick a single line segment, apply Horizontal via the API', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // a single line segment at an arbitrary (non-horizontal) angle
    D.setTool('path')
    D.pathDown(1, 2); D.pathUp(1, 2)      // a0
    D.pathDown(6, 5); D.pathUp(6, 5)      // a1
    D.finishPath(false)

    const path = D.doc.entities.find((e: any) => e.kind === 'path')

    D.setTool('select')
    D.pickSegment(path.id, 0)
    const segs = D.selectedSegments
    const verbs = D.availableConstraints().map((v: any) => v.kind)

    D.apply('horizontal')

    const P = (id: string) => D.doc.entities.find((e: any) => e.id === id)
    const a0 = P(path.anchors[0]), a1 = P(path.anchors[1])

    return { segs, verbs, status: D.status(), dy: Math.abs(a1.y - a0.y) }
  })

  expect(out.segs).toEqual([{ pathId: expect.any(String), segIndex: 0 }])
  expect(out.verbs).toContain('horizontal')
  expect(out.verbs).toContain('vertical')
  expect(out.status).toMatch(/^solved/)
  expect(out.dy).toBeLessThan(0.01)   // the segment's two anchors now share y
})

test('path-body click selects the WHOLE path; Alt+click drills into one segment', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    // a diagonal first segment (neither axis-aligned) — a perfectly
    // horizontal/vertical hit-path can end up with a zero-height/width
    // client rect, which Playwright's actionability check treats as "not
    // visible" and never clicks; a diagonal segment always has a real 2D box.
    D.pathDown(1, 1); D.pathUp(1, 1)
    D.pathDown(5, 4); D.pathUp(5, 4)
    D.pathDown(8, 1); D.pathUp(8, 1)
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    D.setTool('select')
    D.clearSel()
    return { pathId: path.id }
  })

  const seg0 = page.locator(`[data-seg="${ids.pathId}:0"]`)
  await expect(seg0).toHaveCount(1)

  // plain click on a path segment now selects the WHOLE path (the intuitive
  // "click the shape, select the shape" — what Repeat/Mirror/Delete need).
  await seg0.click()
  const plain = await page.evaluate(() => ({
    segs: (window as any).__sketchDraw.selectedSegments,
    sel: (window as any).__sketchDraw.selection,
  }))
  expect(plain.sel).toEqual([ids.pathId])
  expect(plain.segs).toEqual([])
  await expect(page.locator('[data-seg-selected]')).toHaveCount(0)

  // Alt+click drills into the single segment under the cursor (segment verbs),
  // clearing the whole-path selection.
  await seg0.click({ modifiers: ['Alt'] })
  const alt = await page.evaluate(() => ({
    segs: (window as any).__sketchDraw.selectedSegments,
    sel: (window as any).__sketchDraw.selection,
  }))
  expect(alt.segs).toEqual([{ pathId: ids.pathId, segIndex: 0 }])
  expect(alt.sel).toEqual([])   // whole-path selection cleared by the segment pick
  await expect(page.locator('[data-seg-selected]')).toHaveCount(1)
})

test('guided Repeat: arm via Repeat verb, then a center-point click builds the ring', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('point'); D.place(11, 6)
    const center = D.doc.entities.find((e: any) => e.kind === 'point').id
    D.doc.entities.find((e: any) => e.id === center).fixed = true
    D.setTool('path'); D.place(11, 2); D.place(11, 4); D.place(13, 5); D.finishPath(false)
    const unit = D.doc.entities.find((e: any) => e.kind === 'path').id
    D.setTool('select')
    D.pick(unit)          // whole-path selection, as a real click now gives
    D.armRepeat(8)        // = clicking "Repeat…" and entering a count of 8
    return { center, unit, armed: D.pendingOp() }
  })
  expect(ids.armed).toEqual({ kind: 'repeat', units: [ids.unit] })

  // the hint banner is shown while armed
  await expect(page.locator('[data-op-hint]')).toHaveCount(1)

  // clicking the center point resolves the armed op into a ring of 8
  await page.locator(`[data-point="${ids.center}"]`).click()
  const out = await page.evaluate(() => ({
    paths: (window as any).__sketchDraw.doc.entities.filter((e: any) => e.kind === 'path').length,
    pendingOp: (window as any).__sketchDraw.pendingOp(),
  }))
  expect(out.paths).toBe(8)
  expect(out.pendingOp).toBeNull()
  await expect(page.locator('[data-op-hint]')).toHaveCount(0)
})

test('segment verbs: reject arc segments at the mutation layer (no constraint added)', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // draw a path with a line segment and an arc segment
    D.setTool('path')
    D.place(2, 2); D.place(4, 4)                     // line segment (seg 0)
    D.setNextSegment('arc'); D.place(7, 5)            // arc segment (seg 1)
    D.finishPath(false)

    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    const initialConstraintCount = D.constraintCount()

    D.setTool('select')
    // pick the arc segment (segIndex 1)
    D.pickSegment(path.id, 1)
    const selectedSegs = D.selectedSegments

    // try to apply horizontal to the arc — should be rejected at the mutation layer
    D.apply('horizontal')

    const finalConstraintCount = D.constraintCount()

    return {
      selectedSegs,
      initialConstraintCount,
      finalConstraintCount,
      constraintsUnchanged: initialConstraintCount === finalConstraintCount,
      status: D.status(),
    }
  })

  // verify: the arc segment was selected
  expect(out.selectedSegs).toEqual([{ pathId: expect.any(String), segIndex: 1 }])
  // verify: no constraint was added (mutation was rejected)
  expect(out.constraintsUnchanged).toBe(true)
  expect(out.finalConstraintCount).toEqual(out.initialConstraintCount)
  // verify: the solver still converged (no malformed state left behind)
  expect(out.status).toMatch(/^solved/)
})

test('Escape aborts a live pan: ends the pan without moving the viewport further', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  await page.evaluate(() => (window as any).__sketchDraw.reset())

  const svg = page.locator('svg[width="680"][height="460"]')   // the sketch canvas — Nuxt DevTools/overlays add other <svg>s
  const box = await svg.boundingBox()
  if (!box) throw new Error('svg bounding box not found')
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2

  const initial = await page.evaluate(() => (window as any).__sketchDraw.getViewport())

  await page.keyboard.down('Space')
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy + 40, { steps: 5 })   // pan in progress

  const during = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  expect(during).not.toEqual(initial)   // the pan actually moved the viewport

  await page.keyboard.press('Escape')
  const afterEscape = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  expect(afterEscape).toEqual(during)   // Escape itself didn't move the viewport, just ended the gesture

  await page.mouse.move(cx + 200, cy + 200, { steps: 5 })   // further drag must NOT pan anymore
  const afterMove = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  expect(afterMove).toEqual(during)

  await page.mouse.up()
  await page.keyboard.up('Space')
})

test('Guide mode places construction geometry; guide points stay snap targets; guides are excluded from Copy-SVG', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const info = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()

    // guide mode ON: the Circle tool places construction geometry directly —
    // center (5,5), radius click at (5,8) → r=3
    D.setGuideMode(true)
    D.setTool('circle'); D.place(5, 5); D.place(5, 8)
    const guideCircle = D.doc.entities.find((e: any) => e.kind === 'circle')

    // guide mode OFF: draw a real path whose first anchor lands right on the
    // guide circle's circumference — the rightmost point, (8,5) — close
    // enough (within snapPoint's default 0.6 tolerance) to trigger a
    // pointOnCircle snap against the guide, proving guides stay full snap
    // targets even though they never touch Copy-SVG.
    D.setGuideMode(false)
    D.setTool('path')
    D.place(7.9, 5)
    D.place(10, 8)
    D.finishPath(false)

    const pointOnCircle = D.doc.constraints.find((c: any) => c.kind === 'pointOnCircle' && c.refs.includes(guideCircle.id))
    const svg = D.copySvg()
    // the guide circle's own exported arc fragment (see sketchPath.ts's
    // circle formula: center (5,5) r=3 → left point (2,5), right point (8,5))
    const guideArcFragment = 'M 2 5 A 3 3 0 0 1 8 5 A 3 3 0 0 1 2 5 Z'

    return {
      guideCircleConstruction: !!guideCircle?.construction,
      guideModeAfter: D.guideMode,
      pointOnCircleTarget: pointOnCircle ? pointOnCircle.refs[1] : null,
      guideCircleId: guideCircle.id,
      svgIncludesGuideArc: svg.includes(guideArcFragment),
      svgIncludesAnyArc: svg.includes(' A '),
      svgLength: svg.length,
    }
  })

  // guide-mode-drawn geometry is construction
  expect(info.guideCircleConstruction).toBe(true)
  expect(info.guideModeAfter).toBe(false)
  // the path anchor's pointOnCircle constraint was captured against the guide
  expect(info.pointOnCircleTarget).toBe(info.guideCircleId)
  // Copy-SVG excludes the guide: no arc commands survive (the guide circle
  // was the only arc geometry on the board) and the fragment itself is absent
  expect(info.svgIncludesAnyArc).toBe(false)
  expect(info.svgIncludesGuideArc).toBe(false)
  // ...while the real (non-guide) path still exports
  expect(info.svgLength).toBeGreaterThan(0)
})

test('type-a-dimension: LINE — typed value sets the exact segment length, pinned by a distance constraint', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const info = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(2, 2); D.pathUp(2, 2)   // first anchor — a plain click, no bow
    const startId = D.doc.entities.find((e: any) => e.kind === 'point').id
    D.pathMove(2, 10)                 // live cursor sets the next segment's direction (straight up)

    D.typeDimension('5')
    const bufferWhileTyping = D.dimBuffer
    D.commitDimension()
    const bufferAfter = D.dimBuffer
    D.finishPath(false)

    const d = D.doc
    const pts = d.entities.filter((e: any) => e.kind === 'point')
    // identify the two anchors by id (captured before the solve moves anything)
    // rather than by position — commitDimension's solve is free to redistribute
    // the pinned distance across BOTH endpoints, so a post-solve position match
    // on the start anchor would be flaky.
    const start = pts.find((p: any) => p.id === startId)
    const distCon = d.constraints.find((c: any) => c.kind === 'distance' && c.refs.includes(startId))
    const endId = distCon ? distCon.refs.find((id: string) => id !== startId) : null
    const end = pts.find((p: any) => p.id === endId)
    const length = start && end ? Math.hypot(end.x - start.x, end.y - start.y) : null

    return {
      bufferWhileTyping, bufferAfter, pointCount: pts.length,
      hasPin: !!distCon, pinnedValue: distCon?.value, length, status: D.status(),
    }
  })

  expect(info.bufferWhileTyping).toBe('5')   // chip shows the typed value while composing
  expect(info.bufferAfter).toBe('')          // commit clears the buffer
  expect(info.pointCount).toBe(2)            // just the two anchors — no extra geometry
  expect(info.hasPin).toBe(true)             // a distance constraint pins the two anchors
  expect(info.pinnedValue).toBeCloseTo(5, 5)
  expect(info.length).toBeCloseTo(5, 2)      // the placed segment's ACTUAL length matches
  expect(info.status).toMatch(/^solved/)
})

test('type-a-dimension: ARC — typed value sets the exact radius, pinned by distance[center, startAnchor]', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const info = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(0, 0)     // first anchor
    D.pathDown(4, 0)     // second anchor — starts a line segment + the drag gesture
    D.pathMove(2, 2)     // past the bow threshold from (4,0) → pathDrag.bowed becomes true
    const startId = D.doc.entities.find((e: any) => Math.abs(e.x - 0) < 1e-6 && Math.abs(e.y - 0) < 1e-6 && e.kind === 'point').id

    D.typeDimension('3')
    const bufferWhileTyping = D.dimBuffer
    D.commitDimension()
    const bufferAfter = D.dimBuffer

    const d = D.doc
    const pts = d.entities.filter((e: any) => e.kind === 'point')
    const start = pts.find((p: any) => p.id === startId)
    const distCon = d.constraints.find((c: any) => c.kind === 'distance' && c.refs.includes(startId))
    const centerId = distCon ? distCon.refs.find((id: string) => id !== startId) : null
    const center = pts.find((p: any) => p.id === centerId)
    const radius = center && start ? Math.hypot(center.x - start.x, center.y - start.y) : null

    return {
      bufferWhileTyping, bufferAfter, pointCount: pts.length,
      hasPin: !!distCon, pinnedValue: distCon?.value, radius, status: D.status(),
    }
  })

  expect(info.bufferWhileTyping).toBe('3')
  expect(info.bufferAfter).toBe('')
  expect(info.pointCount).toBe(3)            // start anchor, end anchor, arc center
  expect(info.hasPin).toBe(true)             // distance[center, startAnchor] pins the radius
  expect(info.pinnedValue).toBeCloseTo(3, 5)
  expect(info.radius).toBeCloseTo(3, 2)      // ACTUAL dist(center, startAnchor) matches — the codebase's own radius definition (see sketchPath.ts pathD)
  expect(info.status).toMatch(/^solved/)
})

test('sparkle: spawns via the API and is active immediately, prunes to 0 after its lifetime', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const immediate = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.sparkle(5, 5)
    return D.sparkleCount()
  })
  expect(immediate).toBeGreaterThanOrEqual(1)

  // timing-lenient: don't assert exact frame counts, just that the rAF prune
  // loop has retired it well past its ~380ms lifetime.
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => (window as any).__sketchDraw.sparkleCount())
  expect(after).toBe(0)
})

test('sparkle: a tangent-joint capture (bowing an arc onto a line) spawns one', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const hasSparkle = await page.evaluate(async () => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    // same line→arc tangent-joint draw as the "tangent joint" test above —
    // a horizontal line a→J, then an arc bowed near-tangent off J.
    D.pathDown(1, 3); D.pathUp(1, 3)
    D.pathDown(6, 3); D.pathUp(6, 3)              // J = (6,3), segment 0 = line
    D.pathDown(6, 7)                               // Pnew above
    D.pathMove(8.2, 5)                             // near-tangent bulge
    D.pathUp(8.2, 5)                               // tangent-joint commit — should sparkle at J
    // poll for a short window rather than asserting exact frame timing
    const deadline = performance.now() + 300
    while (performance.now() < deadline) {
      if (D.sparkleCount() > 0) return true
      await new Promise(r => setTimeout(r, 10))
    }
    return D.sparkleCount() > 0
  })
  expect(hasSparkle).toBe(true)
})

// M5 final integration review Fix 2: selectTool() used to leave a stale
// entity selection alive when switching from 'select' to a draw tool — the
// verb bar, arrow-nudge, and Backspace-delete all read `selection`, so e.g.
// switching to the path tool with two lines still selected left
// 'Perpendicular' available and applicable mid-draw. selectTool() now clears
// both selection channels on any switch AWAY from 'select', but leaves them
// alone when switching INTO 'select' (a live selection right after entering
// select mode is expected, exercised by the tests above that pick
// immediately after `D.setTool('select')`).
test('selectTool: switching from select to a draw tool clears a stale entity selection', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('line'); D.place(1, 1); D.place(5, 1)     // line A
    D.setTool('line'); D.place(1, 4); D.place(5, 6)      // line B
    D.setTool('select')
    const lines = D.doc.entities.filter((e: any) => e.kind === 'line')
    D.pick(lines[0].id); D.pick(lines[1].id, true)
    const selBeforeSwitch = D.selection
    const verbsBeforeSwitch = D.availableConstraints().map((v: any) => v.kind)

    D.setTool('point')                                    // switch to a draw tool
    const selAfterSwitch = D.selection
    const verbsAfterSwitch = D.availableConstraints().map((v: any) => v.kind)

    return { selBeforeSwitch, verbsBeforeSwitch, selAfterSwitch, verbsAfterSwitch }
  })

  expect(out.selBeforeSwitch.length).toBe(2)
  expect(out.verbsBeforeSwitch).toContain('perpendicular')   // stale-selection verb was available pre-fix
  expect(out.selAfterSwitch).toEqual([])                     // selection cleared on tool switch
  expect(out.verbsAfterSwitch).toEqual([])                   // no verbs apply to an empty selection
})

// same fix, segment-selection channel: switching away from 'select' with a
// live segment pick (mutually exclusive with entity `selection`, see
// pickSegment()) must clear `selectedSegments` too, or the same stale-verb
// problem shows up for segment-selected constraints instead.
test('selectTool: switching from select to a draw tool clears a stale segment selection', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  const out = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    D.pathDown(1, 1); D.pathUp(1, 1)      // a0
    D.pathDown(5, 1); D.pathUp(5, 1)      // a1 — corner
    D.pathDown(7, 5); D.pathUp(7, 5)      // a2
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')

    D.setTool('select')
    D.pickSegment(path.id, 0)
    D.pickSegment(path.id, 1, true)
    const segsBeforeSwitch = D.selectedSegments

    D.setTool('circle')                                    // switch to a draw tool
    const segsAfterSwitch = D.selectedSegments

    return { segsBeforeSwitch, segsAfterSwitch }
  })

  expect(out.segsBeforeSwitch.length).toBe(2)
  expect(out.segsAfterSwitch).toEqual([])
})

// badge declutter (M-declutter): STRUCTURAL/auto constraint kinds
// (rotatedFrom from Repeat, equalDist auto-added for the arc segment) must
// never render a badge — they're the bulk of the clutter on a many-petal
// drawing (a 24-petal mandala buries itself under hundreds of ↻/E badges) —
// while a genuine user-facing badge (Horizontal, applied to the unit's line
// segment here) still shows. The Labels toggle then hides EVERY chip layer
// (constraint badges + arc radius chips) at once, and restores them.
test('badge declutter: structural constraint kinds hidden; Labels toggle hides/restores all chips', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    // fixed center to repeat about
    D.setTool('point'); D.place(8, 6)
    const ctr = D.doc.entities.find((e: any) => e.kind === 'point').id
    D.doc.entities.find((e: any) => e.id === ctr).fixed = true
    // unit: line + arc via the path tool — the arc segment auto-adds an
    // equalDist constraint on commit (see edit.ts addPath)
    D.setTool('path')
    D.place(8, 1); D.place(8, 3)                // line segment
    D.setNextSegment('arc'); D.place(10.5, 4.5) // arc segment
    D.finishPath(false)
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    // give the unit's line segment a real, user-facing Horizontal badge
    D.pickSegment(path.id, 0)
    D.apply('horizontal')
    // repeat 4x about the center — each copy gets its own rotatedFrom
    // (structural) constraints, plus the copied Horizontal constraint
    D.repeat([path.id], ctr, 4)
  })

  // timing-lenient: query after a tick so the repeat's render has settled
  await page.waitForTimeout(50)

  // --- Labels ON (default) ---
  const kindsOn = await page.$$eval('[data-constraint-kind]', els => els.map(e => e.getAttribute('data-constraint-kind')))
  expect(kindsOn.length).toBeGreaterThan(0)
  expect(kindsOn).not.toContain('rotatedFrom')   // structural — hidden
  expect(kindsOn).not.toContain('equalDist')     // structural — hidden
  expect(kindsOn).toContain('horizontal')        // user-facing — still shown, on every copy

  const textsOn = await page.$$eval('svg text', els => els.map(e => e.textContent || ''))
  expect(textsOn.some(t => t.includes('↻'))).toBe(false)   // rotatedFrom's glyph never rendered

  // --- Labels OFF: no badge/chip renders at all ---
  await page.evaluate(() => (window as any).__sketchDraw.setShowLabels(false))
  await page.waitForTimeout(50)
  const badgesOff = await page.$$eval('svg g[data-constraint]', els => els.length)
  expect(badgesOff).toBe(0)
  const anyTextOff = await page.$$eval('svg text', els => els.length)
  expect(anyTextOff).toBe(0)   // no marks, no arc-radius chips — nothing at all

  // --- Labels back ON: badges return ---
  await page.evaluate(() => (window as any).__sketchDraw.setShowLabels(true))
  await page.waitForTimeout(50)
  const kindsRestored = await page.$$eval('[data-constraint-kind]', els => els.map(e => e.getAttribute('data-constraint-kind')))
  expect(kindsRestored).toContain('horizontal')
  expect(kindsRestored).not.toContain('rotatedFrom')
  expect(kindsRestored).not.toContain('equalDist')
})
