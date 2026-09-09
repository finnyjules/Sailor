import { test, expect } from '@playwright/test'
import { openCompositor } from './_helpers'

// Interaction-only: proves the drag-to-generate GESTURE (arm → drag box → on-box bar
// → prompt gate → Escape). It never clicks Generate — that call is paid and metered.
test('drag-to-generate: arm, drag a box, prompt gates Generate, Escape disarms', async ({ page }) => {
  test.setTimeout(120_000)
  await openCompositor(page)

  // Arm from the toolbar.
  const arm = page.locator('[data-testid="generate-tool-toggle"]')
  await expect(arm).toBeVisible({ timeout: 20_000 })
  await arm.click()

  // The buried region panel must NOT appear (the gesture suppresses it).
  await expect(page.getByText('Generate in region', { exact: false })).toHaveCount(0)

  // Drag a box on the artboard. The artboard is the compositor's stack canvas.
  const artboard = page.locator('[data-testid="compositor-stack-canvas"]').first()
  const box = await artboard.boundingBox()
  if (!box) throw new Error('no artboard bounding box')
  const x0 = box.x + box.width * 0.35, y0 = box.y + box.height * 0.35
  const x1 = box.x + box.width * 0.65, y1 = box.y + box.height * 0.6
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 })
  await page.mouse.move(x1, y1, { steps: 6 })
  await page.mouse.up()

  // The on-box bar appears; Generate is disabled until a prompt is typed.
  const bar = page.locator('[data-testid="gen-onbox-bar"]')
  await expect(bar).toBeVisible({ timeout: 5_000 })
  const generate = page.locator('[data-testid="gen-onbox-generate"]')
  await expect(generate).toBeDisabled()

  await page.locator('[data-testid="gen-onbox-prompt"]').fill('a red bicycle')
  await expect(generate).toBeEnabled()

  // Escape disarms: the bar disappears (never generated), and the modal stays open.
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(page.locator('[data-testid="compositor-stack-canvas"]')).toBeVisible()
})
