import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, dropNode, waitForBackend, dismissStartModal } from './_helpers'

// Prompt-validation surfacing: a /prompt HTTP 400 (type mismatch, missing
// input) used to be completely silent — ComfyUI's frontend swallows it into
// its own hidden dialog. The bridge now forwards the structured node_errors
// map via `queue_error`; the layout toasts a per-node summary and the canvas
// paints the offending nodes red. Mirrors port-intent.spec.ts patterns.

async function dropNodeAndWait(page: Page, nodeType: string, existing = 0) {
  const nodes = page.locator('.vue-flow__node')
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await nodes.count() <= existing) await dropNode(page, nodeType)
    try {
      await nodes.nth(existing).waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForTimeout(700)
      if (await nodes.count() > existing) {
        await fitView(page)
        return
      }
    }
    catch { /* retry */ }
  }
  throw new Error(`Node ${nodeType} did not render after retries`)
}

async function fitView(page: Page) {
  await page.locator('.vue-flow__pane').click({ button: 'right', position: { x: 80, y: 400 } })
  await page.getByText('Fit View').click()
  await page.waitForTimeout(300)
}

async function wire(page: Page, sourceSel: string, targetSel: string) {
  const source = page.locator(sourceSel)
  const target = page.locator(targetSel)
  const sBox = (await source.boundingBox())!
  const tBox = (await target.boundingBox())!
  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 10 })
  await page.mouse.up()
}

test.describe('prompt validation surfacing', () => {
  test.beforeEach(async ({ page }) => {
    await openBlankWorkflow(page)
    await waitForBackend(page)
    await dismissStartModal(page)
  })

  test('IMAGE→VIDEO type mismatch: toast with real text + red ring on SaveVideo', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    await dropNodeAndWait(page, 'SaveVideo', 1)

    // LoadImage IMAGE output (first source handle) → SaveVideo video input
    // (first target handle of the second node).
    await wire(
      page,
      '.vue-flow__node >> nth=0 >> .vue-flow__handle.source >> nth=0',
      '.vue-flow__node >> nth=1 >> .vue-flow__handle.target >> nth=0',
    )
    await expect(page.locator('.vue-flow__edge')).toHaveCount(1)

    await page.getByRole('button', { name: 'Run', exact: true }).click()

    // Toast carries the structured validation summary.
    const toast = page.locator('[data-sonner-toast]', { hasText: 'Workflow validation failed' })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast).toContainText('SaveVideo: Return type mismatch between linked nodes')
    await expect(toast).toContainText('received_type(IMAGE) mismatch input_type(VIDEO)')

    // Offending node gets the execution-error treatment: red ring + chip.
    await expect(page.locator('.vue-flow__node .ring-red-500')).toHaveCount(1)
    await expect(
      page.locator('.vue-flow__node', { hasText: 'Save Video' }).locator('.ring-red-500'),
    ).toBeVisible()
  })

  test('valid LoadImage→PreviewImage run: no validation toast', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    await dropNodeAndWait(page, 'PreviewImage', 1)
    await wire(
      page,
      '.vue-flow__node >> nth=0 >> .vue-flow__handle.source >> nth=0',
      '.vue-flow__node >> nth=1 >> .vue-flow__handle.target >> nth=0',
    )
    await expect(page.locator('.vue-flow__edge')).toHaveCount(1)

    await page.getByRole('button', { name: 'Run', exact: true }).click()
    // Give the round-trip (load workflow → 800ms settle → queue) time to fail
    // if it were going to: no validation/queue toast may appear.
    await page.waitForTimeout(6_000)
    await expect(page.locator('[data-sonner-toast]', { hasText: 'Workflow validation failed' })).toHaveCount(0)
    await expect(page.locator('[data-sonner-toast]', { hasText: 'Couldn’t start run' })).toHaveCount(0)
    await expect(page.locator('.vue-flow__node .ring-red-500')).toHaveCount(0)
  })
})
