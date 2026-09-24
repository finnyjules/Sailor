import { test, expect } from '@playwright/test'
import { openBlankWorkflow, dismissStartModal } from './_helpers'

test('settings AI tab shows the Anthropic and Replicate token fields', async ({ page }) => {
  await openBlankWorkflow(page)
  await dismissStartModal(page)

  await page.locator('button:has(svg.lucide-settings)').first().click()
  await page.getByRole('button', { name: 'AI', exact: true }).click()

  await expect(page.getByText('Anthropic API key')).toBeVisible()
  await expect(page.getByText('Replicate API token')).toBeVisible()

  // The Replicate field reflects server-side status: when a token is
  // configured (settings file or env) it shows a masked tail + replace
  // placeholder; otherwise the r8_ paste placeholder.
  const status = await page.request.get('/api/secrets').then(r => r.json())
  if (status.replicateToken?.set) {
    await expect(page.getByText(/••••/)).toBeVisible()
    await expect(page.getByPlaceholder('paste to replace')).toBeVisible()
  }
  else {
    await expect(page.getByPlaceholder('r8_...')).toBeVisible()
  }
})
