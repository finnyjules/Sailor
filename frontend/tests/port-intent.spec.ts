import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, dropNode, waitForBackend, dismissStartModal } from './_helpers'

/** Drop a node and wait for it to stick. The canvas finishes loading the
 *  (empty) workflow asynchronously after mount and replaces `nodes` when done —
 *  an addNode dispatched before that completes gets wiped. Retry until stable. */
async function dropNodeAndWait(page: Page, nodeType: string, existing = 0) {
  const nodes = page.locator('.vue-flow__node')
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await nodes.count() <= existing) await dropNode(page, nodeType)
    try {
      await nodes.nth(existing).waitFor({ state: 'visible', timeout: 3000 })
      // Survive the late workflow-load wipe: confirm it's still there shortly after.
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

/** Nodes drop at screen center and can be wide enough to push their output
 *  handle off-viewport. Fit the view (canvas context menu) before interacting. */
async function fitView(page: Page) {
  await page.locator('.vue-flow__pane').click({ button: 'right', position: { x: 80, y: 400 } })
  await page.getByText('Fit View').click()
  await page.waitForTimeout(300)
}

test.describe('port intent popover', () => {
  test.beforeEach(async ({ page }) => {
    // openBlankWorkflow already dismisses the start modal (and the Frame it
    // now leaves behind) via the shared dismissStartModal helper below; this
    // second call is a harmless no-op guard (dismissStartModal checks
    // visibility first) kept so the intent here — a bare canvas — stays
    // explicit rather than implicit in openBlankWorkflow's internals.
    await openBlankWorkflow(page)
    await waitForBackend(page)
    await dismissStartModal(page)
  })

  test('port click opens popover; picking a node inserts and wires it', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    await page.locator('.vue-flow__node .vue-flow__handle.source').first().click({ force: true })

    const input = page.getByPlaceholder('What do you want to do?')
    await expect(input).toBeVisible()

    await input.fill('preview')
    await expect(page.getByText('Preview Image')).toBeVisible()
    await input.press('Enter')

    await expect(page.locator('.vue-flow__node')).toHaveCount(2)
    await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
  })

  test('escape closes the popover without inserting', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    await page.locator('.vue-flow__node .vue-flow__handle.source').first().click({ force: true })
    const input = page.getByPlaceholder('What do you want to do?')
    await expect(input).toBeVisible()
    await input.press('Escape')
    await expect(input).not.toBeVisible()
    await expect(page.locator('.vue-flow__node')).toHaveCount(1)
  })

  test('wire dropped on empty canvas opens the popover at the drop point', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    const handle = page.locator('.vue-flow__node .vue-flow__handle.source').first()
    const box = (await handle.boundingBox())!
    // Clamp the drop point inside the canvas — fitView zooms in on the lone
    // node, so a fixed offset from its right-edge handle can leave the canvas.
    const pane = (await page.locator('.vue-flow').boundingBox())!
    const dropX = Math.min(box.x + 220, pane.x + pane.width - 60)
    const dropY = Math.min(box.y + 160, pane.y + pane.height - 60)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(dropX, dropY, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByPlaceholder('What do you want to do?')).toBeVisible()
  })

  test('a normal wire between two ports still connects without a popover', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    await dropNodeAndWait(page, 'PreviewImage', 1)
    await expect(page.locator('.vue-flow__node')).toHaveCount(2)

    const source = page.locator('.vue-flow__node .vue-flow__handle.source').first()
    const target = page.locator('.vue-flow__node .vue-flow__handle.target').last()
    const sBox = (await source.boundingBox())!
    const tBox = (await target.boundingBox())!
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 10 })
    await page.mouse.up()

    await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
    await expect(page.getByPlaceholder('What do you want to do?')).not.toBeVisible()
  })

  test('ask AI without an API key shows an inline error', async ({ page }) => {
    await dropNodeAndWait(page, 'LoadImage')
    await page.locator('.vue-flow__node .vue-flow__handle.source').first().click({ force: true })
    const input = page.getByPlaceholder('What do you want to do?')
    await input.fill('upscale this image 4x')
    await input.press('ControlOrMeta+Enter')
    await expect(page.getByText(/No Anthropic API key/)).toBeVisible()
  })
})
