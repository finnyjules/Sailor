// tests/pen-cleanup.spec.ts
// Pen stage 5 — Clean up — with the REAL mouse and keyboard: the owner's
// trimmed flower (petals as separate open pieces whose ends nearly meet)
// previewed and joined into one closed loop in one undo step; a badge
// switched off and on; Escape leaves everything alone; Strength; a
// selection; the keyboard (Tab reaches the bar, Enter on Cancel cancels);
// laptop widths; and the Frame's and Shape Studio's pens — the Frame's fill
// filling the joined flower's centre.
// __sketchDraw / __compositorSetLayers only set drawings up and read them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const paths = (d: any) => d.entities.filter((e: any) => e.kind === 'path')
const bar = (page: Page) => page.locator('[data-cleanup-bar]')
const joins = (page: Page) => page.locator('[data-fix-kind="join"]')

/** The owner's trimmed flower: four petal arcs round a square (corners C, in
 *  drawing units), each a separate open piece ending `gap` short of the next
 *  one's start, bulging outward (corners counter-clockwise in drawing
 *  space, arcs drawn with sweep 1). */
function flower(C: number[][], gap: { x: number; y: number }) {
  const entities: any[] = [], constraints: any[] = []
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const ex = x1 + gap.x, ey = y1 + gap.y
    entities.push(
      { id: `s${i}`, kind: 'point', x: x0, y: y0 },
      { id: `e${i}`, kind: 'point', x: ex, y: ey },
      { id: `c${i}`, kind: 'point', x: (x0 + ex) / 2, y: (y0 + ey) / 2 },
      { id: `P${i}`, kind: 'path', anchors: [`s${i}`, `e${i}`], segments: [{ kind: 'arc', center: `c${i}`, sweep: 1 }], closed: false },
    )
    constraints.push({ id: `k${i}`, kind: 'equalDist', refs: [`c${i}`, `s${i}`, `c${i}`, `e${i}`] })
  }
  return { entities, constraints }
}

// on the pen page (34 px per unit, y up): a 6-unit square, gaps of 3.2 px
async function loadFlower(page: Page) {
  const raw = flower([[6, 2], [12, 2], [12, 8], [6, 8]], { x: 0.08, y: 0.05 })
  await page.evaluate((r) => (window as any).__sketchDraw.load(r), raw)
}
/** extent of every path point (anchors and arc bulges) from the page's own path data */
async function outlineBox(page: Page) {
  return page.evaluate(() => {
    const d: string = (window as any).__sketchDraw.pathData()
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', d)
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    s.appendChild(p); document.body.appendChild(s)
    const b = p.getBBox(); s.remove()
    return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height }
  })
}

test('Clean up joins the trimmed flower into one closed loop, previewed first, in one undo step', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  const before = await doc(page)
  // the petals bulge outward: the outline reaches 3 units past the square on every side
  const ob = await outlineBox(page)
  expect(ob.x0).toBeLessThan(3.5); expect(ob.x1).toBeGreaterThan(14.5)
  expect(ob.y0).toBeLessThan(-0.5); expect(ob.y1).toBeGreaterThan(10.5)

  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  await expect(page.locator('[data-act="cleanup"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-tool="path"]')).toBeDisabled()
  await expect(page.locator('[data-cleanup-preview]')).toHaveCount(1)
  await expect(page.locator('[data-cleanup-ghost]')).toHaveCount(1)
  await expect(joins(page)).toHaveCount(4)
  await expect(joins(page).first()).toHaveText('Joined')
  const preview = await page.evaluate(() => (window as any).__sketchDraw.cleanup())
  expect(preview.fixes.filter((f: any) => f.kind === 'join')).toHaveLength(4)
  const onBefore = preview.fixes.filter((f: any) => f.on).length
  expect(await doc(page)).toEqual(before)                 // the preview never touches the drawing

  // the canvas cursor is the plain arrow while previewing
  const cv = (await page.locator('svg:has([data-cleanup-preview])').boundingBox())!
  await page.mouse.move(cv.x + 40, cv.y + cv.height - 30)
  expect(await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x!, y!)!).cursor, [cv.x + 40, cv.y + cv.height - 30])).toBe('default')

  await expect(page.locator('[data-act="cleanup"]')).toBeFocused()
  await page.keyboard.press('Enter')                      // the Clean up button still has focus: Enter applies
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-cleanup-fix]')).toHaveCount(0)
  const d = await doc(page)
  expect(paths(d)).toHaveLength(1)
  expect(paths(d)[0].closed).toBe(true)
  expect(paths(d)[0].segments.map((s: any) => s.kind)).toEqual(['arc', 'arc', 'arc', 'arc'])
  // the joins, plus whatever else it evened up in the same step (tangents, same radius…)
  const fixCount = await page.evaluate(() => (window as any).__sketchDraw.status())
  expect(fixCount).toMatch(/^Cleaned up · \d+ changes$/)
  expect(Number(/\d+/.exec(fixCount)![0])).toBe(onBefore)
  await page.keyboard.press(`${META}+z`)
  expect(await doc(page)).toEqual(before)
})

