// tests/pen-weld.spec.ts
// Joining by dragging in the Select tool, with the REAL mouse on the pen dev
// page: an open path's end dropped onto its start closes the path; an end
// dropped onto an arc is pinned there (equalDist) with the on-curve chip
// showing during the drag; ⌘ / Ctrl held moves without joining.
import { test, expect, type Page } from '@playwright/test'

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
// an open four-anchor Pen path (2,2) → (8,2) → (8,8) → (3,7), back in Select
async function openPath(page: Page) {
  return page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('line')
    D.place(2, 2); D.place(8, 2); D.place(8, 8); D.place(3, 7); D.finishPath(false)
    D.setTool('select')
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    return { anchors: path.anchors as string[], closed: path.closed as boolean }
  })
}
async function pathsNow(page: Page) {
  return page.evaluate(() => (window as any).__sketchDraw.doc.entities
    .filter((e: any) => e.kind === 'path').map((e: any) => ({ anchors: e.anchors.slice(), closed: e.closed })))
}

test('dragging an open path’s end onto its start closes it into one path', async ({ page }) => {
  await open(page)
  const built = await openPath(page)
  expect(built.closed).toBe(false)
  const from = await screenOf(page, 3, 7)
  const to = await screenOf(page, 2.15, 2.1)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  const chip = page.locator('[data-snap-preview]')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-snap-kind', 'point')
  await page.mouse.up()
  await expect(chip).toHaveCount(0)

  const paths = await pathsNow(page)
  expect(paths).toHaveLength(1)
  expect(paths[0]!.closed).toBe(true)
  expect(paths[0]!.anchors).toEqual(built.anchors.slice(0, 3))
  // one undo step takes the whole drag back
  await page.evaluate(() => (window as any).__sketchDraw.undo())
  const back = await pathsNow(page)
  expect(back[0]!.closed).toBe(false)
  expect(back[0]!.anchors).toEqual(built.anchors)
})

test('dragging an end onto an arc pins it there, with the on-curve chip during the drag', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)
    D.setNextSegment('line')
    D.place(14, 9); D.place(17, 9); D.finishPath(false)
    D.setTool('select')
    const [arc, line] = D.doc.entities.filter((e: any) => e.kind === 'path')
    return { arc: arc.id as string, centre: arc.segments[0].center as string, start: arc.anchors[0] as string, end: line.anchors[0] as string }
  })
  // the arc's drawn middle, in client pixels
  const mid = await page.evaluate((arcId) => {
    const el = document.querySelector(`[data-seg="${arcId}:0"]`) as SVGPathElement
    const p = el.getPointAtLength(el.getTotalLength() / 2)
    const m = el.getScreenCTM()!
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
  }, ids.arc)
  const from = await screenOf(page, 14, 9)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(mid.x + 5, mid.y + 4, { steps: 14 })
  const chip = page.locator('[data-snap-preview]')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-snap-kind', 'curve')
  await page.mouse.up()

  const res = await page.evaluate((ids) => {
    const d = (window as any).__sketchDraw.doc
    const P = (id: string) => d.entities.find((e: any) => e.id === id)
    const rule = d.constraints.find((c: any) => c.kind === 'equalDist' && c.refs[1] === ids.end)
    const c = P(ids.centre), a = P(ids.start), p = P(ids.end)
    return { refs: rule?.refs ?? null, rOk: Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(a.x - c.x, a.y - c.y)) < 1e-6 }
  }, ids)
  expect(res.refs).toEqual([ids.centre, ids.end, ids.centre, ids.start])
  expect(res.rOk).toBe(true)
})

