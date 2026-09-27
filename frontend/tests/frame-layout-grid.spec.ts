// frontend/tests/frame-layout-grid.spec.ts — the Frame's layout grid, driven with the real mouse.
import { test, expect, type Page } from '@playwright/test'

const props = (page: Page) => page.evaluate(() => (window as any).__frameLab.node.data.properties)
const frameLab = (page: Page) => page.evaluate(() => {
  const l = (window as any).__frameLab
  return { layoutGrid: l.layoutGrid, layoutGridResolved: l.layoutGridResolved, historyRev: l.editor?.historyRev?.() ?? null }
})

test.describe('Frame layout grid', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    // The lab fixture is pre-populated with layers, so `readLayoutGrid` defaults the
    // grid to hidden (spec: "Old Frames hidden"). Every test below exercises the
    // grid showing, so turn it on once, deterministically, before each one.
    const state = await frameLab(page)
    if (!state.layoutGrid.show) await page.locator('[data-testid="grid-show"] button[role="switch"]').click()
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toBeVisible()
  })

  test('the section sits under Frame; the overlay shows column lines and no red', async ({ page }) => {
    await expect(page.getByText('Layout grid', { exact: true })).toBeVisible()
    const overlay = page.locator('[data-testid="compositor-grid-overlay"]')
    await expect(overlay).toBeVisible()
    const html = await overlay.innerHTML()
    expect(html).not.toMatch(/255,\s*72,\s*96|#ff3ea5|#22d3ee/i)
  })

  test('clicking a layer selects it without showing modules or recording a step', async ({ page }) => {
    const before = (await frameLab(page)).historyRev
    const layer = page.locator('[data-testid="compositor-stack-canvas"]')
    const box = (await layer.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.locator('[data-testid="compositor-grid-modules"]')).not.toHaveClass(/\bon\b/)
    if (before != null) expect((await frameLab(page)).historyRev).toBe(before)
  })

  test('dragging fades the modules in and snaps an edge to a column edge', async ({ page }) => {
    const cv = page.locator('[data-testid="compositor-stack-canvas"]')
    const cvBox = (await cv.boundingBox())!

    // The isolated "strokecenter" rect fixture — no group, nothing else near it —
    // so its own left/right/centre edges are the only candidates the snap can pick.
    const before = await page.evaluate(() => {
      const l = (window as any).__frameLab.node.data.properties.sailor_localLayers
        .find((x: any) => x.id === 'strokecenter')
      return { x: l.x, y: l.y, w: l.w }
    })
    const grid = (await frameLab(page)).layoutGridResolved as { W: number; H: number; xs: number[] }
    const halfW = before.w / 2 // normalized (box width is layer.w * W, per localLayerBox)

    // Pick a column edge far enough from the layer's current left edge to make a
    // real drag, but that keeps the layer's centre inside the frame once moved.
    const curLeftPx = (before.x - halfW) * grid.W
    let targetX: number | null = null
    for (const x of grid.xs) {
      const newX = x / grid.W + halfW
      if (newX < 0.08 || newX > 0.92) continue
      if (Math.abs(x - curLeftPx) < 24) continue // want a real drag, not a no-op
      if (targetX == null || Math.abs(x - curLeftPx) < Math.abs(targetX - curLeftPx)) targetX = x
    }
    expect(targetX).not.toBeNull()
    const newXNorm = targetX! / grid.W + halfW
    const dxNorm = newXNorm - before.x

    const sx = cvBox.x + before.x * cvBox.width
    const sy = cvBox.y + before.y * cvBox.height
    const dxPx = dxNorm * cvBox.width

    await page.mouse.move(sx, sy)
    await page.mouse.down()
    // A press is a click until it travels 4 screen px (MOVE_SLOP_PX) — this first
    // move must clear that before the modules can fade in.
    await page.mouse.move(sx + Math.sign(dxPx) * 8, sy, { steps: 2 })
    await page.mouse.move(sx + dxPx, sy, { steps: 8 })
    await expect(page.locator('[data-testid="compositor-grid-modules"]')).toHaveClass(/\bon\b/)
    await page.mouse.up()

    const after = await page.evaluate(() => {
      const l = (window as any).__frameLab.node.data.properties.sailor_localLayers
        .find((x: any) => x.id === 'strokecenter')
      return { x: l.x }
    })
    const leftEdgePx = (after.x - halfW) * grid.W
    const nearest = grid.xs.reduce((best, x) => Math.abs(x - leftEdgePx) < Math.abs(best - leftEdgePx) ? x : best, grid.xs[0])
    expect(Math.abs(nearest - leftEdgePx)).toBeLessThan(0.5)
  })

  test('⌃G hides the grid and ⌘Z brings it back', async ({ page }) => {
    await page.keyboard.press('Control+g')
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toHaveCount(0)
    await page.keyboard.press('Meta+z')
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toBeVisible()
  })

  test('changing the column count is undoable', async ({ page }) => {
    const field = page.locator('[data-testid="grid-columns"] input, input[data-testid="grid-columns"]').first()
    await field.fill('6'); await field.press('Enter'); await field.blur()
    expect((await props(page)).sailor_layoutGrid.cols.count).toBe(6)
    await page.keyboard.press('Meta+z')
    expect((await props(page)).sailor_layoutGrid.cols.count).not.toBe(6)
  })
})