test('⌥⇧C opens Clean up; a badge clicked off is left out, and Apply keeps the rest', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  await page.keyboard.press('Alt+Shift+KeyC')
  await expect(bar(page)).toBeVisible()
  await expect(joins(page)).toHaveCount(4)
  const id = await joins(page).first().getAttribute('data-cleanup-fix')
  const badge = page.locator(`[data-cleanup-fix="${id}"]`)
  await badge.click()
  await expect(badge).toHaveAttribute('data-off', '')
  expect((await page.evaluate(() => (window as any).__sketchDraw.cleanup())).fixes.find((f: any) => f.id === id).on).toBe(false)
  await badge.click()
  await expect(badge).toHaveAttribute('data-on', '')
  await badge.click()
  await expect(badge).toHaveAttribute('data-off', '')
  await page.locator('[data-act="cleanup-apply"]').click()
  await expect(bar(page)).toHaveCount(0)
  const d = await doc(page)
  expect(paths(d)).toHaveLength(1)
  expect(paths(d)[0].closed).toBe(false)
  expect(paths(d)[0].anchors).toHaveLength(5)
})

test('Escape closes Clean up and leaves the drawing and its history alone', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  const before = await doc(page)
  const canUndo = await page.evaluate(() => (window as any).__sketchDraw.canUndo())
  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-cleanup-fix]')).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeEnabled()
  expect(await doc(page)).toEqual(before)
  expect(await page.evaluate(() => (window as any).__sketchDraw.canUndo())).toBe(canUndo)
  expect(await page.evaluate(() => (window as any).__sketchDraw.status())).toBe('Clean up cancelled')
})

test('the keyboard: Tab reaches Gentle, Normal, Strong, Cancel and Apply; Enter on Cancel cancels, on Apply applies', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  const before = await doc(page)
  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  const focusedAct = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return a?.getAttribute('data-strength') ?? a?.getAttribute('data-act') ?? a?.tagName ?? null
  })
  const seen: (string | null)[] = []
  for (let i = 0; i < 20 && !seen.includes('cleanup-apply'); i++) {
    await page.keyboard.press('Tab')
    seen.push(await focusedAct())
  }
  const order = ['gentle', 'normal', 'strong', 'cleanup-cancel', 'cleanup-apply'].map(k => seen.indexOf(k))
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(await doc(page)).toEqual(before)                 // Tab edits nothing

  // ⇧Tab back to Cancel: Enter there cancels (it does not apply)
  for (let i = 0; i < 20 && (await focusedAct()) !== 'cleanup-cancel'; i++) await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-act="cleanup-cancel"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(bar(page)).toHaveCount(0)
  expect(await doc(page)).toEqual(before)
  expect(await page.evaluate(() => (window as any).__sketchDraw.status())).toBe('Clean up cancelled')

  // and Enter on a focused Apply applies
  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  for (let i = 0; i < 20 && (await focusedAct()) !== 'cleanup-apply'; i++) await page.keyboard.press('Tab')
  await expect(page.locator('[data-act="cleanup-apply"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(bar(page)).toHaveCount(0)
  const d = await doc(page)
  expect(paths(d)).toHaveLength(1)
  expect(paths(d)[0].closed).toBe(true)
})

test('the keyboard: Space presses a Tab-focused strength button (not the page’s pan); the arrows move the strength', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  const strong = page.locator('[data-strength="strong"]')
  for (let i = 0; i < 20 && !(await strong.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(strong).toBeFocused()
  await expect(page.locator('[data-strength="normal"]')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Space')
  await expect(strong).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('svg').first()).not.toHaveCSS('cursor', 'grab')
  // radio-group keys: ← / → move the strength and the focus with it, round the ends
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('[data-strength="normal"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-strength="normal"]')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(strong).toHaveAttribute('aria-checked', 'true')
  await expect(strong).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('[data-strength="gentle"]')).toHaveAttribute('aria-checked', 'true')
  await expect(bar(page)).toBeVisible()
})

