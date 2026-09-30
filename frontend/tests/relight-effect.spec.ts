import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Relight (stage 1) — browser verification. Proves what a screenshot can't: the effect really
 * ran on the GPU (run counter, not the plain fallback), lights change the pixels, a drag is ONE
 * undo step, and the right-click entry adds and selects the effect.
 */

/** One image layer (the puppy, whose depth map is cached in input/sailor_depth), inset so a canvas corner stays empty. */
async function seedPhoto(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__compositorSetLayers([
      { id: 'pup', kind: 'image', filename: 'flux_lora_00165_.png', x: 0.5, y: 0.5, w: 0.8, h: 0.8, rotation: 0, opacity: 1, effects: [] },
    ])
  })
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length), { timeout: 10_000 }).toBe(1)
}
const runs = (page: Page) => page.evaluate(() => (window as any).__relightRuns?.() ?? -1)

/** Right-click the photo → Relight…, then wait until the GPU pass has actually run. */
async function addRelight(page: Page) {
  const runs0 = await runs(page)
  const box = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.getByText('Relight…', { exact: true }).click()
  await expect.poll(() => runs(page), { timeout: 15_000 }).toBeGreaterThan(runs0)
}

test.describe('Relight effect', () => {
  test('right-click Relight… adds the effect, selects it and relights the photo', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const before = await stackPixels(page)
    await addRelight(page)                                    // includes: the GPU pass really ran
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(1)
    await expect(page.getByTestId('relight-setup-Golden key')).toHaveAttribute('aria-pressed', 'true')
    expect(await stackPixels(page)).not.toBe(before)
  })

  test('dragging a light moves it and changes the picture; one undo restores it', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const handle = page.getByTestId('relight-light-handle').first()
    const b0 = (await handle.boundingBox())!
    const px0 = await stackPixels(page)
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
    await page.mouse.down()
    await page.mouse.move(b0.x - 260, b0.y + 140, { steps: 12 })
    await page.mouse.up()
    const b1 = (await handle.boundingBox())!
    expect(Math.hypot(b1.x - b0.x, b1.y - b0.y)).toBeGreaterThan(100)
    const px1 = await stackPixels(page)
    expect(px1).not.toBe(px0)
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await handle.boundingBox())!.x, { timeout: 5_000 }).toBeCloseTo(b0.x, 0)
    expect(await stackPixels(page)).toBe(px0)
  })

  test('setups switch the lights; Neon gives two handles and un-highlights after a change', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await page.getByTestId('relight-setup-Neon').click()
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(2)
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'true')
    const h = page.getByTestId('relight-light-handle').first()
    const b = (await h.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down()
    await page.mouse.move(b.x + 60, b.y + 40, { steps: 6 }); await page.mouse.up()
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'false')
  })

  test('Compare shows the photo without Relight while held', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const plain = await stackPixels(page)
    await addRelight(page)
    const lit = await stackPixels(page)
    const cmp = page.getByTestId('relight-compare')
    const cb = (await cmp.boundingBox())!
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down()
    await expect.poll(() => stackPixels(page)).toBe(plain)
    await page.mouse.up()
    await expect.poll(() => stackPixels(page)).toBe(lit)
  })
})
