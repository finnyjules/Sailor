// tests/pen-fills.spec.ts
// Pen stage 7 with the REAL mouse and keyboard: G picks Fill; hovering hatches
// the area under the pointer, a click fills it, a second click empties it, ⌘Z
// and ⇧⌘Z (one step each); dragging a corner, the fill follows; a line drawn
// across fills both halves, trimming the divider leaves one fill, trimming an
// edge puts it to sleep with its gap rings, a line closing the gap wakes it;
// trimming away an area drops its fill; the owner's trimmed flower fills petal
// by petal without joining; the Frame paints the fill in the layer, Cancel
// keeps it, emptied it goes; Shape Studio's Drawn shape takes the filled area;
// the bucket button at laptop widths in all three hosts.
// __sketchDraw / __compositorLayers only set drawings up and read them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const svg = (page: Page) => page.locator('svg[data-pen-overlay]')
// drawing → page px on the pen page (34 px/unit, y up, origin at (40, 400) of the board)
async function at(page: Page, x: number, y: number) {
  const b = (await svg(page).boundingBox())!
  return { x: b.x + 40 + 34 * x, y: b.y + 400 - 34 * y }
}
async function click(page: Page, x: number, y: number) {
  const p = await at(page, x, y)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down(); await page.mouse.up()
}
const fills = (page: Page) => page.evaluate(() => (window as any).__sketchDraw.fills())
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const status = (page: Page) => page.locator('[data-status]')
const load = (page: Page, raw: unknown) => page.evaluate((r) => (window as any).__sketchDraw.load(r), raw)

const sq = (id: string, pts: [string, number, number][]) => ({
  entities: [
    ...pts.map(([pid, x, y]) => ({ id: pid, kind: 'point', x, y })),
    { id, kind: 'path', anchors: pts.map(p => p[0]), segments: pts.map(() => ({ kind: 'line' })), closed: true },
  ],
  constraints: [],
})
/** a closed square (1,1)–(5,5) */
const SQUARE = sq('S', [['a', 1, 1], ['b', 5, 1], ['c', 5, 5], ['d', 1, 5]])

/** The owner's trimmed flower: a square centre (6,2)–(12,8) and a petal arc on
 *  each side, each petal a separate open piece whose ends stop ~3 px short of the
 *  square's corners (nothing joined). */
function flower() {
  const entities: any[] = [
    { id: 'q0', kind: 'point', x: 6, y: 2 }, { id: 'q1', kind: 'point', x: 12, y: 2 },
    { id: 'q2', kind: 'point', x: 12, y: 8 }, { id: 'q3', kind: 'point', x: 6, y: 8 },
    { id: 'SQ', kind: 'path', anchors: ['q0', 'q1', 'q2', 'q3'], segments: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], closed: true },
  ]
  const constraints: any[] = []
  const C = [[6, 2], [12, 2], [12, 8], [6, 8]]
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = C[i]!, [x1, y1] = C[(i + 1) % 4]!
    const cx = (x0! + x1!) / 2, cy = (y0! + y1!) / 2, r = 3, dl = 0.03
    const a0 = Math.atan2(y0! - cy, x0! - cx) + dl, a1 = a0 + Math.PI - 2 * dl
    entities.push(
      { id: `s${i}`, kind: 'point', x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) },
      { id: `e${i}`, kind: 'point', x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) },
      { id: `m${i}`, kind: 'point', x: cx, y: cy },
      { id: `P${i}`, kind: 'path', anchors: [`s${i}`, `e${i}`], segments: [{ kind: 'arc', center: `m${i}`, sweep: 1 }], closed: false },
    )
    constraints.push({ id: `k${i}`, kind: 'equalDist', refs: [`m${i}`, `s${i}`, `m${i}`, `e${i}`] })
  }
  return { entities, constraints }
}

