import { expect, test, type Locator, type Page } from '@playwright/test'
import { dropNode, openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * The floating node toolbar (spec §2.3): selecting a node shows Edit ▾ /
 * Develop ▾ above it (replaces the per-node footers and SelectionActionChips).
 * Rows fire the same window events the old menus did, so "Transcribe" still
 * branches a new node off the audio artifact.
 *
 * Selection mechanics (as selection-chips.spec.ts had them): artifact bodies
 * are one big "drop or click a file" button, so a center click selects the
 * node (mousedown bubbles to vue-flow) AND opens a file chooser, swallowed by
 * the beforeEach handler.
 */
async function selectNode(page: Page, node: Locator) {
  const bb = (await node.boundingBox())!
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
}

async function deselectAll(page: Page, node: Locator) {
  // Click the pane just left of the node's bottom-left corner — outside the
  // node, away from the top-left breadcrumb overlay; clamped inside the
  // viewport. Prove the point really is empty pane first, so a stray node
  // under it can't pass the "bar hides" check by stealing the selection.
  const bb = (await node.boundingBox())!
  const vp = page.viewportSize()!
  const x = Math.max(bb.x - 30, 5), y = Math.min(bb.y + bb.height - 20, vp.height - 40)
  expect(await page.evaluate(([px, py]) => !!document.elementFromPoint(px!, py!)?.closest('.vue-flow__pane')
    && !document.elementFromPoint(px!, py!)?.closest('.vue-flow__node'), [x, y])).toBe(true)
  await page.mouse.click(x, y)
}

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Node actions' })

test.describe('Node toolbar', () => {
  test.beforeEach(async ({ page }) => {
    page.on('filechooser', async () => { /* swallow artifact upload dialogs */ })
    await waitForBackend(page)
    // openBlankWorkflow waits out the starter Frame and deletes it: a bare canvas.
    await openBlankWorkflow(page)
    await expect(page.locator('.vue-flow__node')).toHaveCount(0)
  })

  test('audio node: Develop ▾ lists Transcribe and Speakers; Transcribe adds a node; deselect hides the bar', async ({ page }) => {
    await dropNode(page, 'Audio')
    const node = page.locator('.vue-flow__node-artifact-audio')
    await expect(node).toBeVisible()
    await selectNode(page, node)

    const bar = toolbar(page)
    await expect(bar).toBeVisible()
    const develop = bar.getByRole('button', { name: 'Develop' })
    await expect(develop).toBeVisible()
    await develop.click()
    const menu = page.getByRole('menu', { name: 'Develop' })
    await expect(menu.getByRole('menuitem', { name: /Transcribe/ })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Speakers/ })).toBeVisible()

    // "Transcribe" → exactly one new node branches off, as the old chip did.
    const before = await page.locator('.vue-flow__node').count()
    await menu.getByRole('menuitem', { name: /Transcribe/ }).click()
    await expect.poll(async () => page.locator('.vue-flow__node').count()).toBe(before + 1)
    await expect(menu).toHaveCount(0)

    // Re-select the audio node, then click the empty pane: the bar goes away.
    await selectNode(page, node)
    await expect(toolbar(page)).toBeVisible()
    await deselectAll(page, node)
    await expect(toolbar(page)).toHaveCount(0)
  })

  test('video node: Edit ▾ lists Sync lips and Enhance', async ({ page }) => {
    await dropNode(page, 'Video')
    const node = page.locator('.vue-flow__node-artifact-video')
    await expect(node).toBeVisible()
    await selectNode(page, node)

    const bar = toolbar(page)
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Edit' }).click()
    const menu = page.getByRole('menu', { name: 'Edit' })
    await expect(menu.getByRole('menuitem', { name: /Sync lips/ })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Enhance/ })).toBeVisible()

    // Esc closes the menu; the bar stays while the node is selected.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(bar).toBeVisible()
  })

  test('multi-select bar: Run N shows for two nodes, Group creates a group', async ({ page }) => {
    // Two GradientStudio nodes (frontend-only, no /object_info dependency) —
    // dropNode is simpler than mocking an agent plan for this.
    await dropNode(page, 'GradientStudio')
    await dropNode(page, 'GradientStudio')
    const gradientNodes = page.locator('.vue-flow__node-gradient-studio')
    await expect(gradientNodes).toHaveCount(2)

    // Both land at the same viewport-center spawn point, so a shift-click would
    // only ever hit the topmost one — draw a rubber-band box around them
    // instead (the canvas defaults to select mode: panOnDrag=false,
    // selectionKeyCode=true, so a plain drag on the pane draws the box).
    const bb = (await gradientNodes.first().boundingBox())!
    await page.mouse.move(bb.x - 60, bb.y - 60)
    await page.mouse.down()
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 5 })
    await page.mouse.move(bb.x + bb.width + 60, bb.y + bb.height + 60, { steps: 5 })
    await page.mouse.up()

    const bar = toolbar(page)
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: 'Run 2 nodes' })).toBeVisible()

    await bar.getByRole('button', { name: 'Group' }).click()
    await expect(page.locator('.canvas-group')).toHaveCount(1)
  })
})
