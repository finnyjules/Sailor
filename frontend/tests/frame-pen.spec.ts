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

  test('the pen toolbar takes real clicks (its bar sits in a click-through column)', async ({ page }) => {
    await openPen(page)
    for (const tool of ['line', 'circle', 'trim', 'select']) {
      const btn = page.locator(`[data-tool="${tool}"]`)
      const b = await btn.boundingBox()
      if (!b) throw new Error(`no ${tool} button`)
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
      await expect(btn).toHaveAttribute('aria-pressed', 'true')
    }
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

  test('paste, a file drop and the Frame\'s right-click menu do nothing while the pen is open; each works again once it closes', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const all = await layers(page)
    const pic = all.find((l: any) => l.kind === 'image')
    const rect = all.find((l: any) => l.kind === 'rect')
    expect(pic && rect).toBeTruthy()
    // the image alone on the frame, so a right-click at its centre hits it
    await page.evaluate((l) => (window as any).__compositorSetLayers([l]), pic)
    await expect.poll(async () => (await layers(page)).length).toBe(1)
    const before = await layers(page)
    // Sailor layer JSON, the OS-clipboard format a copy writes (layerClipboard.ts)
    const json = JSON.stringify({ __sailor: 'sailor.compositor.layers', version: 1, payload: { layers: [rect], groups: [] } })
    await page.evaluate((t) => navigator.clipboard.writeText(t), json)
    const dispatchPaste = () => page.evaluate((t) => {
      const dt = new DataTransfer(); dt.setData('text/plain', t)
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, json)
    const dropSvg = async () => {
      const dt = await page.evaluateHandle(() => {
        const d = new DataTransfer()
        d.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'], 'drop.svg', { type: 'image/svg+xml' }))
        return d
      })
      await page.dispatchEvent('[data-testid="compositor-stage"]', 'dragover', { dataTransfer: dt })
      await page.dispatchEvent('[data-testid="compositor-stage"]', 'drop', { dataTransfer: dt })
    }
    const menu = page.getByText('Edit image…', { exact: true })

    // ── the pen open, one point placed ──
    const box = await openPen(page)
    await page.mouse.move(box.x + 40, box.y + 40)
    await page.mouse.down(); await page.mouse.up()
    await expect(penPoints(page)).toHaveCount(1)
    const firstId = await penPoints(page).first().getAttribute('data-point')
    const picAt = { x: box.x + pic.x * box.width, y: box.y + pic.y * box.height }

    // ⌘ combos the pen does not use are still the pen's: the browser's own action
    // (⌘S save page, ⌘D bookmark, ⌘G find next) is default-prevented. A window
    // capture listener added after the Frame's runs after it, so it sees the verdict.
    await page.evaluate(() => {
      (window as any).__penKeyLog = []
      window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key !== 'Meta' && e.key !== 'Control') (window as any).__penKeyLog.push([e.key, e.defaultPrevented]) }, true)
    })
    for (const k of ['s', 'd', 'g']) await page.keyboard.press(`${META}+${k}`)
    expect(await page.evaluate(() => (window as any).__penKeyLog)).toEqual([['s', true], ['d', true], ['g', true]])
    await expect(penToolbar(page)).toBeVisible()
    await expect(penPoints(page)).toHaveCount(1)

    // (a) paste: a real ⌘V with layer JSON on the clipboard, then a paste event itself
    await page.keyboard.press(`${META}+v`)
    await dispatchPaste()
    // (b) right-click on the image layer: the pen's own menu opens, never the image's
    await page.mouse.click(picAt.x, picAt.y, { button: 'right' })
    // (c) a dropped file
    await dropSvg()
    await page.waitForTimeout(300)   // let any async import (paste / drop) land

    expect(await layers(page)).toEqual(before)
    await expect(menu).toHaveCount(0)
    await expect(penToolbar(page)).toBeVisible()
    await expect(overlay(page).locator(`circle[data-point="${firstId}"]`)).toHaveCount(1)
    await expect(page.locator('[data-pen-menu]')).toBeVisible()
    await page.keyboard.press('Escape')                       // closes the pen's menu; the pen stays open
    await expect(page.locator('[data-pen-menu]')).toHaveCount(0)
    await expect(penToolbar(page)).toBeVisible()

    // ── controls: with the pen closed, the same routes do act ──
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
    await expect(penToolbar(page)).toBeHidden()
    expect(await layers(page)).toEqual(before)
    await page.mouse.click(picAt.x, picAt.y, { button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await page.mouse.click(box.x + 5, box.y + box.height - 5)   // focus the stage, nothing selected
    await page.keyboard.press(`${META}+v`)
    await expect.poll(async () => (await layers(page)).length).toBe(before.length + 1)
    await dispatchPaste()
    await expect.poll(async () => (await layers(page)).length).toBe(before.length + 2)
    await dropSvg()
    await expect.poll(async () => (await layers(page)).length).toBe(before.length + 3)
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

  test('opening a drawn path and leaving without an edit leaves no undo step', async ({ page }) => {
    // ⌘Z presses until the layer is gone (undoing its own drawing)
    const undosToRemove = async (id: string) => {
      for (let n = 1; n <= 10; n++) {
        await page.keyboard.press(`${META}+z`)
        await page.waitForTimeout(50)
        if (!(await layerById(page, id))) return n
      }
      return Infinity
    }
    // control: the same two presses on the layer, far enough apart not to be a double-click
    const a = await drawTriangle(page)
    const ca = sketchToScreen(a.tri, corners(a.tri).reduce((m, p) => ({ x: m.x + p.x / 3, y: m.y + p.y / 3 }), { x: 0, y: 0 }), a.box)
    await page.mouse.click(ca.x, ca.y)
    await page.waitForTimeout(700)
    await page.mouse.click(ca.x, ca.y)
    const control = await undosToRemove(a.tri.id)
    expect(control).toBeLessThan(Infinity)

    // double-click → Esc: the pen adds nothing to undo
    const b = await drawTriangle(page)
    await dblclickLayer(page, b.tri, b.box)
    await expect(penToolbar(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(penToolbar(page)).toBeHidden()
    expect(JSON.stringify(await layerById(page, b.tri.id))).toBe(JSON.stringify(b.tri))
    expect(await undosToRemove(b.tri.id)).toBe(control)

    // double-click → Enter with no edit: nothing written, nothing recorded
    const c = await drawTriangle(page)
    await dblclickLayer(page, c.tri, c.box)
    await expect(penToolbar(page)).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(penToolbar(page)).toBeHidden()
    expect(JSON.stringify(await layerById(page, c.tri.id))).toBe(JSON.stringify(c.tri))
    expect(await undosToRemove(c.tri.id)).toBe(control)
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

// ── Task 9: a text layer's "Drawn path" guide, drawn and edited with the shared pen ──

test.describe('Frame pen — a text layer\'s drawn path', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await expect(penButton(page)).toBeVisible()
  })

  const guideButton = (page: Page) => page.locator('button:has-text("Draw a path"), button:has-text("Edit the path")').first()
  const textByName = async (page: Page, text: string) => (await layers(page)).find((l: any) => l.kind === 'text' && l.text === text)
  /** The guide's start point on screen, as the text layer renders it (the real
   *  textPath engine, loaded from the dev server), with W = the artboard's on-screen width. */
  const guideStartOnScreen = (page: Page, t: any, box: Box) => page.evaluate(async ({ t, box }) => {
    const mod: any = await import(/* @vite-ignore */ '/_nuxt/lib/compositor/textPath.ts')
    const W = box.width, H = box.height
    const g = mod.guideFromSpec(t.path, W, 100).at(0)
    const tx = Math.tan(((t.skewX || 0) * Math.PI) / 180), ty = Math.tan(((t.skewY || 0) * Math.PI) / 180)
    const vx = g.x + tx * g.y, vy = ty * g.x + g.y
    const r = ((t.rotation || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
    return { x: box.x + t.x * W + c * vx - s * vy, y: box.y + t.y * H + s * vx + c * vy }
  }, { t, box })
  const anchorsOf = (t: any): string[] => t.path.sketch.entities.find((e: any) => e.kind === 'path').anchors
  async function commitWithEnter(page: Page) {
    for (let i = 0; i < 3 && await penToolbar(page).isVisible(); i++) await page.keyboard.press('Enter')
    await expect(penToolbar(page)).toBeHidden()
  }

  test('draw a guide live, edit it, resize it, edit again; Escape restores', async ({ page }) => {
    // ── select "Plain text", Follow a path → Drawn path ──
    await page.locator('[title="Double-click to rename"]', { hasText: /Plain text/ }).first().click()
    const follow = page.locator('div:has(> .panel-label:text-is("Follow a path")) > select').first()
    await follow.selectOption('custom')
    await expect(guideButton(page)).toHaveText(/Draw a path/)
    const t0 = await textByName(page, 'Plain text')
    expect(t0.path.follow).toBe('custom')
    expect(t0.path.d).toBeFalsy()

    // ── "Draw a path": the open-only pen ──
    await guideButton(page).click()
    await expect(penToolbar(page)).toBeVisible()
    await expect(page.locator('[data-act="close"]')).toHaveCount(0)
    await expect(page.locator('[data-tool="circle"]')).toHaveCount(0)
    await expect(page.locator('[data-tool="curve"]')).toHaveCount(1)
    const box = (await overlay(page).boundingBox())!

    // click, then click-drag to bow; mid-drag the guide is already live
    const p0 = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 }
    const p1 = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.34 }
    await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.up()
    await expect(penPoints(page)).toHaveCount(1)

    // the pen owns the text while it is open: the pen's Properties take the right
    // panel's body (pen stage 6), so the text's placement fields, Follow a path,
    // Path size and the panel's own path button are not there to change it
    const rotationInput = page.locator('div:has(> .panel-label:text-is("Rotation")) input').first()
    const alignButton = page.locator('fieldset:has(> .panel-label:text-is("Align to frame")) button').first()
    const sizeField = page.locator('div:has(> .panel-label:text-is("Path size")) input').first()
    const distort = page.locator('[data-testid="distort-fields"]')
    await expect(page.getByTestId('frame-pen-properties')).toBeVisible()
    for (const f of [rotationInput, alignButton, follow, sizeField, distort, guideButton(page)]) await expect(f).toHaveCount(0)
    await expect(penToolbar(page)).toBeVisible()
    await expect(penPoints(page)).toHaveCount(1)

    await page.mouse.move(p1.x, p1.y); await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(p1.x + 5 * i, p1.y + 6 * i)
    const live = await textByName(page, 'Plain text')
    expect(typeof live.path.d).toBe('string')
    expect(live.path.d.length).toBeGreaterThan(0)
    await page.mouse.up()
    await commitWithEnter(page)

    const t1 = await textByName(page, 'Plain text')
    expect(t1.path.follow).toBe('custom')
    expect(t1.path.sketch).toBeTruthy()
    expect(t1.path.d.length).toBeGreaterThan(0)
    const expectD = await page.evaluate(async (sk) => {
      const mod: any = await import(/* @vite-ignore */ '/_nuxt/lib/compositor/penFrame.ts')
      return mod.sketchToLocalD(sk)
    }, t1.path.sketch)
    expect(t1.path.d).toBe(expectD)
    await expect(guideButton(page)).toHaveText(/Edit the path/)
    await expect(rotationInput).toBeEnabled()
    await expect(follow).toBeEnabled()
    // what you see is what you get: the type's guide starts where the first click landed
    expect(near(await guideStartOnScreen(page, t1, box), p0)).toBe(true)

    // ── "Edit the path": the first dot sits where the first click landed; drag the end point ──
    await guideButton(page).click()
    await expect(penToolbar(page)).toBeVisible()
    const ids = anchorsOf(t1)
    expect(near(await dotCentre(page, ids[0]), p0)).toBe(true)
    const end = await dotCentre(page, ids[ids.length - 1])
    await drag(page, end, { x: end.x + 30, y: end.y + 40 })
    await commitWithEnter(page)
    const t2 = await textByName(page, 'Plain text')
    expect(t2.path.d).not.toBe(t1.path.d)
    expect(near(await guideStartOnScreen(page, t2, box), p0)).toBe(true)   // the start stayed put

    // ── change Path size in the panel, then edit again: the dots sit on the resized guide ──
    const sizeInput = page.locator('div:has(> .panel-label:text-is("Path size")) input').first()
    const cur = parseFloat(await sizeInput.inputValue())
    await sizeInput.fill(String(Math.round(cur * 1.6)))
    await expect.poll(async () => (await textByName(page, 'Plain text')).path.size).not.toBe(t2.path.size)
    const t3 = await textByName(page, 'Plain text')
    await guideButton(page).click()
    await expect(penToolbar(page)).toBeVisible()
    const start3 = await guideStartOnScreen(page, t3, box)
    expect(near(start3, p0, 3)).toBe(false)   // the resize really moved the guide's start
    expect(near(await dotCentre(page, ids[0]), start3)).toBe(true)

    // ── Escape while editing: path (and position) restored exactly ──
    const mid = await dotCentre(page, ids[1])
    await drag(page, mid, { x: mid.x - 25, y: mid.y + 35 })
    expect((await textByName(page, 'Plain text')).path.d).not.toBe(t3.path.d)
    for (let i = 0; i < 4 && await penToolbar(page).isVisible(); i++) await page.keyboard.press('Escape')
    await expect(penToolbar(page)).toBeHidden()
    await expect(page.locator('[data-testid="compositor-stage"]')).toBeVisible()
    const back = await textByName(page, 'Plain text')
    expect(JSON.stringify(back.path)).toBe(JSON.stringify(t3.path))
    expect(back.x).toBe(t3.x); expect(back.y).toBe(t3.y)
  })
})
