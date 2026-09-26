import { expect, test, type Page } from '@playwright/test'
import { dropNode, openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * While a studio is open over the canvas, ⌘Z / ⇧⌘Z / ⌘Y never reach the canvas's history.
 * A studio with nothing of its own to undo swallows the key: before this, the Gradient,
 * Shader, Shape and Vector type studios let it fall through, and the canvas behind the
 * studio silently lost a step. Nothing here calls a model or queues a run.
 */

const nodes = (page: Page) => page.locator('.vue-flow__node')

/** Two nodes, each its own undo step (the canvas records on a 350 ms debounce). */
async function twoNodes(page: Page) {
  await openBlankWorkflow(page)
  await waitForBackend(page)
  const before = await nodes(page).count()
  await dropNode(page, 'GradientStudio')
  await expect(nodes(page)).toHaveCount(before + 1)
  await page.waitForTimeout(600)
  await dropNode(page, 'GradientStudio')
  await expect(nodes(page)).toHaveCount(before + 2)
  await page.waitForTimeout(600)
  return before + 2
}

test.describe('undo keys stay in an open studio', () => {
  test('Gradient studio with nothing to undo: ⌘Z, ⇧⌘Z and ⌘Y leave the canvas alone', async ({ page }) => {
    const count = await twoNodes(page)
    const id = await nodes(page).first().getAttribute('data-id')
    await page.evaluate(nodeId => window.dispatchEvent(new CustomEvent('sailor:openGradientStudio', { detail: { nodeId } })), id)
    await expect(page.getByTestId('studio-shell-dock')).toBeVisible({ timeout: 20_000 })
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(400)
    await expect(nodes(page)).toHaveCount(count) // behind the studio, nothing was undone
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await page.keyboard.press('ControlOrMeta+y')
    await page.waitForTimeout(400)
    await expect(page.getByTestId('studio-shell-dock')).toBeVisible() // still open
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByTestId('studio-shell-dock')).toHaveCount(0)
    await expect(nodes(page)).toHaveCount(count) // the second drop is still there
    // With the studio closed, ⌘Z is the canvas's again. (Opening and closing the studio is a step
    // of its own — the studio writes its config back — so the second drop goes within a few.)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    for (let i = 0; i < 3 && await nodes(page).count() === count; i++) {
      await page.keyboard.press('ControlOrMeta+z')
      await page.waitForTimeout(300)
    }
    await expect(nodes(page)).toHaveCount(count - 1)
  })

  test('Shader, Shape, Vector type, Texture and 3D studios: the undo keys never reach the canvas either', async ({ page }) => {
    test.setTimeout(180_000)
    await twoNodes(page)
    const studios: [string, string][] = [
      ['ShaderStudio', 'sailor:openShaderStudio'], ['ShapeStudio', 'sailor:openShapeStudio'],
      ['VectorType', 'sailor:openVectorType'], ['TextureStudio', 'sailor:openTextureStudio'],
      ['Scene3DStudio', 'sailor:openScene3DStudio'],
    ]
    for (const [type, event] of studios) {
      await dropNode(page, type)
      await page.waitForTimeout(600)
      const count = await nodes(page).count()
      const id = await nodes(page).last().getAttribute('data-id')
      await page.evaluate(([ev, nodeId]) => window.dispatchEvent(new CustomEvent(ev!, { detail: { nodeId } })), [event, id])
      await expect(page.getByTestId('studio-shell-dock'), type).toBeVisible({ timeout: 20_000 })
      await page.keyboard.press('ControlOrMeta+z')
      await page.keyboard.press('ControlOrMeta+z')
      await page.waitForTimeout(400)
      await expect(nodes(page), type).toHaveCount(count) // behind the studio, nothing was undone
      await page.keyboard.press('ControlOrMeta+Shift+z')
      await page.keyboard.press('ControlOrMeta+y')
      await page.waitForTimeout(400)
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click()
      await expect(page.getByTestId('studio-shell-dock'), type).toHaveCount(0)
      await expect(nodes(page), type).toHaveCount(count)
    }
  })

  test('typing ⌘Z in a studio text field is the field’s own undo', async ({ page }) => {
    const count = await twoNodes(page)
    const id = await nodes(page).first().getAttribute('data-id')
    await page.evaluate(nodeId => window.dispatchEvent(new CustomEvent('sailor:openGradientStudio', { detail: { nodeId } })), id)
    const box = page.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })
    await expect(box).toBeVisible({ timeout: 20_000 })
    await box.click()
    await box.pressSequentially('warm dusk')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(box).not.toHaveValue('warm dusk') // the browser undid the typing
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(nodes(page)).toHaveCount(count)
  })
})
