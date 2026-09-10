import { test, expect } from '@playwright/test'
import { openCompositor } from './_helpers'

// Interaction-only: right-click an image layer → the edit context menu → the Edit image
// and Edit a region panels appear and gate correctly. It NEVER clicks Edit/Generate —
// those are paid (Kontext / FLUX Fill) calls, verified manually.
test('right-click an image: edit menu + Edit-image / Edit-region panels gate correctly', async ({ page }) => {
  test.setTimeout(120_000)
  await openCompositor(page)

  // Seed one image layer, centred, using a real ComfyUI output image so it renders
  // (pixel-accurate hit-testing needs the image loaded).
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'img1', kind: 'image', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    w: 0.6, h: 0.6, filename: 'frame_img_1788924614774_0000.png',
  }]))
  const artboard = page.locator('[data-testid="compositor-stack-canvas"]').first()
  await expect(artboard).toBeVisible()
  await page.waitForTimeout(1500) // let the image load so the hit-test finds it

  const box = await artboard.boundingBox()
  if (!box) throw new Error('no artboard bounding box')
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2

  // Right-click the image → the three-item menu.
  await page.mouse.click(cx, cy, { button: 'right' })
  await expect(page.getByText('Edit image…', { exact: true })).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('Edit a region…', { exact: true })).toBeVisible()
  await expect(page.getByText('Select an object…', { exact: true })).toBeVisible()

  // Edit image… → the panel; Edit disabled until a prompt is typed.
  await page.getByText('Edit image…', { exact: true }).click()
  const editPrompt = page.locator('[data-testid="edit-image-prompt"]')
  const editRun = page.locator('[data-testid="edit-image-run"]')
  await expect(editPrompt).toBeVisible({ timeout: 5_000 })
  await expect(editRun).toBeDisabled()
  await editPrompt.fill('make it night')
  await expect(editRun).toBeEnabled()
  // Do NOT click — paid.

  // Right-click again → Edit a region…: the region panel replaces the edit-image
  // panel (mutual exclusion), and its Generate is disabled with no mask + no prompt.
  await page.mouse.click(cx, cy, { button: 'right' })
  await page.getByText('Edit a region…', { exact: true }).click()
  await expect(page.locator('[data-testid="edit-region-prompt"]')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('[data-testid="edit-region-run"]')).toBeDisabled()
  await expect(editPrompt).toHaveCount(0) // edit-image panel gone (mutual exclusion)
  // The compositor modal stays open throughout.
  await expect(artboard).toBeVisible()
})