test('G picks Fill; hovering hatches the area, a click fills it, a second click empties it; ⌘Z and ⇧⌘Z', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('g')
  await expect(page.locator('[data-tool="fill"]')).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('fill')
  const p = await at(page, 3, 3)
  await page.mouse.move(p.x, p.y)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'no')
  // hovering writes no step: ⌘Z takes back the load itself, ⇧⌘Z brings it back
  const d0 = JSON.stringify(await doc(page))
  await page.mouse.move(p.x + 20, p.y + 10, { steps: 3 }); await page.mouse.move(p.x, p.y, { steps: 3 })
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => (await doc(page)).entities.length).toBe(0)
  await page.keyboard.press(`${META}+Shift+z`)
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
  await page.mouse.move(p.x + 1, p.y); await page.mouse.move(p.x, p.y)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'no')
  await page.mouse.down(); await page.mouse.up()
  await expect.poll(async () => (await fills(page)).filled).toBe(1)
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'yes')
  await expect(status(page)).toHaveText('Filled')
  expect((await fills(page)).area).toBeCloseTo(16, 6)

  // one ⌘Z takes the fill back to exactly the drawing before, and there is no step before it
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => (await fills(page)).filled).toBe(0)
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press(`${META}+Shift+z`)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)

  await page.mouse.down(); await page.mouse.up()   // still over the square: empties it
  await expect.poll(async () => (await fills(page)).count).toBe(0)
  await expect(status(page)).toHaveText('Emptied')
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  expect('fillGap' in (await doc(page))).toBe(false)
  // one ⌘Z brings the fill back (emptying was one step)
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)
  await page.keyboard.press(`${META}+Shift+z`)
  await expect.poll(async () => (await fills(page)).count).toBe(0)

  await click(page, 8, 8)                            // open space
  await expect(status(page)).toHaveText('Click inside an enclosed area')
  await expect(page.locator('[data-fill-hover]')).toHaveCount(0)
  expect((await fills(page)).count).toBe(0)
})

test('dragging a corner: the fill follows the edge', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('g'); await click(page, 3, 3)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)
  await page.keyboard.press('v')
  const from = await at(page, 5, 5), to = await at(page, 7, 6)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  // mid-drag the tint already follows (it reads the moving outline)
  await expect.poll(async () => (await fills(page)).area).toBeGreaterThan(16.5)
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await fills(page)).area).toBeGreaterThan(19)   // the corner pulled out to (7, 6)
  const f = await fills(page)
  expect(f.count).toBe(1)
  expect(f.filled).toBe(1)
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  const c = (await doc(page)).entities.find((e: any) => e.id === 'c')
  expect(c.x).toBeCloseTo(7, 1); expect(c.y).toBeCloseTo(6, 1)
})

test('a line across fills both halves; trimming the divider leaves one; trimming an edge sleeps with rings; closing it wakes; ⌘Z', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('g'); await click(page, 3, 3)
  await expect.poll(async () => (await fills(page)).filled).toBe(1)

  await page.keyboard.press('l')
  await click(page, 3, 0); await click(page, 3, 6)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 2, filled: 2, asleep: 0 })
  expect((await fills(page)).area).toBeCloseTo(16, 4)   // both halves: the whole square

  await page.keyboard.press('t')
  await click(page, 3, 3)                            // the divider's piece inside the square
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 1, asleep: 0 })
  expect((await fills(page)).area).toBeCloseTo(16, 4)

  await click(page, 2, 1)                            // the bottom edge's left piece: the square opens
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 0, asleep: 1 })
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  await expect(page.locator('[data-fill-gap]').first()).toBeVisible()
  expect(await page.locator('[data-fill-gap]').count()).toBeGreaterThanOrEqual(1)

  // a line drawn across the gap (from corner to corner) closes it: the fill wakes
  await page.keyboard.press('l')
  await click(page, 1, 1); await click(page, 3, 1)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 1, asleep: 0 })
  await expect(page.locator('[data-fill-gap]')).toHaveCount(0)
  expect((await fills(page)).area).toBeCloseTo(16, 3)

  await page.keyboard.press(`${META}+z`)             // the closing line goes: asleep again
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 0, asleep: 1 })
  await page.keyboard.press(`${META}+z`)             // the trim goes: awake
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 1, asleep: 0 })
  await expect(page.locator('[data-fill-gap]')).toHaveCount(0)
})

