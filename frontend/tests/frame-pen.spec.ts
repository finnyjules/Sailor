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

// ── Task 8: double-click a drawn path to reopen the pen on the layer itself ──

type Box = { x: number; y: number; width: number; height: number }

/** A sketch point (drawing units, 100 per local unit) → screen px, through the
 *  layer's own draw transform: T(x·W, y·H)·R(rot)·Sh(skew)·S(scale·W), with
 *  W×H the artboard (the pen overlay's on-screen box). */
function sketchToScreen(l: any, p: { x: number; y: number }, box: Box) {
  const W = box.width, H = box.height
  const s = (l.scale || 1) * W / 100
  let vx = p.x * s, vy = p.y * s
  const tx = Math.tan(((l.skewX || 0) * Math.PI) / 180), ty = Math.tan(((l.skewY || 0) * Math.PI) / 180)
  ;[vx, vy] = [vx + tx * vy, ty * vx + vy]
  const r = ((l.rotation || 0) * Math.PI) / 180
  const c = Math.cos(r), sn = Math.sin(r)
  return { x: box.x + l.x * W + c * vx - sn * vy, y: box.y + l.y * H + sn * vx + c * vy }
}
/** The closed path's anchor points (id + drawing coords), in path order. */
function corners(l: any): { id: string; x: number; y: number }[] {
  const path = l.sketch.entities.find((e: any) => e.kind === 'path' && e.closed)
  return path.anchors.map((id: string) => {
    const p = l.sketch.entities.find((e: any) => e.id === id)
    return { id, x: p.x, y: p.y }
  })
}
async function dotCentre(page: Page, id: string) {
  const b = await overlay(page).locator(`circle[data-point="${id}"]`).boundingBox()
  if (!b) throw new Error(`no dot for ${id}`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 3) =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8)
  }
  await page.mouse.up()
}

/** Draw a closed triangle with the Frame's pen (Task 7 flow); returns the new layer. */
async function drawTriangle(page: Page) {
  const before = await layers(page)
  const box = await openPen(page)
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const pts = [{ x: cx - 90, y: cy - 50 }, { x: cx + 70, y: cy - 60 }, { x: cx - 10, y: cy + 80 }]
  for (const p of [...pts, pts[0]]) {
    await page.mouse.move(p.x, p.y)
    await page.mouse.down(); await page.mouse.up()
  }
  await page.keyboard.press('Enter')
  await expect(penToolbar(page)).toBeHidden()
  const after = await layers(page)
  const tri = after.find((l: any) => !before.some((b: any) => b.id === l.id))
  expect(tri?.kind).toBe('path')
  return { tri, box }
}
const layerById = async (page: Page, id: string) => (await layers(page)).find((l: any) => l.id === id)
/** Double-click the layer at its outline's centroid (inside the filled triangle). */
async function dblclickLayer(page: Page, l: any, box: Box) {
  const cs = corners(l)
  const c = sketchToScreen(l, { x: cs.reduce((a, p) => a + p.x, 0) / cs.length, y: cs.reduce((a, p) => a + p.y, 0) / cs.length }, box)
  await page.mouse.dblclick(c.x, c.y)
}

