import { expect, test, type Locator, type Page } from '@playwright/test'
import { dropNode, openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * Content cards (node design stage 4, task 9): every card renders `ContentCard`
 * (frontend/app/components/vue-canvas/surfaces/ContentCard.vue) with a name row
 * above a media box, floating actions that only show on hover/selection, and a
 * selection outline drawn on the media box itself — not on the card root. This
 * spec proves that contract on Image, Video, Audio, Text and Collection cards,
 * plus the More menu on an Image card, and (owed from Task 5) that dragging
 * inside a 3D card's viewer stage never moves the node.
 */

const svg = (fill: string) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='40'><rect width='64' height='40' fill='${encodeURIComponent(fill)}'/></svg>`

async function addNode(page: Page, nodeType: string, dataOverrides?: Record<string, unknown>) {
  await page.evaluate(({ nodeType, dataOverrides }) =>
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: { nodeType, dataOverrides } })),
    { nodeType, dataOverrides })
  await page.waitForTimeout(300)
}

/** Click empty canvas pane to deselect, away from the node and any top-left chrome. */
async function deselect(page: Page, node: Locator) {
  const bb = (await node.boundingBox())!
  const vp = page.viewportSize()!
  const x = Math.max(bb.x - 40, 5)
  const y = Math.min(bb.y + bb.height + 40, vp.height - 10)
  await page.mouse.click(x, y)
}

const outlineStyle = (loc: Locator) => loc.evaluate(el => getComputedStyle(el).outlineStyle)
const opacityAndPE = (loc: Locator) => loc.evaluate(el => {
  const s = getComputedStyle(el)
  return { opacity: s.opacity, pe: s.pointerEvents }
})

/**
 * The four content-card behaviors from the brief, run against one already-visible
 * node. Selects by clicking `.content-card__name` (not the media, which for an
 * empty Video/Audio card is a file-upload button that would open a chooser).
 */
async function checkCardBehaviors(page: Page, node: Locator) {
  await deselect(page, node)
  const name = node.locator('.content-card__name')
  const media = node.locator('.content-card__media')
  const actions = node.locator('.node-float-actions')
  const root = node.locator('.content-card')

  await expect(name).toBeVisible()
  await expect(media).toBeVisible()

  // 1. Name row sits above the media box.
  const nb = (await name.boundingBox())!
  const mb = (await media.boundingBox())!
  expect(nb.y + nb.height).toBeLessThanOrEqual(mb.y + 1)

  // 2. Floating actions are hidden at rest, shown on hovering the media.
  const rest = await opacityAndPE(actions)
  expect(rest.opacity).toBe('0')
  expect(rest.pe).toBe('none')
  await media.hover()
  await expect.poll(async () => (await opacityAndPE(actions)).opacity).toBe('1')
  expect((await opacityAndPE(actions)).pe).toBe('auto')
  await page.mouse.move(5, 5)

  // 3. Selecting (via the name row) draws the outline on the media box, never the root.
  await name.click()
  await expect.poll(() => outlineStyle(media)).toBe('solid')
  expect(await outlineStyle(root)).not.toBe('solid')
}

test.describe('Content cards', () => {
  test.beforeEach(async ({ page }) => {
    page.on('filechooser', async () => { /* swallow empty Video/Audio upload dialogs */ })
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await expect(page.locator('.vue-flow__node')).toHaveCount(0)
  })

  test('Image card (with a picture): name above media, actions on hover, outline on the media, More menu', async ({ page }) => {
    await addNode(page, 'Image', { images: [svg('#4477ff')] })
    const node = page.locator('.vue-flow__node-artifact-image')
    await expect(node).toBeVisible()
    await checkCardBehaviors(page, node)

    // 4. The More menu (open on the selected — hence visible — card) lists the
    // items that apply to a card with an uploaded, unlocked, unwired picture.
    await node.getByRole('button', { name: 'More' }).click()
    const menu = node.getByRole('menu')
    await expect(menu).toBeVisible()
    for (const label of ['Replace image', 'Lock', 'Re-render', 'Save as character', 'Name as reference']) {
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
    }
  })

  test('Video card (empty): name above media, actions on hover, outline on the media', async ({ page }) => {
    await addNode(page, 'Video')
    const node = page.locator('.vue-flow__node-artifact-video')
    await expect(node).toBeVisible()
    await checkCardBehaviors(page, node)
  })

  test('Audio card (empty): name above media, actions on hover, outline on the media', async ({ page }) => {
    await addNode(page, 'Audio')
    const node = page.locator('.vue-flow__node-artifact-audio')
    await expect(node).toBeVisible()
    await checkCardBehaviors(page, node)
  })

  test('Text card: name above media, actions on hover, outline on the media', async ({ page }) => {
    await addNode(page, 'Text')
    const node = page.locator('.vue-flow__node-artifact-text')
    await expect(node).toBeVisible()
    await checkCardBehaviors(page, node)
  })

  test('Collection card: name above media, actions on hover, outline on the media', async ({ page }) => {
    await addNode(page, 'Collection')
    const node = page.locator('.vue-flow__node-collection')
    await expect(node).toBeVisible()
    await checkCardBehaviors(page, node)
  })

  // Owed from Task 5: the 3D card's viewer stage lives in the media box, and orbiting
  // inside it (a mouse drag) must never move the node itself.
  test('3D model card: the media box holds the viewer stage; dragging inside it does not move the node', async ({ page }) => {
    await addNode(page, 'Model3D')
    const node = page.locator('.vue-flow__node-artifact-3d')
    await expect(node).toBeVisible()
    const media = node.locator('.content-card__media')
    const stage = media.locator('.nopan.nodrag')
    await expect(stage).toHaveCount(1)

    const before = (await node.boundingBox())!
    const sb = (await stage.boundingBox())!
    const cx = sb.x + sb.width / 2
    const cy = sb.y + sb.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 60, cy, { steps: 10 })
    await page.mouse.up()
    const after = (await node.boundingBox())!
    expect(Math.abs(after.x - before.x)).toBeLessThan(2)
    expect(Math.abs(after.y - before.y)).toBeLessThan(2)
  })
})
