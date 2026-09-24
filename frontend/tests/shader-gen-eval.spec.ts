import { test, expect } from '@playwright/test'

// Renders the 24 hand-written spike takes through the engine's browser renderer
// (Sailor's real ShaderFxRenderer). Never presses Run, so it makes no paid calls.
test('shader-gen eval page renders all 24 spike takes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/dev/shader-gen-eval')
  const tiles = page.locator('[data-row="spike"] [data-tile]')
  await expect(tiles).toHaveCount(24, { timeout: 60_000 })
  await expect(page.locator('[data-row="spike"] [data-tile][data-compiled="false"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run Sonnet 5 and Haiku 4.5' })).toBeEnabled()

  // Quality variants section (rain + ink only): button present and enabled,
  // and both requests' reused spike row shows all 4 spike tiles. Never press
  // Run/Confirm here — this test makes no paid calls.
  await expect(page.getByRole('button', { name: 'Run variants A–D on rain and ink' })).toBeEnabled()
  const variantSpikeRows = page.locator('[data-section="variants"] [data-row="variant-spike"]')
  await expect(variantSpikeRows).toHaveCount(2)
  await expect(variantSpikeRows.nth(0).locator('[data-tile]')).toHaveCount(4)
  await expect(variantSpikeRows.nth(1).locator('[data-tile]')).toHaveCount(4)

  expect(errors).toEqual([])
})