for (const key of ['Meta', 'Control'] as const) {
  test(`dragging with ${key} held moves the point without joining`, async ({ page }) => {
    await open(page)
    const built = await openPath(page)
    const from = await screenOf(page, 3, 7)
    const to = await screenOf(page, 2.15, 2.1)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // the same drag, first without the key: the start offers the join
    await page.mouse.move(to.x, to.y, { steps: 12 })
    const chip = page.locator('[data-snap-preview]')
    await expect(chip).toHaveAttribute('data-snap-kind', 'point')
    // with the key held the next move shows no join, and release makes none
    await page.keyboard.down(key)
    await page.mouse.move(to.x + 1, to.y, { steps: 2 })
    await expect(chip).toHaveCount(0)
    await page.mouse.up()
    await page.keyboard.up(key)

    const paths = await pathsNow(page)
    expect(paths).toHaveLength(1)
    expect(paths[0]!.closed).toBe(false)
    expect(paths[0]!.anchors).toEqual(built.anchors)
    const end = await page.evaluate((id) => {
      const p = (window as any).__sketchDraw.doc.entities.find((e: any) => e.id === id)
      return { x: p.x, y: p.y }
    }, built.anchors[3]!)
    expect(end.x).toBeCloseTo(2.15 + 1 / 34, 1)
    expect(end.y).toBeCloseTo(2.1, 1)
  })
}

test('a point and an Option-clicked arc piece offer On curve, which pins the point to it', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(false)
    D.setNextSegment('line')
    D.setTool('point'); D.place(15, 9)
    D.setTool('select')
    const arc = D.doc.entities.find((e: any) => e.kind === 'path')
    const known = new Set([...arc.anchors, arc.segments[0].center])
    const p = D.doc.entities.find((e: any) => e.kind === 'point' && !known.has(e.id))
    return { arc: arc.id as string, centre: arc.segments[0].center as string, start: arc.anchors[0] as string, p: p.id as string }
  })
  const pt = await screenOf(page, 15, 9)
  await page.mouse.click(pt.x, pt.y)
  const mid = await page.evaluate((arcId) => {
    const el = document.querySelector(`[data-seg="${arcId}:0"]`) as SVGPathElement
    const q = el.getPointAtLength(el.getTotalLength() / 2)
    const m = el.getScreenCTM()!
    return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f }
  }, ids.arc)
  await page.keyboard.down('Alt')
  await page.mouse.click(mid.x, mid.y)
  await page.keyboard.up('Alt')
  const sel = await page.evaluate(() => { const D = (window as any).__sketchDraw; return { sel: D.selection, segs: D.selectedSegments } })
  expect(sel.sel).toEqual([ids.p])
  expect(sel.segs).toEqual([{ pathId: ids.arc, segIndex: 0 }])
  const btn = page.locator('[data-verb="onCurve"]')
  await expect(btn).toHaveText('On curve')
  await btn.hover()
  await expect(page.locator('[data-pen-tip-id="onCurve"]')).toBeVisible()
  await btn.click()
  const refs = await page.evaluate((ids) => {
    const d = (window as any).__sketchDraw.doc
    return d.constraints.find((c: any) => c.kind === 'equalDist' && c.refs[1] === ids.p)?.refs ?? null
  }, ids)
  expect(refs).toEqual([ids.centre, ids.p, ids.centre, ids.start])
})

test('dropping the end of a near-full arc onto its start closes it into a circle', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('line')
    D.place(4, 6)
    // press at (6,6) and drag up through (5,9): the piece bows into the long
    // way round, a near-full arc
    D.pathDown(6, 6); D.pathMove(5.6, 8); D.pathMove(5, 9); D.pathUp(5, 9)
    D.finishPath(false)
    D.setTool('select')
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    return { kinds: path.segments.map((s: any) => s.kind), start: path.anchors[0], end: path.anchors[1], centre: path.segments[0].center }
  })
  expect(ids.kinds).toEqual(['arc'])
  const from = await screenOf(page, 6, 6)
  const to = await screenOf(page, 4.1, 6.05)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await expect(page.locator('[data-snap-preview]')).toHaveAttribute('data-snap-kind', 'point')
  await page.mouse.up()
  const res = await page.evaluate((ids) => {
    const d = (window as any).__sketchDraw.doc
    const circle = d.entities.find((e: any) => e.kind === 'circle')
    return {
      paths: d.entities.filter((e: any) => e.kind === 'path').length,
      centre: circle?.center ?? null,
      pin: d.constraints.find((c: any) => c.kind === 'pointOnCircle')?.refs ?? null,
      circleId: circle?.id ?? null,
    }
  }, ids)
  expect(res.paths).toBe(0)
  expect(res.centre).toBe(ids.centre)
  expect(res.pin).toEqual([ids.start, res.circleId])
})