test.describe('Frame pen — reopen a drawn path', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await expect(penButton(page)).toBeVisible()
  })

  test('double-click reopens the pen on the layer; a drag previews live; Enter commits one undo step', async ({ page }) => {
    const { tri, box } = await drawTriangle(page)

    await dblclickLayer(page, tri, box)
    await expect(penToolbar(page)).toBeVisible()
    await expect(page.getByText('Done (Esc)', { exact: true })).toHaveCount(0)
    const cs = corners(tri)
    await expect(penPoints(page)).toHaveCount(3)
    for (const c of cs) expect(near(await dotCentre(page, c.id), sketchToScreen(tri, c, box))).toBe(true)

    // drag one corner: the layer's own d changes live, x/y/bbox stay put
    const from = sketchToScreen(tri, cs[1], box)
    const to = { x: from.x + 40, y: from.y + 30 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (40 * i) / 8, from.y + (30 * i) / 8)
    const mid = await layerById(page, tri.id)
    expect(mid.d).not.toBe(tri.d)
    expect(mid.x).toBe(tri.x); expect(mid.y).toBe(tri.y); expect(mid.bbox).toEqual(tri.bbox)
    await page.mouse.up()

    await page.keyboard.press('Enter')
    await expect(penToolbar(page)).toBeHidden()
    const done = await layerById(page, tri.id)
    expect(done.x === tri.x && done.y === tri.y).toBe(false)
    expect(done.bbox).not.toEqual(tri.bbox)
    const moved = corners(done).find(c => c.id === cs[1].id)!
    expect(near(sketchToScreen(done, moved, box), to)).toBe(true)
    // the other two corners did not move on screen (re-centring keeps it planted)
    for (const c of [cs[0], cs[2]]) {
      const now = corners(done).find(k => k.id === c.id)!
      expect(near(sketchToScreen(done, now, box), sketchToScreen(tri, c, box))).toBe(true)
    }

    // one ⌘Z (pen closed) restores the triangle exactly
    await page.keyboard.press(`${META}+z`)
    await expect.poll(async () => JSON.stringify(await layerById(page, tri.id))).toBe(JSON.stringify(tri))
  })

  test('a rotated, scaled layer: the dragged corner lands on the screen point', async ({ page }) => {
    const { tri, box } = await drawTriangle(page)
    await page.evaluate((id) => {
      const w = window as any
      w.__compositorSetLayers(w.__compositorLayers().map((l: any) => (l.id === id ? { ...l, rotation: 35, scale: 1.4 } : l)))
    }, tri.id)
    const rot = await layerById(page, tri.id)
    expect(rot.rotation).toBe(35)

    await dblclickLayer(page, rot, box)
    await expect(penToolbar(page)).toBeVisible()
    const cs = corners(rot)
    for (const c of cs) expect(near(await dotCentre(page, c.id), sketchToScreen(rot, c, box))).toBe(true)

    const from = sketchToScreen(rot, cs[0], box)
    const target = { x: Math.round(from.x - 35), y: Math.round(from.y + 25) }
    await drag(page, from, target)
    await page.keyboard.press('Enter')
    await expect(penToolbar(page)).toBeHidden()
    const done = await layerById(page, tri.id)
    expect(done.rotation).toBe(35); expect(done.scale).toBe(1.4)
    const moved = corners(done).find(c => c.id === cs[0].id)!
    expect(near(sketchToScreen(done, moved, box), target)).toBe(true)
  })

  test('Escape during an edit puts the layer back byte for byte', async ({ page }) => {
    const { tri, box } = await drawTriangle(page)
    await dblclickLayer(page, tri, box)
    await expect(penToolbar(page)).toBeVisible()
    const cs = corners(tri)
    const from = sketchToScreen(tri, cs[2], box)
    await drag(page, from, { x: from.x + 50, y: from.y - 20 })
    expect((await layerById(page, tri.id)).d).not.toBe(tri.d)
    for (let i = 0; i < 4 && await penToolbar(page).isVisible(); i++) await page.keyboard.press('Escape')
    await expect(penToolbar(page)).toBeHidden()
    await expect(page.locator('[data-testid="compositor-stage"]')).toBeVisible()
    const back = await layerById(page, tri.id)
    expect(back.d).toBe(tri.d)
    expect(JSON.stringify(back.sketch)).toBe(JSON.stringify(tri.sketch))
    expect(JSON.stringify(back)).toBe(JSON.stringify(tri))
  })

  test('a path without a drawing opens the point editor, not the pen', async ({ page }) => {
    const { tri, box } = await drawTriangle(page)
    // the same outline as a plain (library-style) path: no sketch
    await page.evaluate((id) => {
      const w = window as any
      w.__compositorSetLayers(w.__compositorLayers().map((l: any) => {
        if (l.id !== id) return l
        const { sketch: _s, ...rest } = l
        return rest
      }))
    }, tri.id)
    expect((await layerById(page, tri.id)).sketch).toBeUndefined()
    await dblclickLayer(page, tri, box)
    await expect(page.getByText('Done (Esc)', { exact: true })).toBeVisible()
    await expect(penToolbar(page)).toHaveCount(0)
  })

  test('a corner-pinned drawn path opens the point editor, not the pen', async ({ page }) => {
    const { tri, box } = await drawTriangle(page)
    await page.evaluate((id) => {
      const w = window as any
      const pin = { tl: { x: 0.1, y: 0 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } }
      w.__compositorSetLayers(w.__compositorLayers().map((l: any) => (l.id === id ? { ...l, cornerPin: pin } : l)))
    }, tri.id)
    await dblclickLayer(page, tri, box)
    await expect(page.getByText('Done (Esc)', { exact: true })).toBeVisible()
    await expect(penToolbar(page)).toHaveCount(0)
  })
})
