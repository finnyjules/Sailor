import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, dropNode, waitForBackend, setStudioRow } from './_helpers'

/** Data-URL snapshot of the compositor's unified stack canvas. */
async function stackPixels(page: Page): Promise<string> {
  await page.waitForTimeout(500) // let the watch → renderStack settle
  return await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    return cv.toDataURL()
  })
}

test.describe('Compositor post-processing effects', () => {
  test('per-layer adjust and whole-frame grain change (and restore) the composite', async ({ page }) => {
    await openBlankWorkflow(page)
    await waitForBackend(page)
    await dropNode(page, 'Compositor')
    const nodeId = await page.locator('.vue-flow__node').first().getAttribute('data-id')
    expect(nodeId).toBeTruthy()

    await page.evaluate((id) =>
      window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), nodeId)
    const canvas = page.locator('[data-testid="compositor-stack-canvas"]')
    await canvas.waitFor({ state: 'visible', timeout: 10_000 })

    // A rectangle to grade (addRect selects it, so the layer panel is showing).
    await page.getByTitle('Add rectangle').click()
    const baseline = await stackPixels(page)

    // Per-layer Adjust: brightness up must change pixels; removing it must restore them.
    // A layer's effects are no longer Add/Remove sections in the inspector — they are rows in
    // the layer tree, added from the row's plus menu and tuned in the effect view.
    const addFx = page.locator('[data-testid="add-effect"]').first()
    await addFx.hover()
    await addFx.click()
    await page.locator('[data-testid="add-effect-item"][data-kind="adjust"]').click()
    await setStudioRow(page, 'postfx-adjust-brightness', 1.8)
    const brightened = await stackPixels(page)
    expect(brightened).not.toBe(baseline)
    const adjustRow = page.locator('[data-testid="effect-row"][data-effect-kind="adjust"]')
    await adjustRow.hover()
    await adjustRow.getByRole('button', { name: 'Remove effect' }).click()
    await expect(adjustRow).toHaveCount(0)
    expect(await stackPixels(page)).toBe(baseline)

    // Deselect by clicking an empty artboard corner → doc panel appears.
    const box = await canvas.boundingBox()
    if (!box) throw new Error('stack canvas has no box')
    await page.mouse.click(box.x + 4, box.y + 4)
    await expect(page.getByText('Post-processing', { exact: true })).toBeVisible()

    // Whole-frame grain changes the composite.
    const preGrain = await stackPixels(page)
    await page.locator('[data-testid="postfx-add-grain"]').click()
    await setStudioRow(page, 'postfx-grain-amount', 0.9)
    expect(await stackPixels(page)).not.toBe(preGrain)

    // Persistence: reopen the modal — the doc chain survives (node properties).
    // setStudioRow committed with Enter, so the typed-entry input has unmounted
    // and focus is on the studio row's track; blur it so Escape closes the modal
    // rather than being swallowed by a focused control.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await canvas.waitFor({ state: 'hidden', timeout: 5_000 })
    await page.evaluate((id) =>
      window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), nodeId)
    await canvas.waitFor({ state: 'visible', timeout: 10_000 })
    await page.mouse.click(box.x + 4, box.y + 4)
    await expect(page.locator('[data-testid="postfx-add-grain"]')).toHaveText('Remove')
  })
})
