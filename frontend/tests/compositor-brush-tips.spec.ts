import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Frame brush tips (spray can, round, bristle) end to end, painted with the real mouse.
 *
 * Replay determinism is proven in the unit suites; this is the proof that the editor
 * wiring holds: a stroke becomes exactly one saved tip stroke and one undo step, the
 * spray keeps dripping after release and commits once settled, the eraser needs a layer,
 * and reloading the saved strokes redraws the same pixels.
 */

const SHOTS = process.env.BRUSH_SHOTS_DIR

async function stageBox(page: Page) {
  const box = await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox()
  expect(box).toBeTruthy()
  return box!
}

/** Drag along `pts` (fractions of the stage box), `stepMs` between moves, optional hold before release. */
async function paint(page: Page, pts: [number, number][], stepMs = 16, holdMs = 0) {
  const b = await stageBox(page)
  const at = ([fx, fy]: [number, number]) => [b.x + fx * b.width, b.y + fy * b.height] as const
  const [x0, y0] = at(pts[0]!)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (const p of pts.slice(1)) { const [x, y] = at(p); await page.mouse.move(x, y); await page.waitForTimeout(stepMs) }
  if (holdMs) await page.waitForTimeout(holdMs)
  await page.mouse.up()
}

const line = (x0: number, y0: number, x1: number, y1: number, n = 30): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n + Math.sin(i / 4) * 0.02])

const brushLayers = (page: Page) => page.evaluate(() =>
  ((window as any).__compositorLayers() as any[]).filter(l => l.kind === 'brush'))

test('paint with each tip: one saved stroke and one undo step each, spray drips then commits', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: Number(process.env.BRUSH_VW ?? 1280), height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await expect(page.getByTestId('brush-toolbar')).toBeVisible()
  await expect(page.getByTestId('brush-tip-settings')).toBeVisible()

  // Spray can, with a long hold so it pools and drips.
  await page.getByTestId('brush-tip-spray').click()
  await paint(page, line(0.15, 0.3, 0.45, 0.3), 30, 1500)
  // Still dripping right after release: nothing committed yet.
  expect((await brushLayers(page)).length).toBe(0)
  await expect.poll(async () => (await brushLayers(page)).length, { timeout: 5000 }).toBe(1)
  let layers = await brushLayers(page)
  expect(layers[0].strokes).toHaveLength(1)
  expect(layers[0].strokes[0].tip).toBe('spray')
  expect(layers[0].strokes[0].pts.length).toBeGreaterThan(30)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brush-spray.png` })

  // Round, then bristle, into the same (selected) brush layer.
  await page.getByTestId('brush-tip-round').click()
  await paint(page, line(0.15, 0.55, 0.6, 0.5))
  await page.getByTestId('brush-tip-bristle').click()
  await paint(page, [[0.55, 0.75], [0.65, 0.6], [0.75, 0.75], [0.85, 0.6]].flatMap(([x, y], i, a) =>
    i === 0 ? [[x, y] as [number, number]] : line(a[i - 1]![0]!, a[i - 1]![1]!, x!, y!, 12).slice(1)), 16)
  await expect.poll(async () => (await brushLayers(page)).flatMap(l => l.strokes).length, { timeout: 5000 }).toBe(3)
  layers = await brushLayers(page)
  expect(layers.flatMap(l => l.strokes).map((s: any) => s.tip)).toEqual(['spray', 'round', 'bristle'])
  const before = await stackPixels(page)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brush-three-tips.png` })

  // Undo removes exactly the last stroke.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await brushLayers(page)).flatMap(l => l.strokes).length).toBe(2)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expect.poll(async () => (await brushLayers(page)).flatMap(l => l.strokes).length).toBe(3)

  // Reloading the saved strokes (a fresh replay from JSON) redraws identical pixels.
  const saved = await page.evaluate(() => (window as any).__compositorLayers())
  await page.evaluate(() => (window as any).__compositorSetLayers([]))
  await page.waitForTimeout(300)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(JSON.parse(JSON.stringify(ls))), saved)
  const after = await stackPixels(page)
  expect(after).toBe(before)

  // Spray eraser takes paint away with the same tip.
  await page.getByTestId('brush-tip-spray').click()
  await page.getByTestId('brush-eraser').click()
  await paint(page, line(0.2, 0.3, 0.35, 0.3, 12), 20)
  await expect.poll(async () => (await brushLayers(page)).flatMap(l => l.strokes).length, { timeout: 5000 }).toBe(4)
  const erased = (await brushLayers(page)).flatMap(l => l.strokes).at(-1)
  expect(erased.erase).toBe(true)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brush-erased.png` })
})

test('an eraser stroke with no brush layer creates nothing', async ({ page }) => {
  await openCompositor(page)
  await page.keyboard.press('b')
  await page.getByTestId('brush-eraser').click()
  await paint(page, line(0.2, 0.4, 0.6, 0.4))
  await page.waitForTimeout(2500)
  expect((await brushLayers(page)).length).toBe(0)
})

test('legacy brush strokes still draw', async ({ page }) => {
  await openCompositor(page)
  const blank = await stackPixels(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'legacy', kind: 'brush', x: 0.5, y: 0.5, w: 0.42, h: 0.06, rotation: 0, opacity: 1, fill: '#e4572e', stroke: '', strokeWidth: 0,
    strokes: [{ points: [{ x: 0.3, y: 0.5 }, { x: 0.5, y: 0.52 }, { x: 0.7, y: 0.5 }], radius: 0.02, hardness: 1, opacity: 1, erase: false }],
  }]))
  const drawn = await stackPixels(page)
  expect(drawn).not.toBe(blank)
})
