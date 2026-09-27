// tests/pen-tangent.spec.ts
// Pen stage 4 — tangency — with the REAL mouse on the pen dev page: a bowing
// arc snaps tangent to a line (chip at the touch point, rule on release); a
// line leaving an arc's end snaps onto its tangent; Tangent in the rules row
// on two Option-clicked segments, apart and joined; dragging an arc's bow in
// Select; ⌘-dragging an arc moves its centre. Every gesture is page.mouse /
// page.keyboard; __sketchDraw only sets drawings up and reads them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
// the dev page's default view: 34 px per unit, y up, origin at (40, 400)
const overlay = (page: Page) => page.locator('svg[width="680"][height="460"]')
async function screenOf(page: Page, x: number, y: number) {
  const box = (await overlay(page).boundingBox())!
  return { x: box.x + 40 + 34 * x, y: box.y + 400 - 34 * y }
}
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
// a point along a drawn segment (fraction f of its length), in client pixels
async function onSegment(page: Page, pathId: string, segIndex: number, f = 0.5) {
  return page.evaluate(({ pathId, segIndex, f }) => {
    const el = document.querySelector(`[data-seg="${pathId}:${segIndex}"]`) as SVGPathElement
    const p = el.getPointAtLength(el.getTotalLength() * f)
    const m = el.getScreenCTM()!
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
  }, { pathId, segIndex, f })
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const pt = (d: any, id: string) => d.entities.find((e: any) => e.id === id)

test('a bowing arc snaps tangent to a line, with a chip where it touches, and keeps the rule', async ({ page }) => {
  await open(page)
  const line = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('line'); D.place(2, 2); D.place(16, 2)
    D.setTool('path')
    const l = D.doc.entities.find((e: any) => e.kind === 'line')
    return { p1: l.p1 as string, p2: l.p2 as string }
  })
  const a = await screenOf(page, 6, 5)
  await page.mouse.click(a.x, a.y)
  const b = await screenOf(page, 12, 5)
  await page.mouse.move(b.x, b.y)
  await page.mouse.down()
  const bow = await screenOf(page, 9, 2.1)
  await page.mouse.move(bow.x, bow.y, { steps: 12 })
  await expect(page.locator('[data-bow-tangent]')).toBeVisible()
  await expect(page.locator('[data-bow-ghost][data-tangent]')).toHaveCount(1)
  await page.mouse.up()
  await expect(page.locator('[data-bow-tangent]')).toHaveCount(0)
  await page.evaluate(() => (window as any).__sketchDraw.finishPath(false))

  const d = await doc(page)
  const path = d.entities.find((e: any) => e.kind === 'path')
  const C = path.segments[0].center, S = path.anchors[0]
  const k = d.constraints.find((c: any) => c.kind === 'tangentLineArc')
  expect(k.refs).toEqual([line.p1, line.p2, C, S])
  const c = pt(d, C), s = pt(d, S), l1 = pt(d, line.p1), l2 = pt(d, line.p2)
  const lineDist = Math.abs((l2.x - l1.x) * (c.y - l1.y) - (l2.y - l1.y) * (c.x - l1.x)) / Math.hypot(l2.x - l1.x, l2.y - l1.y)
  expect(Math.abs(lineDist - Math.hypot(s.x - c.x, s.y - c.y))).toBeLessThan(1e-5)
})

test('a line leaving an arc’s end snaps onto its tangent and keeps the joint smooth', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6)            // arc centred (7,9), travelling ccw into (10,6)
    D.setNextSegment('line')
  })
  const near = await screenOf(page, 12.2, 8.05)
  await page.mouse.move(near.x - 20, near.y + 10)
  await page.mouse.move(near.x, near.y, { steps: 6 })
  await expect(page.locator('[data-tangent-chip]')).toBeVisible()
  await page.mouse.click(near.x, near.y)
  await page.evaluate(() => (window as any).__sketchDraw.finishPath(false))
  const d = await doc(page)
  const path = d.entities.find((e: any) => e.kind === 'path')
  const [, E, N] = path.anchors
  const C = path.segments[0].center
  expect(d.constraints.find((c: any) => c.kind === 'perpendicular').refs).toEqual([C, E, E, N])
  const c = pt(d, C), e = pt(d, E), n = pt(d, N)
  expect(Math.abs((e.x - c.x) * (n.x - e.x) + (e.y - c.y) * (n.y - e.y))).toBeLessThan(1e-5)
})

