import { test, expect } from '@playwright/test'

test.describe('node lab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/node-lab')
    await expect(page.locator('.node-shell').first()).toBeVisible()
  })

  test('a port grows, fills and names only itself on hover', async ({ page }) => {
    const ports = page.locator('.node-port')
    await ports.first().hover()
    const dot = ports.first().locator('.node-port__dot')
    await expect.poll(async () => (await dot.boundingBox())?.width).toBeGreaterThan(15)
    await expect.poll(() => page.locator('.node-port__label').evaluateAll(els => els.filter(e => getComputedStyle(e).opacity === '1').length)).toBe(1)
  })

  test('the Open bar rises on hover and is hidden at rest', async ({ page }) => {
    const host = page.locator('.node-openbar-host').first()
    const bar = host.locator('.node-openbar')
    await page.mouse.move(5, 5)
    await expect.poll(() => bar.evaluate(e => getComputedStyle(e).opacity)).toBe('0')
    await host.hover()
    await expect.poll(() => bar.evaluate(e => getComputedStyle(e).opacity)).toBe('1')
  })

  test('node rows are 32px', async ({ page }) => {
    const h = await page.locator('.node-shell [data-studio-row]').first().evaluate(e => e.getBoundingClientRect().height)
    expect(h).toBe(32)
  })

  test('shell edges are one even colour and width on all four sides', async ({ page }) => {
    const s = await page.locator('.node-shell').first().evaluate(e => {
      const c = getComputedStyle(e)
      return [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth, c.borderTopColor, c.borderLeftColor]
    })
    expect(new Set(s.slice(0, 4)).size).toBe(1)
    expect(s[4]).toBe(s[5])
  })
})
