import { test, expect, type Page } from '@playwright/test'

/**
 * Shape Studio hosts the shared pen (Plan C, Task 4), on /dev/shape-studio-lab.
 * Every gesture and key is a real `page.mouse` / `page.keyboard` event; the document
 * is read through the lab's `__shapeStudioLab.props` hook (the node's saved blob).
 */

/** How many times the studio asked to close (the lab keeps it mounted either way). */
const closesOf = (page: Page) => page.evaluate(() => (window as any).__shapeStudioLab.closes as number)

const markOf = (page: Page) => page.evaluate(() =>
  (window as any).__shapeStudioLab.props.sailor_shapeStudio?.doc?.layers?.[0]?.mark ?? null)

/** Non-background pixels per angular sector around the preview's centre. The preview's
 *  background is transparent (the checkerboard is CSS), so "drawn" = alpha > 0. */
async function sectorCoverage(page: Page, sectors: number): Promise<number[]> {
  return page.evaluate((n) => {
    const c = document.querySelector('[data-testid="shape-preview"]') as HTMLCanvasElement
    const ctx = c.getContext('2d')!
    const { width: w, height: h } = c
    const data = ctx.getImageData(0, 0, w, h).data
    const counts = new Array(n).fill(0)
    const cx = w / 2, cy = h / 2
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (data[(y * w + x) * 4 + 3]! === 0) continue
        const dx = x - cx, dy = y - cy
        if (dx * dx + dy * dy < 16) continue
        const a = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)
        counts[Math.min(n - 1, Math.floor(a / (Math.PI * 2 / n)))]++
      }
    }
    return counts
  }, sectors)
}

async function overlayPointCount(page: Page): Promise<number> {
  return page.locator('[data-testid="shape-pen-overlay"] circle').count()
}

test('a Drawn shape is drawn with the shared pen, arranged by the studio, and the pen owns Escape', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // Choosing Drawn with nothing drawn yet opens the pen straight away.
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  const overlay = page.locator('[data-testid="shape-pen-overlay"]')
  await expect(overlay).toBeVisible()

  // A closed triangle over the preview: three clicks, then click the first point; Enter commits.
  const box = (await overlay.boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const r = Math.min(box.width, box.height) * 0.12
  const pts = [
    { x: cx, y: cy - r },
    { x: cx + r, y: cy + r * 0.8 },
    { x: cx - r, y: cy + r * 0.8 },
  ]
  for (const p of pts) {
    await page.mouse.move(p.x, p.y)
    await page.mouse.down(); await page.mouse.up()
  }
  await page.mouse.move(pts[0]!.x, pts[0]!.y)
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="path"]')).toHaveCount(0)
  expect(await closesOf(page)).toBe(0)

  await expect.poll(async () => {
    const m = await markOf(page)
    return m ? { shape: m.shape, enough: (m.sketch?.entities?.length ?? 0) >= 4 } : null
  }, { timeout: 15_000 }).toEqual({ shape: 'drawn', enough: true })
  const committed = await markOf(page)
  expect(committed.sketch.entities.some((e: any) => e.kind === 'path' && e.closed)).toBe(true)
  expect(committed.paintTarget).toBe('fill')

  // The studio's own features apply to it: Radial, 12 copies, through the real controls.
  await expect(page.getByTestId('shape-draw')).toHaveText(/Edit the shape/)
  await page.getByLabel('Layout', { exact: true }).selectOption('radial')
  const countRow = page.locator('div.group:has([role="slider"][aria-label="Count"])')
  await countRow.locator('[data-row-value]').click()
  const input = countRow.locator('input')
  await input.fill('12')
  await input.press('Enter')
  await expect.poll(async () => (await markOf(page))?.count, { timeout: 15_000 }).toBe(12)
  await expect.poll(async () => (await markOf(page))?.layout).toBe('radial')
  // Twelve copies around the centre: the drawn triangle shows up all the way round.
  await expect.poll(async () => (await sectorCoverage(page, 12)).filter(n => n > 20).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(10)
  const before = JSON.stringify((await markOf(page)).sketch)

  // Edit it again. The rail and the Shape rows are locked while the pen is open.
  await page.getByTestId('shape-draw').click()
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await expect(page.getByTestId('shape-rail-lock')).toBeVisible()

  // A right-click on the preview adds no point.
  const n0 = await overlayPointCount(page)
  await page.mouse.click(cx + r * 2, cy - r * 2, { button: 'right' })
  expect(await overlayPointCount(page)).toBe(n0)

  // Start a path (one point), then Escape twice: the first drops the half-drawn path,
  // the second leaves the pen. The shell never sees either — the studio stays open.
  await page.locator('[data-tool="path"]').click()
  await page.mouse.move(cx + r * 2, cy - r * 2)
  await page.mouse.down(); await page.mouse.up()
  expect(await overlayPointCount(page)).toBeGreaterThan(n0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-tool="path"]')).toBeVisible()   // still in the pen
  expect(await overlayPointCount(page)).toBe(n0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-tool="path"]')).toHaveCount(0)  // the pen is closed
  expect(await closesOf(page)).toBe(0)                             // the studio is not
  // Leaving without a change puts the drawing back exactly.
  await page.waitForTimeout(800)
  expect(JSON.stringify((await markOf(page)).sketch)).toBe(before)
  // Control: with the pen closed, Escape is the studio's again — so the check above can fail.
  await page.keyboard.press('Escape')
  await expect.poll(() => closesOf(page)).toBe(1)
})
