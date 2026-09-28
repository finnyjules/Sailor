import { test, expect, type Page } from '@playwright/test'

/**
 * Pixel reveal, end to end in the Frame editor: a text layer takes a "Materialize in" bar from the
 * Motion gallery; mid-bar the painted frame differs from the plain layer, and at the end of the bar
 * it is byte-identical to the plain layer (the fold hands the painter nothing once amount reaches 1).
 * Driven on /dev/frame-lab, whose editor opens straight away with the dev hooks.
 */

async function stackPixels(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height
    const x = c.getContext('2d')!; x.drawImage(cv, 0, 0)
    return Array.from(x.getImageData(0, 0, c.width, c.height).data)
  })
}
/** Pixels in the heat colour's family (ultramarine #1700c7: blue well above red and green) — the
 *  painter draws fresh blocks in it; the Dissolve fallback never would. */
const heatPixels = (a: number[]) => {
  let n = 0
  for (let i = 0; i < a.length; i += 4) if (a[i + 2]! > a[i]! + 60 && a[i + 2]! > a[i + 1]! + 60) n++
  return n
}
const differing = (a: number[], b: number[]) => {
  let n = 0
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 6) n++
  return n
}

/** Seek the timeline by clicking its ruler at `frac` of the bar's own span. */
async function seekBar(page: Page, frac: number): Promise<void> {
  await page.evaluate((f) => {
    const ruler = document.querySelector('[data-testid="timeline-ruler"]') as HTMLElement
    const bar = document.querySelector('[title*="Materialize in"]') as HTMLElement
    const rr = ruler.getBoundingClientRect(), br = bar.getBoundingClientRect()
    const x = br.x + br.width * f
    const o = { clientX: x, clientY: rr.y + rr.height / 2, bubbles: true, pointerId: 1, button: 0, buttons: 1 }
    ruler.dispatchEvent(new PointerEvent('pointerdown', o))
    ruler.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
  }, frac)
  await page.waitForTimeout(900)
}

test('Pixel reveal: a Materialize in bar changes the frame mid-bar and ends on the plain layer exactly', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/dev/frame-lab')
  await expect.poll(() => page.evaluate(() => typeof (window as any).__compositorSetLayers === 'function'), { timeout: 60_000 }).toBe(true)
  await page.evaluate(() => {
    const ls = (window as any).__compositorLayers()
    const t = ls.find((l: any) => l.kind === 'text')
    ;(window as any).__compositorSetLayers([{ ...t, id: 'prtext', text: 'Pixels settle\ninto clean type', x: 0.5, y: 0.35, fontSize: 0.09, color: '#111111', rotation: 0, opacity: 1, effects: [], cloner: undefined, path: undefined }])
  })

  await page.getByRole('button', { name: 'Motion', exact: true }).click()
  await page.getByText('Pixels settle', { exact: false }).first().click()
  await page.getByRole('button', { name: /Add behaviour/ }).click()
  await page.getByRole('button', { name: 'Materialize in' }).first().click()
  await expect(page.locator('[title*="Materialize in"]').first()).toBeVisible()
  const done = page.getByRole('button', { name: 'Done' })
  if (await done.isVisible()) await done.click()

  await seekBar(page, 0.25)
  const mid = await stackPixels(page)
  await seekBar(page, 1.02)
  const end = await stackPixels(page)
  await seekBar(page, 3)
  const after = await stackPixels(page)

  expect(differing(end, after)).toBe(0)
  expect(differing(mid, after)).toBeGreaterThan(2000)
  // Fresh blocks arrive hot: the mid-bar frame carries the heat colour the plain frame lacks.
  expect(heatPixels(mid) - heatPixels(after)).toBeGreaterThan(500)
})
