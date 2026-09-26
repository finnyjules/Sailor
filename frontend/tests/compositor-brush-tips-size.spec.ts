import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * The same saved tip strokes cover the same share of the Frame whatever size it is drawn at:
 * the grain, specks and bristle marks are fixed to the picture, not to the screen. Paint once,
 * then compare paint coverage with the stage drawn at two very different sizes.
 */

async function coverage(page: Page): Promise<{ frac: number; w: number }> {
  await stackPixels(page)
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    const { width: w, height: h } = cv
    const d = ctx.getImageData(0, 0, w, h).data
    const bg = [d[0]!, d[1]!, d[2]!]
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - bg[0]!) + Math.abs(d[i + 1]! - bg[1]!) + Math.abs(d[i + 2]! - bg[2]!) > 60) n++
    return { frac: n / (w * h), w }
  })
}

test('tip strokes cover the same share of the Frame at two render sizes', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1024, height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  const b = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
  const drag = async (pts: [number, number][], hold = 0) => {
    await page.mouse.move(b.x + pts[0]![0] * b.width, b.y + pts[0]![1] * b.height); await page.mouse.down()
    for (const [fx, fy] of pts.slice(1)) { await page.mouse.move(b.x + fx * b.width, b.y + fy * b.height); await page.waitForTimeout(20) }
    if (hold) await page.waitForTimeout(hold)
    await page.mouse.up()
  }
  const line = (y: number): [number, number][] => Array.from({ length: 25 }, (_, i) => [0.15 + i * 0.028, y + Math.sin(i / 3) * 0.03])
  await page.getByTestId('brush-tip-spray').click(); await drag(line(0.25), 600)
  await page.getByTestId('brush-tip-round').click(); await drag(line(0.5))
  await page.getByTestId('brush-tip-bristle').click(); await drag(line(0.75))
  await expect.poll(async () => page.evaluate(() => ((window as any).__compositorLayers() as any[]).filter(l => l.kind === 'brush').flatMap(l => l.strokes).length), { timeout: 6000 }).toBe(3)
  await page.keyboard.press('b') // brush off: no cursor ring in the pixels
  const small = await coverage(page)
  await page.setViewportSize({ width: 1900, height: 1300 })
  await page.waitForTimeout(800)
  const big = await coverage(page)
  expect(big.w).toBeGreaterThan(small.w * 1.4)
  expect(small.frac).toBeGreaterThan(0.02)
  expect(Math.abs(big.frac - small.frac) / small.frac).toBeLessThan(0.12)
  console.log('coverage', JSON.stringify({ small, big }))
})
