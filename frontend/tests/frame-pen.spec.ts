import { test, expect, type Page } from '@playwright/test'

// The Frame's pen tool draws with the shared pen (Plan B, Task 7). Every
// gesture and key here is real input (page.mouse / page.keyboard); the layer
// list is read through the Frame's dev hook `window.__compositorLayers()`.

const META = process.platform === 'darwin' ? 'Meta' : 'Control'

const layers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers() as any[])

// the Frame toolbar's pen button (its title starts with "Pen"; the pen
// toolbar's own Pen tool is a [data-tool] button)
const penButton = (page: Page) => page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first()
const penToolbar = (page: Page) => page.locator('[data-tool="path"]')
// the pen overlay: the one svg in the artboard that holds pen points / the drawing
const overlay = (page: Page) => page.locator('[data-testid="frame-pen-overlay"]')
const penPoints = (page: Page) => overlay(page).locator('circle[data-point]')

async function openPen(page: Page) {
  await penButton(page).click()
  await expect(penToolbar(page)).toBeVisible()
  await expect(overlay(page)).toBeVisible()
  const box = await overlay(page).boundingBox()
  if (!box) throw new Error('no pen overlay box')
  return box
}

test.describe('Frame pen (shared pen)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await expect(penButton(page)).toBeVisible()
  })

  test('draws a closed shape into a path layer that remembers its drawing; keys stay the pen\'s', async ({ page }) => {
    const before = await layers(page)

    // ── open: the pen toolbar replaces the Frame's own tool row ──
    const box = await openPen(page)
    await expect(penButton(page)).toBeHidden()
    await expect(page.locator('[data-testid="zoom-menu-toggle"]')).toBeHidden()

    // ── three points, then click the first to close; Enter commits ──
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2
    const pts = [
      { x: cx - 90, y: cy - 50 },
      { x: cx + 70, y: cy - 60 },
      { x: cx - 10, y: cy + 80 },
    ]
    for (const p of pts) {
      await page.mouse.move(p.x, p.y)
      await page.mouse.down(); await page.mouse.up()
    }
    await expect(penPoints(page)).toHaveCount(3)
    await page.mouse.move(pts[0].x, pts[0].y)
    await page.mouse.down(); await page.mouse.up()
    await page.keyboard.press('Enter')

    await expect(penToolbar(page)).toBeHidden()
    await expect(penButton(page)).toBeVisible()
    const after = await layers(page)
    expect(after.length).toBe(before.length + 1)
    const added = after.find((l: any) => !before.some((b: any) => b.id === l.id))
    expect(added.kind).toBe('path')
    expect(added.sketch).toBeTruthy()
    expect(added.sketch.entities.length).toBeGreaterThanOrEqual(4)
    expect(added.sketch.entities.some((e: any) => e.kind === 'path' && e.closed)).toBe(true)
    expect(added.fill).toBe('#3b82f6')
    expect(typeof added.d).toBe('string')
    expect(added.d.length).toBeGreaterThan(0)
    // on screen, the layer's centre (its outline bbox centre — the drawing is
    // re-centred on commit) sits at the centre of the clicked points' bbox
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
    const wantX = (Math.min(...xs) + Math.max(...xs)) / 2
    const wantY = (Math.min(...ys) + Math.max(...ys)) / 2
    const gotX = box.x + added.x * box.width
    const gotY = box.y + added.y * box.height
    expect(Math.abs(gotX - wantX)).toBeLessThanOrEqual(3)
    expect(Math.abs(gotY - wantY)).toBeLessThanOrEqual(3)

    // ── Escape twice: the pen closes, the modal stays, nothing written ──
    const box2 = await openPen(page)
    await page.mouse.move(box2.x + 60, box2.y + 60)
    await page.mouse.down(); await page.mouse.up()
    await expect(penPoints(page)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(penToolbar(page)).toBeHidden()
    await expect(page.locator('[data-testid="compositor-stage"]')).toBeVisible()
    await expect(penButton(page)).toBeVisible()
    expect((await layers(page)).length).toBe(after.length)

    // ── Delete with the pen open: no layer is deleted — not with nothing
    // selected, and not after picking the drawn layer in the Layers panel ──
    await openPen(page)
    await page.keyboard.press('Delete')
    await page.keyboard.press('Backspace')
    await page.locator('[title="Double-click to rename"]', { hasText: /^\s*path\s*$/i }).first().click()
    await expect(penToolbar(page)).toBeVisible()
    await expect(page.getByText('No selection', { exact: true })).toBeHidden()   // the drawn layer is selected
    await page.keyboard.press('Delete')
    await page.keyboard.press('Backspace')
    const afterDelete = await layers(page)
    expect(afterDelete.length).toBe(after.length)
    expect(afterDelete.some((l: any) => l.id === added.id)).toBe(true)

    // ── ⌘Z with the pen open: the pen's drawing steps back, the Frame's doesn't ──
    const box3 = (await overlay(page).boundingBox())!
    await page.mouse.move(box3.x + 80, box3.y + 80)
    await page.mouse.down(); await page.mouse.up()
    await page.mouse.move(box3.x + 200, box3.y + 90)
    await page.mouse.down(); await page.mouse.up()
    const n = await penPoints(page).count()
    expect(n).toBe(2)
    const framesBefore = await layers(page)
    await page.keyboard.press(`${META}+z`)
    await expect.poll(() => penPoints(page).count()).toBeLessThan(n)
    expect(await layers(page)).toEqual(framesBefore)
    await expect(penToolbar(page)).toBeVisible()   // still drawing; the modal did not react
  })

  test('switching to the Motion tab closes the pen; Space is no longer the pen\'s', async ({ page }) => {
    const before = await layers(page)
    const box = await openPen(page)
    await page.mouse.move(box.x + 70, box.y + 70)
    await page.mouse.down(); await page.mouse.up()
    await expect(penPoints(page)).toHaveCount(1)
    await page.getByRole('button', { name: 'Motion', exact: true }).click()
    await expect(penToolbar(page)).toHaveCount(0)
    await expect(overlay(page)).toHaveCount(0)
    await page.keyboard.press('Space')   // Motion's play/pause — no pen session left to swallow it
    await page.keyboard.press('Space')
    await expect(penToolbar(page)).toHaveCount(0)
    expect((await layers(page)).length).toBe(before.length)
    await page.getByRole('button', { name: 'Design', exact: true }).click()
    await expect(penButton(page)).toBeVisible()
    await expect(penToolbar(page)).toHaveCount(0)
    expect((await layers(page)).length).toBe(before.length)
  })
})
