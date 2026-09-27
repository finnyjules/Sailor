import { test, expect } from '@playwright/test'

// Rendering-only check for the glass benchmark page (task 9, step 2). This
// must never assert on frame timings — that's the controller's measurement
// pass with Julien, done in a visible tab, not here.
test.describe('glass bench', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/glass-bench')
    await expect(page.locator('.node-shell').first()).toBeVisible()
  })

  test('renders 40 node shells and the wires between them', async ({ page }) => {
    await expect(page.locator('.node-shell')).toHaveCount(40)
    await expect(page.locator('.vue-flow__edge').first()).toBeVisible()
  })

  test('has the three mode buttons and Pan', async ({ page }) => {
    const panel = page.locator('.node-btn')
    await expect(panel.filter({ hasText: 'Always' })).toBeVisible()
    await expect(panel.filter({ hasText: 'Smart' })).toBeVisible()
    await expect(panel.filter({ hasText: 'Never' })).toBeVisible()
    await expect(panel.filter({ hasText: 'Pan' })).toBeVisible()
  })
})