test('after Apply the next Enter finishes the pen; after Cancel the next Escape reaches the page', async ({ page }) => {
  await open(page)
  await loadFlower(page)
  const status = () => page.evaluate(() => (window as any).__sketchDraw.status())
  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(bar(page)).toHaveCount(0)
  expect(await status()).toMatch(/^Cleaned up · \d+ changes$/)
  await expect(page.locator('[data-act="cleanup"]')).not.toBeFocused()
  await page.keyboard.press('Enter')
  expect(await status()).toBe('done')                     // not Clean up again
  await expect(bar(page)).toHaveCount(0)
  expect(paths(await doc(page))).toHaveLength(1)

  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  expect(await status()).toBe('Clean up cancelled')
  await page.keyboard.press('Escape')
  expect(await status()).toBe('cancelled')
  // with every fix off, Enter does nothing (Apply is disabled too)
  await page.locator('[data-act="cleanup"]').click()
  for (let round = 0; round < 20; round++) {
    const on = page.locator('.cleanup-badge[data-on]')
    if (!(await on.count())) break
    await on.first().click()
  }
  await expect(page.locator('[data-act="cleanup-apply"]')).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Escape')
})

test('Strength: a line 6° off level is only levelled at Strong; Cancel closes', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    D.reset(); D.setTool('line')
    D.place(2, 2); D.place(10, 2 + 8 * Math.tan(6 * Math.PI / 180))
    D.setTool('select')
  })
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-strength="normal"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(0)
  await page.locator('[data-strength="strong"]').click()
  await expect(page.locator('[data-strength="strong"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(1)
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveText('Horizontal')
  await page.locator('[data-strength="gentle"]').click()
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(0)
  await page.locator('[data-act="cleanup-cancel"]').click()
  await expect(bar(page)).toHaveCount(0)
})

test('with a selection, Clean up works on it and leaves the rest where it was', async ({ page }) => {
  await open(page)
  const ids = await page.evaluate(() => {
    const D = (window as any).__sketchDraw
    const dy = 8 * Math.tan(2 * Math.PI / 180)
    D.reset(); D.setTool('line')
    D.place(2, 2); D.place(10, 2 + dy)
    D.place(2, 7); D.place(10, 7 + dy)
    D.setTool('select')
    const [l1, l2] = D.doc.entities.filter((e: any) => e.kind === 'line')
    return { l1: l1.id as string, a1: l1.p1 as string, a2: l1.p2 as string, p1: l2.p1 as string, p2: l2.p2 as string }
  })
  const before = await doc(page)
  await page.locator(`[data-ent="${ids.l1}"]`).click()
  expect(await page.evaluate(() => (window as any).__sketchDraw.selection)).toEqual([ids.l1])
  await page.locator('[data-act="cleanup"]').click()
  await expect(page.locator('[data-fix-kind="horizontal"]')).toHaveCount(1)
  await page.locator('[data-act="cleanup-apply"]').click()
  await expect(bar(page)).toHaveCount(0)
  const d = await doc(page)
  const pt = (x: any, id: string) => x.entities.find((e: any) => e.id === id)
  // the selected line is level now; the other one did not move
  expect(Math.abs(pt(d, ids.a1).y - pt(d, ids.a2).y)).toBeLessThan(1e-6)
  for (const id of [ids.p1, ids.p2]) expect(pt(d, id)).toEqual(pt(before, id))
})

