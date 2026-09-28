import { test, expect } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

// Frontend-only studios (no /object_info dependency) plus the two summary studios.
const STUDIOS: { type: string; vf: string }[] = [
  { type: 'GradientStudio', vf: 'gradient-studio' },
  { type: 'ShaderStudio', vf: 'shader-studio' },
  { type: 'TextureStudio', vf: 'texture-studio' },
  { type: 'ShapeStudio', vf: 'shape-studio' },
  { type: 'VectorType', vf: 'vector-type' },
  { type: 'SpaceType', vf: 'space-type' },
  { type: 'ShotDirector', vf: 'shot-director' },
  { type: 'LipSyncStudio', vf: 'lip-sync' },
]

test.describe('studio cards wear the glass shell', () => {
  for (const s of STUDIOS) {
    test(`${s.type}: shell, Open bar rises on hover and stays while selected`, async ({ page }) => {
      await waitForBackend(page)
      await openBlankWorkflow(page)
      await page.mouse.move(700, 400)
      await page.evaluate((t) => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: t } })), s.type)
      const node = page.locator(`.vue-flow__node-${s.vf}`).first()
      await expect(node).toBeVisible()
      const card = node.locator('.node-shell').first()
      await expect(card).toBeVisible()

      const bar = node.locator('.node-openbar')
      const opacity = () => bar.evaluate(el => Number(getComputedStyle(el).opacity))
      expect(await opacity()).toBe(0)
      await node.locator('.node-well').hover()
      await expect.poll(opacity).toBe(1)

      await page.mouse.move(40, 800)
      await node.locator('.node-shell__head').click()
      await expect(card).toHaveAttribute('data-selected', 'true')
      await page.mouse.move(40, 800)
      await expect.poll(opacity).toBe(1)
    })
  }

  test('double-click on a studio card opens its studio', async ({ page }) => {
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await page.mouse.move(700, 400)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType: 'GradientStudio' } })))
    const opened = page.evaluate(() => new Promise<string>(r => window.addEventListener('sailor:openGradientStudio', (e: any) => r(String(e.detail?.nodeId)), { once: true })))
    await page.locator('.vue-flow__node-gradient-studio .node-shell__head').dblclick()
    expect(await opened).not.toBe('undefined')
  })
})