test('Tangent in the rules row: two segments apart, then a line and an arc that meet', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('line')
    D.place(3, 3); D.place(11, 3.4); D.finishPath(false)             // a line, not joined to the arc
    D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)               // an arc centred (7,9)
    D.setNextSegment('line')
    D.place(2, 9.5); D.place(5, 10.5)                                // a line then an arc that meet at (5,10.5)
    D.setNextSegment('arc'); D.place(9, 10.5); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('select')
    const [line, arc, joined] = D.doc.entities.filter((e: any) => e.kind === 'path')
    return { line: line.id as string, arc: arc.id as string, joined: joined.id as string }
  })
  const before = (await doc(page)).constraints.length

  // Option-click the line, Option-Shift-click the arc
  const p1 = await onSegment(page, ids.line, 0, 0.3)
  const p2 = await onSegment(page, ids.arc, 0)
  await page.keyboard.down('Alt')
  await page.mouse.click(p1.x, p1.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(p2.x, p2.y)
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
  const btn = page.locator('[data-verb="tangent"]')
  await expect(btn).toHaveText('Tangent')
  await btn.hover()
  await expect(page.locator('[data-pen-tip-id="tangent"]')).toBeVisible()
  await btn.click()
  let d = await doc(page)
  const k = d.constraints.find((c: any) => c.kind === 'tangentLineArc')
  expect(k).toBeTruthy()
  await expect(page.locator(`[data-constraint="${k.id}"]`)).toHaveAttribute('data-constraint-kind', 'tangentLineArc')
  const [A, B, C, S] = k.refs.map((id: string) => pt(d, id))
  const gap = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / Math.hypot(B.x - A.x, B.y - A.y) - Math.hypot(S.x - C.x, S.y - C.y)
  expect(Math.abs(gap)).toBeLessThan(1e-5)
  // one undo step takes it back
  await page.keyboard.press(`${META}+z`)
  expect((await doc(page)).constraints.length).toBe(before)

  // the joined pair: the joint rule, radius square to the line
  const q1 = await onSegment(page, ids.joined, 0)
  const q2 = await onSegment(page, ids.joined, 1)
  await page.keyboard.down('Alt')
  await page.mouse.click(q1.x, q1.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(q2.x, q2.y)
  await page.keyboard.up('Shift')
  await page.keyboard.up('Alt')
  await page.locator('[data-verb="tangent"]').click()
  d = await doc(page)
  const joined = d.entities.find((e: any) => e.id === ids.joined)
  const [P0, J] = joined.anchors
  const Cj = joined.segments[1].center
  expect(d.constraints.find((c: any) => c.kind === 'perpendicular' && c.refs[1] === J).refs).toEqual([P0, J, J, Cj])
})

test('dragging an arc’s bow in Select resizes it, ends held, in one undo step', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('select')
    const p = D.doc.entities.find((e: any) => e.kind === 'path')
    return { path: p.id as string, A: p.anchors[0] as string, B: p.anchors[1] as string, C: p.segments[0].center as string }
  })
  const before = await doc(page)
  const grab = await onSegment(page, ids.path, 0)
  const to = await screenOf(page, 7, 3.5)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
  const d = await doc(page)
  expect(d.entities.length).toBe(before.entities.length)
  expect(d.constraints.length).toBe(before.constraints.length)
  expect(pt(d, ids.A)).toMatchObject({ x: pt(before, ids.A).x, y: pt(before, ids.A).y })
  expect(pt(d, ids.B)).toMatchObject({ x: pt(before, ids.B).x, y: pt(before, ids.B).y })
  expect(pt(d, ids.C).y).toBeGreaterThan(6.4)
  expect(pt(d, ids.C).y).toBeLessThan(6.7)
  await page.keyboard.press(`${META}+z`)
  expect(pt(await doc(page), ids.C).y).toBeCloseTo(9, 6)
})

test('⌘-dragging an arc moves its centre', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('select')
    const p = D.doc.entities.find((e: any) => e.kind === 'path')
    return { path: p.id as string, C: p.segments[0].center as string }
  })
  const count = (await doc(page)).entities.length
  const grab = await onSegment(page, ids.path, 0)
  await page.keyboard.down(META)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 34, grab.y - 34, { steps: 10 })   // +1, +1 in drawing units
  await page.mouse.up()
  await page.keyboard.up(META)
  const d = await doc(page)
  expect(d.entities.length).toBe(count)
  expect(pt(d, ids.C).x).toBeCloseTo(8, 1)
  expect(pt(d, ids.C).y).toBeCloseTo(10, 1)
})
