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
  expect(errors).toEqual([])
})