test('trimming away a filled area drops its fill', async ({ page }) => {
  // a half-disc: the diameter (−3,0)→(3,0) and its cap round (0,0), shifted to (6,5)
  await open(page)
  await load(page, {
    entities: [
      { id: 'A', kind: 'point', x: 3, y: 5 }, { id: 'B', kind: 'point', x: 9, y: 5 }, { id: 'O', kind: 'point', x: 6, y: 5 },
      { id: 'H', kind: 'path', anchors: ['A', 'B'], segments: [{ kind: 'line' }, { kind: 'arc', center: 'O', sweep: 1 }], closed: true },
    ],
    constraints: [],
  })
  await page.keyboard.press('g'); await click(page, 6, 6)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 1, filled: 1 })
  await page.keyboard.press('t')
  await click(page, 6, 8)                            // the cap
  await expect.poll(async () => (await fills(page)).count).toBe(0)
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  await expect(page.locator('[data-fill-gap]')).toHaveCount(0)
  expect('fills' in (await doc(page))).toBe(false)
})

test('the owner’s trimmed flower: the centre and every petal fill by bucket, nothing joined', async ({ page }) => {
  await open(page)
  await load(page, flower())
  const before = await doc(page)
  await page.keyboard.press('g')
  for (const [x, y] of [[9, 5], [9, 0.2], [13.8, 5], [9, 9.8], [4.2, 5]] as const) await click(page, x, y)
  await expect.poll(async () => fills(page)).toMatchObject({ count: 5, filled: 5, asleep: 0 })
  const after = await doc(page)
  expect(after.entities).toEqual(before.entities)                // nothing merged, nothing added, nothing moved
  expect(after.entities.filter((e: any) => e.kind === 'path')).toHaveLength(5)
  expect(after.fillGap).toBeGreaterThan(0)
  // the centre and four half-discs of radius 3
  expect((await fills(page)).area).toBeGreaterThan(36 + 4 * (Math.PI * 9 / 2) * 0.97)
})

// ── the Frame ──

type Box = { x: number; y: number; width: number; height: number }
const layers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers() as any[])
const framePenButton = (page: Page) => page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first()
const frameOverlay = (page: Page) => page.locator('[data-testid="frame-pen-overlay"]')
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
async function clickAt(page: Page, p: { x: number; y: number }) {
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up()
}
/** three open lines crossing in a triangle round (cx, cy): apex ~46 px up, base 40 px down */
async function crossingLines(page: Page, cx: number, cy: number) {
  await page.keyboard.press('l')
  for (const [a, b] of [[[-90, 40], [90, 40]], [[-70, 75], [20, -80]], [[70, 75], [-20, -80]]] as const) {
    await clickAt(page, { x: cx + a[0], y: cy + a[1] })
    await clickAt(page, { x: cx + b[0], y: cy + b[1] })
  }
}
async function closePenWithEscape(page: Page) {
  for (let i = 0; i < 4 && await page.locator('[data-tool="fill"]').isVisible(); i++) await page.keyboard.press('Escape')
  await expect(page.locator('[data-tool="fill"]')).toBeHidden()
}

