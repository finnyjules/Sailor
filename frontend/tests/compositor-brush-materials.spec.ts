import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Frame brush materials (Part 2), painted with the real mouse: a material becomes the brush
 * layer's paint, a new layer starts when the toolbar paint differs from the selected layer,
 * Moving off holds the picture still, and a saved material layer redraws the same pixels.
 */

const SHOTS = process.env.BRUSH_SHOTS_DIR

async function stage(page: Page) {
  const b = await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox()
  expect(b).toBeTruthy()
  return b!
}
async function paint(page: Page, pts: [number, number][], stepMs = 16, holdMs = 0) {
  const b = await stage(page)
  const at = ([fx, fy]: [number, number]) => [b.x + fx * b.width, b.y + fy * b.height] as const
  const [x0, y0] = at(pts[0]!)
  await page.mouse.move(x0, y0); await page.mouse.down()
  for (const p of pts.slice(1)) { const [x, y] = at(p); await page.mouse.move(x, y); await page.waitForTimeout(stepMs) }
  if (holdMs) await page.waitForTimeout(holdMs)
  await page.mouse.up()
}
const line = (x0: number, y0: number, x1: number, y1: number, n = 24): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n])
const brushLayers = (page: Page) => page.evaluate(() =>
  ((window as any).__compositorLayers() as any[]).filter(l => l.kind === 'brush'))
const canvasData = (page: Page) => page.evaluate(() =>
  (document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement).toDataURL())

test('each material paints its own layer; round follows the line, spray sits on the surface', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: Number(process.env.BRUSH_VW ?? 1280), height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await expect(page.getByTestId('brush-toolbar')).toBeVisible()

  const mats = ['foil', 'chrome', 'lava', 'ink', 'neon', 'oil'] as const
  await page.getByTestId('brush-tip-round').click()
  for (let i = 0; i < mats.length; i++) {
    await page.getByTestId(`brush-material-${mats[i]}`).click()
    const y = 0.12 + i * 0.13
    await paint(page, line(0.1, y, 0.9, y + 0.04))
  }
  await expect.poll(async () => (await brushLayers(page)).length, { timeout: 5000 }).toBe(6)
  const layers = await brushLayers(page)
  expect(layers.map((l: any) => l.material?.id)).toEqual([...mats])
  expect(layers.every((l: any) => l.material.moving === true)).toBe(true)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/materials-round.png` })

  // Two perpendicular chrome strokes: judged by eye in the screenshot (highlight runs along each).
  await page.getByTestId('brush-material-chrome').click()
  await paint(page, line(0.2, 0.5, 0.8, 0.5))
  await paint(page, line(0.5, 0.2, 0.5, 0.8))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/materials-chrome-cross.png` })

  // Spray can with lava: its own layer, fixed to the surface (engine path covered in units).
  await page.getByTestId('brush-tip-spray').click()
  await page.getByTestId('brush-material-lava').click()
  await paint(page, line(0.15, 0.85, 0.85, 0.85), 30)
  await expect.poll(async () => (await brushLayers(page)).at(-1)?.strokes?.[0]?.tip, { timeout: 5000 }).toBe('spray')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/materials-spray-lava.png` })
})

test('a material layer differs from colour; Moving off holds still and reloads identically', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await page.getByTestId('brush-tip-round').click()
  await paint(page, line(0.15, 0.5, 0.85, 0.52))       // Colour
  await expect.poll(async () => (await brushLayers(page)).length).toBe(1)
  await page.keyboard.press('b')
  const colour = await stackPixels(page)
  const saved = await page.evaluate(() => (window as any).__compositorLayers())

  // Same stroke as a still lava material (Moving off).
  const asLava = saved.map((l: any) => l.kind === 'brush' ? { ...l, material: { id: 'lava', moving: false } } : l)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), asLava)
  const lava1 = await stackPixels(page)
  expect(lava1).not.toBe(colour)
  await page.waitForTimeout(1000)
  expect(await canvasData(page)).toBe(lava1)            // still: identical a second later

  // Reload the saved JSON: identical pixels.
  await page.evaluate(() => (window as any).__compositorSetLayers([]))
  await page.waitForTimeout(300)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(JSON.parse(JSON.stringify(ls))), asLava)
  expect(await stackPixels(page)).toBe(lava1)

  // Moving on: the picture changes over time.
  const moving = asLava.map((l: any) => l.kind === 'brush' ? { ...l, material: { id: 'lava', moving: true } } : l)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), moving)
  await page.waitForTimeout(400)
  const m1 = await canvasData(page)
  await page.waitForTimeout(1000)
  expect(await canvasData(page)).not.toBe(m1)
})

/** Share of the stage canvas that is not background — the same measure the Part 1 size check uses. */
async function paintedShare(page: Page): Promise<number> {
  await stackPixels(page)
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const { width: w, height: h } = cv
    const d = cv.getContext('2d')!.getImageData(0, 0, w, h).data
    const bg = [d[0]!, d[1]!, d[2]!]
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - bg[0]!) + Math.abs(d[i + 1]! - bg[1]!) + Math.abs(d[i + 2]! - bg[2]!) > 60) n++
    return n / (w * h)
  })
}

test('materials look the same at two render sizes (round, spray, neon glow)', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1024, height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await page.getByTestId('brush-tip-round').click()
  await page.getByTestId('brush-material-chrome').click()
  await paint(page, line(0.15, 0.3, 0.85, 0.33))
  await page.getByTestId('brush-material-neon').click()
  await paint(page, line(0.15, 0.55, 0.85, 0.58))
  await page.getByTestId('brush-tip-spray').click()
  await page.getByTestId('brush-material-lava').click()
  await paint(page, line(0.15, 0.8, 0.85, 0.8), 30)
  await expect.poll(async () => (await brushLayers(page)).length, { timeout: 6000 }).toBe(3)
  // Hold every material still so the two sizes compare the same moment.
  const still = (await page.evaluate(() => (window as any).__compositorLayers())).map((l: any) =>
    l.kind === 'brush' && l.material ? { ...l, material: { ...l.material, moving: false } } : l)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), still)
  await page.keyboard.press('b') // brush off: no cursor ring in the pixels
  const small = await paintedShare(page)
  await page.setViewportSize({ width: 1900, height: 1300 })
  await page.waitForTimeout(800)
  const big = await paintedShare(page)
  expect(small).toBeGreaterThan(0.02)
  expect(Math.abs(big - small) / small).toBeLessThan(0.12)
  console.log('material coverage', JSON.stringify({ small, big }))
})
