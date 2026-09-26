// tests/pen-snap.spec.ts
// Snapping a new point onto a path arc, with the REAL mouse: hovering shows the
// on-curve preview chip at the snap spot, and a click leaves the new point
// pinned to that arc (equalDist [C, p, C, A]).
import { test, expect, type Page } from '@playwright/test'

// the dev page's default view: 34 px per unit, y up, origin at (40, 400)
const overlay = (page: Page) => page.locator('svg[width="680"][height="460"]')
async function moveTo(page: Page, x: number, y: number, steps = 1) {
  const box = (await overlay(page).boundingBox())!
  await page.mouse.move(box.x + 40 + 34 * x, box.y + 400 - 34 * y, { steps })
}

test('a new Pen point snaps onto an arc of a closed path, with the on-curve preview', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  // a closed path of two arcs between (4,6) and (10,6): the lower arc (centre
  // (7,9)) dips to y ≈ 4.76, the upper one (centre (7,3)) rises to y ≈ 7.24
  const built = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path'); D.setNextSegment('arc')
    D.place(4, 6); D.place(10, 6); D.finishPath(true)
    D.setNextSegment('line')
    D.setTool('path')
    const path = D.doc.entities.find((e: any) => e.kind === 'path')
    return { anchors: path.anchors as string[], segs: path.segments as any[], closed: path.closed as boolean }
  })
  expect(built.closed).toBe(true)
  expect(built.segs.map(s => s.kind)).toEqual(['arc', 'arc'])

  // hover just above the upper arc's top: the preview chip says "on the curve"
  await moveTo(page, 7, 7.5, 4)
  const chip = page.locator('[data-snap-preview]')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-snap-kind', 'curve')
  await expect(page.locator('[data-cursor-glow]')).toHaveCount(0)

  // off in empty space, no preview
  await moveTo(page, 16, 1, 4)
  await expect(chip).toHaveCount(0)

  // back onto the arc and click: the new anchor sits on the arc with its rule
  await moveTo(page, 7, 7.5, 4)
  await expect(chip).toHaveAttribute('data-snap-kind', 'curve')
  await page.mouse.down(); await page.mouse.up()

  const res = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    const d = D.doc
    const P = (id: string) => d.entities.find((e: any) => e.id === id)
    const path = d.entities.find((e: any) => e.kind === 'path')
    const known = new Set([...path.anchors, ...path.segments.map((s: any) => s.center)])
    const p = d.entities.find((e: any) => e.kind === 'point' && !known.has(e.id))
    const rule = d.constraints.find((c: any) => c.kind === 'equalDist' && c.refs[1] === p?.id)
    const c = rule ? P(rule.refs[0]) : null
    const a = rule ? P(rule.refs[3]) : null
    return {
      p: p ? { x: p.x, y: p.y } : null,
      refs: rule?.refs ?? null,
      upperCentre: path.segments[1].center,
      upperStart: path.anchors[1],
      rOk: c && a ? Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(a.x - c.x, a.y - c.y)) < 1e-6 : false,
    }
  })
  expect(res.p).not.toBeNull()
  expect(res.p!.x).toBeCloseTo(7, 1)
  expect(res.p!.y).toBeCloseTo(3 + Math.sqrt(18), 3)
  expect(res.refs).toEqual([res.upperCentre, expect.any(String), res.upperCentre, res.upperStart])
  expect(res.rOk).toBe(true)
})
