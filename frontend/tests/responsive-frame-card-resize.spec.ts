import { test, expect } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * A responsive Frame's card reshapes freely from its corner grip: the layout reflows, the label
 * shows the live viewing size while dragging, and a double-click on the grip returns it to the
 * design shape. A fixed Frame's grip still scales it at its aspect.
 */

const LAYERS = [
  { id: 'bg', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 1, h: 1, radius: 0,
    fill: { type: 'gradient', a: '#7c3aed', b: '#f472b6', textColor: '#fff', angle: 45, density: 8 }, stroke: '', strokeWidth: 0 },
  { id: 'dot', kind: 'ellipse', x: 0.8, y: 0.2, rotation: 0, opacity: 1, w: 0.25, h: 0.25, radius: 0,
    fill: { type: 'gradient', a: '#fde047', b: '#fde047', textColor: '#fff', angle: 0, density: 8 }, stroke: '', strokeWidth: 0 },
]

test('a responsive Frame card resizes freely and resets on double-click', async ({ page }) => {
  test.setTimeout(90_000)
  await waitForBackend(page)
  await page.setViewportSize({ width: 1600, height: 1400 })
  await openBlankWorkflow(page)

  await page.evaluate((layers) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: {
      nodeType: 'Compositor',
      widgetOverrides: { width: 1080, height: 1080 },
      propertyOverrides: { sailor_frame: { responsive: true }, sailor_localLayers: layers },
    } }))
  }, LAYERS)

  const card = page.locator('.vue-flow__node-artifact-frame').last()
  await expect(card).toBeVisible({ timeout: 10_000 })
  // Bring the whole card, grip included, on screen at a modest zoom.
  await page.evaluate(() => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.fitView === 'function')) c = c.parent
    c?.exposed.fitView({ maxZoom: 0.8, padding: 0.4 })
  })
  await page.waitForTimeout(500)
  const label = card.locator('.print-surface__size')
  await expect(label).toHaveText('Responsive')
  const canvas = card.getByTestId('frame-card-stack-canvas')
  const before = (await canvas.boundingBox())!
  expect(Math.abs(before.width - before.height)).toBeLessThan(2)

  const grip = card.locator('[title^="Resize"]')
  await expect(grip).toHaveAttribute('title', 'Resize — double-click to reset')
  const g = (await grip.boundingBox())!
  const gx = g.x + g.width / 2, gy = g.y + g.height / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 80, gy, { steps: 4 })
  await page.mouse.move(gx + 160, gy, { steps: 4 })
  // While dragging the label reads the live viewing size, wider than it is tall.
  await expect(label).toHaveText(/^Responsive · \d+ × 1080$/)
  await page.mouse.up()
  await expect(label).toHaveText('Responsive')

  const after = (await canvas.boundingBox())!
  expect(after.width).toBeGreaterThan(before.width + 100)
  expect(Math.abs(after.height - before.height)).toBeLessThan(2)

  // The reshaped card paints the reflowed layout, not a stretched square: the yellow dot keeps
  // its round shape, so its column of yellow pixels is about as tall as its row is wide.
  const dot = await canvas.evaluate((cv: HTMLCanvasElement) => {
    const ctx = cv.getContext('2d')!
    const { width: W, height: H } = cv
    const d = ctx.getImageData(0, 0, W, H).data
    const yellow = (i: number) => d[i]! > 220 && d[i + 1]! > 200 && d[i + 2]! < 140
    let minX = W, maxX = 0, minY = H, maxY = 0
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      if (yellow((y * W + x) * 4)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    }
    return { w: maxX - minX, h: maxY - minY }
  })
  expect(dot.w).toBeGreaterThan(10)
  expect(dot.w / dot.h).toBeGreaterThan(0.8)
  expect(dot.w / dot.h).toBeLessThan(1.25)

  // Double-click the grip: back to the design shape.
  const g2 = (await grip.boundingBox())!
  await page.mouse.dblclick(g2.x + g2.width / 2, g2.y + g2.height / 2)
  await expect.poll(async () => {
    const b = (await canvas.boundingBox())!
    return Math.abs(b.width - b.height) < 2
  }).toBe(true)
})

test('the Frame editor opens at the card\'s shape, and its size is the card\'s size', async ({ page }) => {
  test.setTimeout(120_000)
  await waitForBackend(page)
  await page.setViewportSize({ width: 1600, height: 1400 })
  await openBlankWorkflow(page)
  await page.evaluate((layers) => {
    window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: {
      nodeType: 'Compositor',
      widgetOverrides: { width: 1080, height: 1080 },
      propertyOverrides: { sailor_frame: { responsive: true }, sailor_localLayers: layers },
    } }))
  }, LAYERS)
  const card = page.locator('.vue-flow__node-artifact-frame').last()
  await expect(card).toBeVisible({ timeout: 10_000 })
  await page.evaluate(() => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.fitView === 'function')) c = c.parent
    c?.exposed.fitView({ maxZoom: 0.8, padding: 0.4 })
  })
  await page.waitForTimeout(500)

  // Reshape the card wide.
  const grip = card.locator('[title^="Resize"]')
  const g = (await grip.boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + g.width / 2 + 160, g.y + g.height / 2, { steps: 8 })
  await page.mouse.up()
  const cardCanvas = card.getByTestId('frame-card-stack-canvas')
  const cb = (await cardCanvas.boundingBox())!
  expect(cb.width / cb.height).toBeGreaterThan(1.3)

  // Open the editor: its artboard takes the card's shape and says so.
  await card.hover()
  await card.getByRole('button', { name: 'Open', exact: true }).click()
  const art = page.getByTestId('compositor-stack-canvas')
  await expect(art).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const b = (await art.boundingBox())!
    return Math.abs(b.width / b.height - cb.width / cb.height) < 0.05
  }, { timeout: 10_000 }).toBe(true)
  await expect(page.getByText('Viewing size', { exact: true })).toBeVisible()

  // Back to design size in the editor puts the card back to its design shape too.
  await page.getByRole('button', { name: 'Back to design size' }).click()
  await expect.poll(async () => {
    const b = (await art.boundingBox())!
    return Math.abs(b.width - b.height) < 3
  }).toBe(true)
  await page.keyboard.press('Escape')
  await expect(art).toBeHidden({ timeout: 10_000 })
  await expect.poll(async () => {
    const b = (await cardCanvas.boundingBox())!
    return Math.abs(b.width - b.height) < 2
  }).toBe(true)
})