test('the Frame: three crossing lines, the triangle bucket-filled, paint in the layer; Cancel keeps it; emptied, the fill goes', async ({ page }) => {
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]')
  const before = await layers(page)
  await framePenButton(page).click()
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  const box = (await frameOverlay(page).boundingBox())! as Box
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await crossingLines(page, cx, cy)
  await page.keyboard.press('g')
  const inside = { x: cx, y: cy + 10 }, below = { x: cx, y: cy + 60 }
  await page.mouse.move(inside.x, inside.y)
  await expect(page.locator('[data-fill-hover]')).toHaveAttribute('data-filled', 'no')
  await page.mouse.down(); await page.mouse.up()
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="fill"]')).toBeHidden()

  const layer = (await layers(page)).find((l: any) => !before.some((b: any) => b.id === l.id))
  expect(layer?.kind).toBe('path')
  expect(layer.fill).toBe('#3b82f6')
  expect(layer.fillD).toMatch(/^M .* Z$/)
  expect(layer.sketch.fills).toHaveLength(1)
  await page.mouse.move(box.x + 4, box.y + 4)           // the pointer off the drawing: no hover ring over the probe
  await expect.poll(async () => isBlue(await pixel(page, inside))).toBe(true)
  expect(isBlue(await pixel(page, below))).toBe(false)   // under the base: not enclosed
  const committed = JSON.parse(JSON.stringify(layer))

  // reopen (a double-click on the filled area), empty it, then Cancel: the layer comes back as it was
  await page.mouse.dblclick(inside.x, inside.y)
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  await page.keyboard.press('g')
  await clickAt(page, inside)
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  await closePenWithEscape(page)
  await expect.poll(async () => (await layers(page)).find((l: any) => l.id === layer.id)).toEqual(committed)
  await page.mouse.move(box.x + 4, box.y + 4)
  await expect.poll(async () => isBlue(await pixel(page, inside))).toBe(true)

  // reopen, empty it, Enter: the fill goes
  await page.mouse.dblclick(inside.x, inside.y)
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  await page.keyboard.press('g')
  await clickAt(page, inside)
  await expect(page.locator('[data-fill-area]')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="fill"]')).toBeHidden()
  const done = (await layers(page)).find((l: any) => l.id === layer.id)
  expect('fillD' in done).toBe(false)
  expect(done.fill).toBe('none')                       // open lines again: stroked, not filled
  await page.mouse.move(box.x + 4, box.y + 4)
  await expect.poll(async () => isBlue(await pixel(page, inside))).toBe(false)
})

// ── Shape Studio ──

const markOf = (page: Page) => page.evaluate(() =>
  (window as any).__shapeStudioLab.props.sailor_shapeStudio?.doc?.layers?.[0]?.mark ?? null)
/** painted pixels of the preview (its background is transparent) */
const painted = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="shape-preview"]') as HTMLCanvasElement
  const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 3; i < data.length; i += 16) if (data[i]! > 0) n++
  return n
})

test('Shape Studio: three crossing lines with the triangle filled make a Drawn shape painted as a fill', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="fill"]')).toBeVisible()
  const box = (await page.locator('[data-testid="shape-pen-overlay"]').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await crossingLines(page, cx, cy)
  await page.keyboard.press('g')
  await clickAt(page, { x: cx, y: cy + 10 })
  await expect(page.locator('[data-fill-area]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-tool="fill"]')).toHaveCount(0)
  await expect.poll(async () => (await markOf(page))?.sketch?.fills?.length ?? 0, { timeout: 15_000 }).toBe(1)
  const m = await markOf(page)
  expect(m.shape).toBe('drawn')
  expect(m.paintTarget).toBe('fill')
  // the filled triangle is painted (a solid area, not three hairlines)
  await expect.poll(() => painted(page), { timeout: 10_000 }).toBeGreaterThan(500)
})

// ── laptop widths ──

for (const width of [1280, 1024]) {
  test(`the bucket button is on screen at ${width} px in all three hosts`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const onScreen = async () => {
      const b = (await page.locator('[data-tool="fill"]').boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(width)
      expect(b.y + b.height).toBeLessThanOrEqual(800)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
    await open(page)
    await expect(page.locator('[data-tool="fill"]')).toBeVisible()
    await onScreen()
    await page.locator('[data-tool="fill"]').click()     // it takes a real click
    expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('fill')

    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await framePenButton(page).click()
    await expect(page.locator('[data-tool="fill"]')).toBeVisible()
    await onScreen()
    await page.locator('[data-tool="fill"]').click()
    await expect(page.locator('[data-tool="fill"]')).toHaveAttribute('aria-pressed', 'true')

    await page.goto('/dev/shape-studio-lab')
    await page.locator('[data-ready]').waitFor()
    await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
    await expect(page.locator('[data-tool="fill"]')).toBeVisible()
    await onScreen()
    await page.locator('[data-tool="fill"]').click()
    await expect(page.locator('[data-tool="fill"]')).toHaveAttribute('aria-pressed', 'true')
  })
}
