import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels, stackImageData } from './_helpers'

/**
 * Frame brush Part 3, painted with the real mouse: Effect mode paints where an effect changes
 * everything beneath (the paint itself never shows), a second pass strengthens it, the eraser
 * weakens it, and More… paints with any library shader.
 */

const SHOTS = process.env.BRUSH_SHOTS_DIR

async function stage(page: Page) {
  const b = await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox()
  expect(b).toBeTruthy()
  return b!
}
async function paint(page: Page, pts: [number, number][], stepMs = 30) {
  const b = await stage(page)
  const at = ([fx, fy]: [number, number]) => [b.x + fx * b.width, b.y + fy * b.height] as const
  const [x0, y0] = at(pts[0]!)
  await page.mouse.move(x0, y0); await page.mouse.down()
  for (const p of pts.slice(1)) { const [x, y] = at(p); await page.mouse.move(x, y); await page.waitForTimeout(stepMs) }
  await page.mouse.up()
}
const line = (x0: number, y0: number, x1: number, y1: number, n = 20): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n])
/** Back-and-forth strokes covering the box x0..x1, y0..y1. */
async function fill(page: Page, x0: number, x1: number, y0: number, y1: number) {
  for (let y = y0; y <= y1 + 1e-6; y += 0.05) await paint(page, line(x0, y, x1, y))
}
const brushLayers = (page: Page) => page.evaluate(() =>
  ((window as any).__compositorLayers() as any[]).filter(l => l.kind === 'brush'))

type Px = { w: number; h: number; d: number[] }
/** Settled stage pixels with the brush cursor out of the picture (brush toggled off and back). */
async function grab(page: Page): Promise<Px> {
  await page.keyboard.press('b')
  await stackPixels(page)
  const px = await stackImageData(page)
  await page.keyboard.press('b')
  await expect(page.getByTestId('brush-toolbar')).toBeVisible()
  return px
}
/** Mean per-channel difference between two grabs inside a box (fractions of the stage). */
function diff(a: Px, b: Px, x0: number, x1: number, y0: number, y1: number): number {
  let s = 0, n = 0
  for (let y = Math.floor(y0 * a.h); y < y1 * a.h; y++)
    for (let x = Math.floor(x0 * a.w); x < x1 * a.w; x++) {
      const i = (y * a.w + x) * 4
      s += Math.abs(a.d[i]! - b.d[i]!) + Math.abs(a.d[i + 1]! - b.d[i + 1]!) + Math.abs(a.d[i + 2]! - b.d[i + 2]!)
      n++
    }
  return s / n / 3
}

async function seed(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__compositorSetLayers([
      { id: 'bg', kind: 'rect', x: 0.5, y: 0.5, w: 1, h: 1, radius: 0, rotation: 0, opacity: 1, fill: '#20242c', effects: [] },
      { id: 'flat', kind: 'rect', x: 0.5, y: 0.85, w: 1, h: 0.2, radius: 0, rotation: 0, opacity: 1, fill: '#3a6ea5', effects: [] },
      { id: 'txt', kind: 'text', x: 0.5, y: 0.45, rotation: 0, opacity: 1, text: 'SAILOR',
        fontFamily: 'Inter', fontWeight: 900, fontSize: 0.22, color: '#ffffff', align: 'center', lineHeight: 1.1, effects: [] },
    ])
  })
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length), { timeout: 10_000 }).toBe(3)
}

