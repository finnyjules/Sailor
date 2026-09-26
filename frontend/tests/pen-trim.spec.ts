// tests/pen-trim.spec.ts
// The pen's Trim, Cut and Dissolve tools on the pen test page, driven with the
// REAL mouse and keyboard (page.mouse / page.keyboard) — the drawing is built
// through the page hooks, every edit is a real gesture.
import { test, expect, type Page } from '@playwright/test'

// the dev page's default view: 34 px per unit, y up, origin at (40, 400)
const overlay = (page: Page) => page.locator('svg[width="680"][height="460"]')
async function screen(page: Page, x: number, y: number) {
  const box = (await overlay(page).boundingBox())!
  return { x: box.x + 40 + 34 * x, y: box.y + 400 - 34 * y }
}
async function moveTo(page: Page, x: number, y: number, steps = 1) {
  const s = await screen(page, x, y)
  await page.mouse.move(s.x, s.y, { steps })
}
// the long line's two ends, smallest x first
const lineXs = (page: Page) => page.evaluate(() => {
  const d = (window as any).__sketchDraw.doc
  const P = (id: string) => d.entities.find((e: any) => e.id === id)
  return d.entities.filter((e: any) => e.kind === 'line')
    .map((l: any) => [P(l.p1).x, P(l.p2).x].sort((a: number, b: number) => a - b))
    .sort((a: number[], b: number[]) => a[0]! - b[0]!)
})
const anchorCount = (page: Page) => page.evaluate(() => {
  const d = (window as any).__sketchDraw.doc
  return d.entities.find((e: any) => e.kind === 'path')?.anchors.length ?? 0
})

test('trim by click and sweep, one undo for the sweep, then cut and dissolve', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)

  // two overlapping circles (x 4–10 and 8–14) and a line across both at y = 6:
  // the line's pieces run 2–4, 4–8, 8–10, 10–14, 14–16
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('circle'); D.place(7, 6); D.place(10, 6)
    D.setTool('circle'); D.place(11, 6); D.place(14, 6)
    D.setTool('line'); D.place(2, 6); D.place(16, 6)
    D.setTool('select')
  })
  expect(await lineXs(page)).toEqual([[2, 16]])

  // T picks Trim
  await page.keyboard.press('t')
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('trim')
  await expect(page.locator('[data-tool="trim"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Click a piece between crossings to remove it, or sweep across several')).toBeVisible()

  // hover the 2–4 piece: it is tinted, with one ring where the circle cuts it
  await moveTo(page, 3, 6, 4)
  await expect(page.locator('[data-trim-hover]')).toHaveCount(1)
  await expect(page.locator('[data-trim-ring]')).toHaveCount(1)

  // click removes it: the line now starts at the crossing
  await page.mouse.down(); await page.mouse.up()
  let xs = await lineXs(page)
  expect(xs.length).toBe(1)
  expect(xs[0]![0]).toBeCloseTo(4, 5)
  expect(xs[0]![1]).toBeCloseTo(16, 5)
  await expect(page.locator('[data-trim-ghost]')).toHaveCount(1)

  // sweep across 4–8 and 8–10 in one press — as ONE pointer move, the way a
  // fast sweep arrives once the browser coalesces moves
  await moveTo(page, 6, 6, 3)
  await page.mouse.down()
  await moveTo(page, 9.2, 6, 1)
  await page.mouse.up()
  xs = await lineXs(page)
  expect(xs.length).toBe(1)
  expect(xs[0]![0]).toBeCloseTo(10, 5)
  await expect(page.locator('[data-trim-ghost]')).toHaveCount(3)

  // ⌘Z once brings both swept pieces back (and clears the ghosts)
  await page.keyboard.press('ControlOrMeta+z')
  xs = await lineXs(page)
  expect(xs[0]![0]).toBeCloseTo(4, 5)
  expect(xs[0]![1]).toBeCloseTo(16, 5)
  await expect(page.locator('[data-trim-ghost]')).toHaveCount(0)

  // a path line well clear of the circles, then Cut (C) adds a point on it
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.setTool('path')
    D.pathDown(2, 1); D.pathUp(2, 1)
    D.pathDown(16, 1); D.pathUp(16, 1)
    D.finishPath(false)
    D.setTool('select')
  })
  expect(await anchorCount(page)).toBe(2)
  await page.keyboard.press('c')
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('cut')
  await moveTo(page, 9, 1.05, 4)
  await expect(page.locator('[data-cut-hover]')).toHaveCount(1)
  await page.mouse.down(); await page.mouse.up()
  expect(await anchorCount(page)).toBe(3)

  // Dissolve (D) on that point merges the two pieces back into one
  await page.keyboard.press('d')
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('dissolve')
  await moveTo(page, 9.1, 1, 3)
  await expect(page.locator('[data-dissolve-hover="ok"]')).toHaveCount(1)
  await page.mouse.down(); await page.mouse.up()
  expect(await anchorCount(page)).toBe(2)
})

test('the toolbar offers Delete for an Option-selected segment', async ({ page }) => {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset()
    D.setTool('path')
    for (const [x, y] of [[2, 2], [8, 2], [8, 8]]) { D.pathDown(x, y); D.pathUp(x, y) }
    D.finishPath(false)
    D.setTool('select')
  })
  // Option-click the second segment
  const s = await screen(page, 8, 5)
  await page.keyboard.down('Alt')
  await page.mouse.click(s.x, s.y)
  await page.keyboard.up('Alt')
  expect(await page.evaluate(() => (window as any).__sketchDraw.selectedSegments.length)).toBe(1)
  await page.locator('[data-act="delete"]').click()
  const segs = await page.evaluate(() => {
    const d = (window as any).__sketchDraw.doc
    return d.entities.filter((e: any) => e.kind === 'path').map((p: any) => p.segments.length)
  })
  expect(segs).toEqual([1])
})