for (const width of [1280, 1024]) {
  test(`the Clean up bar and the tool row fit at ${width} px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page)
    await loadFlower(page)
    const scrollBefore = await page.evaluate(() => document.documentElement.scrollWidth)
    await page.locator('[data-act="cleanup"]').click()
    await expect(bar(page)).toBeVisible()
    for (const sel of ['[data-cleanup-bar]', '[aria-label="Pen tools"]', '[data-act="cleanup-apply"]', '[data-act="cleanup-cancel"]']) {
      const box = (await page.locator(sel).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    const scrollAfter = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollAfter).toBeLessThanOrEqual(Math.max(scrollBefore, width))
  })
}

// ── the Frame ──

type Box = { x: number; y: number; width: number; height: number }
const layers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers() as any[])
const framePenButton = (page: Page) => page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first()
const frameOverlay = (page: Page) => page.locator('[data-testid="frame-pen-overlay"]')
/** a sketch point (drawing units, 100 per artboard width) → screen px, for an unrotated, unscaled layer */
const frameToScreen = (l: any, p: { x: number; y: number }, box: Box) =>
  ({ x: box.x + l.x * box.width + p.x * box.width / 100, y: box.y + l.y * box.height + p.y * box.width / 100 })
/** the stage's colour at a screen point (a real screenshot of one pixel) */
async function pixel(page: Page, at: { x: number; y: number }) {
  const png = await page.screenshot({ clip: { x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 } })
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode()
    const c = document.createElement('canvas'); c.width = c.height = 1
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0)
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }, png.toString('base64'))
}
const isBlue = (rgb: number[]) => Math.abs(rgb[0]! - 0x3b) < 24 && Math.abs(rgb[1]! - 0x82) < 24 && Math.abs(rgb[2]! - 0xf6) < 24

test('the Frame: the trimmed flower cleaned up in the pen becomes one closed loop, and its fill fills the centre', async ({ page }) => {
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]')
  // a drawn path layer to hold the flower: a triangle drawn with the real mouse
  const before = await layers(page)
  await framePenButton(page).click()
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  const box = (await frameOverlay(page).boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const tri = [{ x: cx - 90, y: cy - 50 }, { x: cx + 70, y: cy - 60 }, { x: cx - 10, y: cy + 80 }]
  for (const p of [...tri, tri[0]!]) { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up() }
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="path"]')).toBeHidden()
  const layer = (await layers(page)).find((l: any) => !before.some((b: any) => b.id === l.id))
  expect(layer?.kind).toBe('path')
  expect(layer.fill).toBe('#3b82f6')

  // the flower (a 100 px square, 3.2 px gaps) round the layer's origin, as its drawing
  const u = 100 / box.width                      // drawing units per screen px
  const h = 50 * u
  const raw = flower([[-h, -h], [h, -h], [h, h], [-h, h]], { x: 2.7 * u, y: 1.7 * u })
  await page.evaluate(({ id, sketch }) => {
    const w = window as any
    w.__compositorSetLayers(w.__compositorLayers().map((l: any) => (l.id === id ? { ...l, sketch } : l)))
  }, { id: layer.id, sketch: raw })

  // a point inside the flower's square but outside the triangle: not filled yet
  const probe = frameToScreen(layer, { x: -35 * u, y: 35 * u }, box)
  expect(isBlue(await pixel(page, probe))).toBe(false)

  // reopen the pen on the layer (double-click inside the triangle), Clean up, Enter applies, Done commits
  const centre = frameToScreen(layer, { x: 0, y: 0 }, box)
  await page.mouse.dblclick(centre.x, centre.y)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await page.locator('[data-act="cleanup"]').click()
  await expect(bar(page)).toBeVisible()
  await expect(joins(page)).toHaveCount(4)
  await page.keyboard.press('Enter')
  await expect(bar(page)).toHaveCount(0)
  // the next Enter finishes the pen (the Clean up button gave up its focus)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="path"]')).toBeHidden()

  const done = (await layers(page)).find((l: any) => l.id === layer.id)
  const ps = done.sketch.entities.filter((e: any) => e.kind === 'path')
  expect(ps).toHaveLength(1)
  expect(ps[0].closed).toBe(true)
  expect(ps[0].segments.map((s: any) => s.kind)).toEqual(['arc', 'arc', 'arc', 'arc'])
  expect((done.d.match(/M/g) ?? []).length).toBe(1)
  // the fill fills the centre — and a petal
  await expect.poll(async () => isBlue(await pixel(page, probe))).toBe(true)
  expect(isBlue(await pixel(page, centre))).toBe(true)
  expect(isBlue(await pixel(page, { x: centre.x, y: centre.y - 50 - 35 }))).toBe(true)
})

test('the Frame’s pen offers Clean up; Space presses a Tab-focused strength; Escape closes it and leaves the pen open', async ({ page }) => {
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]')
  await framePenButton(page).click()
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  const btn = page.locator('[data-act="cleanup"]')
  await expect(btn).toBeVisible()
  await btn.hover()
  await expect(page.locator('[data-pen-tip-id="cleanup"]')).toBeVisible()
  await btn.click()
  await expect(bar(page)).toBeVisible()
  await expect(page.locator('[data-cleanup-note]')).toHaveText('Nothing to change')
  // Space presses a strength button Tab reached — the Frame's Space-to-pan leaves it alone
  const strong = page.locator('[data-strength="strong"]')
  for (let i = 0; i < 40 && !(await strong.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(strong).toBeFocused()
  await page.keyboard.press('Space')
  await expect(strong).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await page.keyboard.press('Alt+Shift+KeyC')
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await expect(page.locator('[data-testid="compositor-stage"]')).toBeVisible()
})

test('Shape Studio’s pen offers Clean up; Escape closes it and leaves the studio open', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  const btn = page.locator('[data-act="cleanup"]')
  await btn.hover()
  await expect(page.locator('[data-pen-tip-id="cleanup"]')).toBeVisible()
  await btn.click()
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await page.keyboard.press('Alt+Shift+KeyC')
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__shapeStudioLab.closes as number)).toBe(0)
})