test('a painted effect changes only where painted, hides its paint, builds up and erases', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  await openCompositor(page)
  await seed(page)
  await page.keyboard.press('b')
  await expect(page.getByTestId('brush-toolbar')).toBeVisible()
  await page.getByTestId('brush-mode-effect').click()
  await expect(page.getByTestId('brush-toolbar')).toContainText('Paint where the effect should happen.')
  await page.getByTestId('brush-tip-spray').click()
  await page.getByTestId('brush-effect-pixelate').click()

  const bare = await grab(page)
  // Left half of the word, plus a strip of the flat band below it.
  await fill(page, 0.08, 0.46, 0.33, 0.58)
  await paint(page, line(0.1, 0.85, 0.45, 0.85))
  await expect.poll(async () => (await brushLayers(page)).length, { timeout: 5000 }).toBe(1)
  const fx = (await brushLayers(page))[0]
  expect(fx.showPaint).toBe(false)
  expect(fx.effects.some((e: any) => e.type === 'backdrop_shader' && e.effectId === 'pixelate')).toBe(true)

  const once = await grab(page)
  const left1 = diff(bare, once, 0.1, 0.44, 0.36, 0.55)
  const right1 = diff(bare, once, 0.56, 0.9, 0.36, 0.55)
  // Flat colour under the paint: pixelating a flat band changes nothing, and the paint's own
  // colour must not show there.
  const flat1 = diff(bare, once, 0.14, 0.4, 0.8, 0.9)
  console.log('effect once', JSON.stringify({ left1, right1, flat1 }))
  expect(left1).toBeGreaterThan(1.5)
  expect(right1).toBeLessThan(0.2)
  expect(flat1).toBeLessThan(0.5)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/effect-once.png` })

  // Second pass over the same area, into the same (selected) layer: stronger.
  await fill(page, 0.08, 0.46, 0.33, 0.58)
  expect((await brushLayers(page)).length).toBe(1)
  const twice = await grab(page)
  const left2 = diff(bare, twice, 0.1, 0.44, 0.36, 0.55)
  console.log('effect twice', left2)
  expect(left2).toBeGreaterThan(left1 * 1.05)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/effect-twice.png` })

  // Eraser: weaker.
  await page.getByTestId('brush-eraser').click()
  await fill(page, 0.08, 0.46, 0.33, 0.58)
  await page.getByTestId('brush-eraser').click()
  const erased = await grab(page)
  const left3 = diff(bare, erased, 0.1, 0.44, 0.36, 0.55)
  console.log('effect erased', left3)
  expect(left3).toBeLessThan(left2 * 0.9)

  // Reload the saved JSON: the saved layers redraw exactly what was painted, every time.
  await page.keyboard.press('b')
  const saved = await page.evaluate(() => (window as any).__compositorLayers())
  const live = await stackPixels(page)
  const reload = async () => {
    await page.evaluate(() => (window as any).__compositorSetLayers([]))
    await page.waitForTimeout(300)
    await page.evaluate((ls) => (window as any).__compositorSetLayers(JSON.parse(JSON.stringify(ls))), saved)
    return stackPixels(page)
  }
  const r1 = await reload()
  expect(r1).toBe(live)
  expect(await reload()).toBe(r1)
})

test('More… paints with a library shader', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await page.getByTestId('brush-mode-paint').click()
  await page.getByTestId('brush-tip-round').click()
  await page.getByTestId('brush-paint-more').click()
  const gallery = page.getByTestId('effect-gallery')
  await expect(gallery).toBeVisible()
  const card = gallery.getByTestId('effect-gallery-card').first()
  await expect(card).toBeVisible({ timeout: 10_000 })
  const id = await card.getAttribute('data-effect-id')
  expect(id).toBeTruthy()
  await card.dblclick()
  await expect(gallery).toBeHidden()
  await expect(page.getByTestId('brush-shader-paint')).toBeVisible()

  await paint(page, line(0.15, 0.5, 0.85, 0.52), 16)
  await expect.poll(async () => (await brushLayers(page)).length, { timeout: 5000 }).toBe(1)
  const l = (await brushLayers(page))[0]
  expect(l.fill?.type).toBe('shader')
  expect(l.fill?.shader?.effectId).toBe(id)
  expect(l.fill?.shader?.anchor).toBe('frame')
  expect(l.material ?? null).toBe(null)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shader-paint-${id}.png` })
})

test('the toolbar fits at 1024 wide in Effect mode', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await page.getByTestId('brush-mode-effect').click()
  const bar = page.getByTestId('brush-toolbar')
  const box = await bar.boundingBox()
  console.log('toolbar box', JSON.stringify(box))
  expect(box!.width).toBeLessThanOrEqual(460)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(1024)
  for (const id of ['water_ripple', 'blinds', 'bloom', 'bayer_dither', 'chromatic_aberration', 'pixelate', 'gaussian_blur'])
    await expect(page.getByTestId(`brush-effect-${id}`)).toBeVisible()
  await expect(page.getByTestId('brush-effect-more')).toBeVisible()
  if (SHOTS) await bar.screenshot({ path: `${SHOTS}/toolbar-effect-1024.png` })
})
