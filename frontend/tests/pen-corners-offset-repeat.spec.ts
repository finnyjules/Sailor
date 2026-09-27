// tests/pen-corners-offset-repeat.spec.ts
// Pen stage 8 with the REAL mouse and keyboard on the pen page: F rounds a
// corner by dragging (one step, ⌘Z / ⇧⌘Z), too big stays red and Enter says
// why, H chamfers with a typed setback, Shift-click shares one radius, E
// offsets by dragging and the copy follows its source, typed with − for the
// other side; Repeat… from the right-click menu — Linear (then the guide's end
// dragged), Along a path, Radial with a sweep; Esc and Cancel leave every
// preview as it was; Space still pans after a click in the panel; Enter on a
// keyboard-focused Apply applies and keeps the pen; the right-click menu's
// Offset… / Round corner… / Chamfer…; the buttons and the panel fit at laptop
// widths. __sketchDraw only sets drawings up and reads state.
//
// The Repeat panel's number fields commit when left (Tab, a click elsewhere)
// and the preview follows; a field's Enter commits it and applies; a click on
// Apply commits the field still being typed (final fix wave ruling).
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const svg = (page: Page) => page.locator('svg[data-pen-overlay]')
// drawing → page px on the pen page (34 px/unit, y up, origin at (40, 400) of the 680×460 board)
async function at(page: Page, x: number, y: number) {
  const b = (await svg(page).boundingBox())!
  return { x: b.x + 40 + 34 * x, y: b.y + 400 - 34 * y }
}
async function click(page: Page, x: number, y: number, mods: ('Shift' | 'Alt')[] = []) {
  const p = await at(page, x, y)
  for (const m of mods) await page.keyboard.down(m)
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up()
  for (const m of mods) await page.keyboard.up(m)
}
async function drag(page: Page, from: [number, number], to: [number, number], mid?: () => Promise<void>) {
  const a = await at(page, ...from), b = await at(page, ...to)
  await page.mouse.move(a.x, a.y); await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8)
    if (i === 5 && mid) await mid()
  }
  await page.mouse.up()
}
const doc = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const read = (page: Page, hook: 'corner' | 'offset' | 'repeatPanel') => page.evaluate((h) => (window as any).__sketchDraw[h](), hook)
const status = (page: Page) => page.locator('[data-status]')
const load = (page: Page, raw: unknown) => page.evaluate((r) => (window as any).__sketchDraw.load(r), raw)
const SQUARE = {
  entities: [
    ...[['a', 1, 1], ['b', 5, 1], ['c', 5, 5], ['d', 1, 5]].map(([id, x, y]) => ({ id, kind: 'point', x, y })),
    { id: 'S', kind: 'path', anchors: ['a', 'b', 'c', 'd'], segments: [0, 1, 2, 3].map(() => ({ kind: 'line' })), closed: true },
  ],
  constraints: [],
}
const pathOf = (d: any, id = 'S') => d.entities.find((e: any) => e.id === id)
const arcs = (d: any) => d.entities.filter((e: any) => e.kind === 'path').flatMap((e: any) => e.segments.filter((s: any) => s.kind === 'arc'))
const drawnPaths = (d: any) => d.entities.filter((e: any) => e.kind === 'path' && !e.construction)

test('F: drag from a corner rounds it — the preview first, then one step; ⌘Z and ⇧⌘Z', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('f')
  await expect(page.locator('[data-tool="round"]')).toHaveAttribute('aria-pressed', 'true')
  const c = await at(page, 1, 1)
  await page.mouse.move(c.x + 2, c.y - 2)
  await expect(page.locator('[data-corner-hover]')).toHaveCount(1)
  await drag(page, [1, 1], [1.6, 1.6], async () => {
    await expect(page.locator('[data-corner-preview]')).toHaveAttribute('data-fits', 'yes')
    expect(JSON.stringify(await doc(page))).toBe(d0)                    // nothing written mid-drag
  })
  await expect.poll(async () => arcs(await doc(page)).length).toBe(1)
  const d1 = await doc(page)
  expect(d1.entities.find((e: any) => e.id === 'a').construction).toBe(true)   // the corner stays as a guide
  expect(pathOf(d1).anchors).toHaveLength(5)
  await expect(status(page)).toHaveText('Rounded')
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press(`${META}+Shift+z`)
  await expect.poll(async () => arcs(await doc(page)).length).toBe(1)
})

test('F: click, type 1 and Enter rounds to that radius; 0 and . with Enter do nothing', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('f')
  await click(page, 5, 5)
  await expect(page.locator('[data-corner-picked]')).toHaveCount(1)
  await page.keyboard.type('0'); await page.keyboard.press('Enter')
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('.'); await page.keyboard.press('Enter')
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('1')
  await expect(page.locator('[data-corner-chip]')).toHaveText('1|')
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Rounded')
  const d = await doc(page)
  expect(arcs(d)).toHaveLength(1)
  // both tangent points sit 1 from the old corner (5, 5) along its sides
  const P = (id: string) => d.entities.find((e: any) => e.id === id)
  const near = pathOf(d).anchors.map(P).filter((p: any) => Math.abs(Math.hypot(p.x - 5, p.y - 5) - 1) < 1e-6)
  expect(near).toHaveLength(2)
})

test('too big stays red; Enter says why; Esc leaves the drawing as it was', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('f')
  await click(page, 1, 1)
  await page.keyboard.type('9')
  await expect(page.locator('[data-corner-chip]')).toHaveText('9|')
  await expect(page.locator('[data-corner-bad]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Too big for this corner')
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press('Escape')
  expect(await read(page, 'corner')).toBeNull()
  expect(JSON.stringify(await doc(page))).toBe(d0)
  // Esc mid-drag too
  const a = await at(page, 1, 1)
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 20, a.y - 20, { steps: 4 })
  await expect(page.locator('[data-corner-preview]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await read(page, 'corner')).toBeNull()
  expect(JSON.stringify(await doc(page))).toBe(d0)
})

test('H: click a corner, type 1.5, Enter — equal setbacks; Shift-click shares one radius', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('h')
  await expect(page.locator('[data-tool="chamfer"]')).toHaveAttribute('aria-pressed', 'true')
  await click(page, 5, 1)
  await page.keyboard.type('1.5'); await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Chamfered')
  const d = await doc(page)
  const P = (id: string) => d.entities.find((e: any) => e.id === id)
  const sq = pathOf(d)
  expect(sq.anchors).toHaveLength(5)
  expect(sq.segments.every((s: any) => s.kind === 'line')).toBe(true)
  const near = sq.anchors.map(P).filter((p: any) => Math.abs(Math.hypot(p.x - 5, p.y - 1) - 1.5) < 1e-6)
  expect(near).toHaveLength(2)
  await load(page, SQUARE)
  await page.keyboard.press('f')
  await click(page, 1, 1); await click(page, 5, 5, ['Shift'])
  expect((await read(page, 'corner')).corners).toEqual(['a', 'c'])
  await drag(page, [5, 5], [4.6, 4.6])
  await expect.poll(async () => arcs(await doc(page)).length).toBe(2)
  const eq = (await doc(page)).constraints.filter((k: any) => k.kind === 'equalDist' && k.refs[0] !== k.refs[2])
  expect(eq).toHaveLength(1)
})

test('E: drag from a side outward makes the outer copy; a source corner dragged, the copy follows', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('e')
  await expect(page.locator('[data-tool="offset"]')).toHaveAttribute('aria-pressed', 'true')
  await drag(page, [3, 1], [3, 0], async () => {
    await expect(page.locator('[data-offset-preview]')).toHaveAttribute('data-ok', 'yes')
    expect((await doc(page)).entities.filter((e: any) => e.kind === 'path')).toHaveLength(1)
  })
  await expect.poll(async () => (await doc(page)).entities.filter((e: any) => e.kind === 'path').length).toBe(2)
  await expect(status(page)).toHaveText('Offset')
  const d1 = await doc(page)
  const copy = d1.entities.find((e: any) => e.kind === 'path' && e.id !== 'S')
  const P = (d: any, id: string) => d.entities.find((e: any) => e.id === id)
  const corner = copy.anchors.map((id: string) => P(d1, id)).find((p: any) => Math.abs(p.x - 6) < 1e-6 && Math.abs(p.y - 6) < 1e-6)
  expect(corner).toBeTruthy()
  await page.keyboard.press('v')
  // (dropped well away from the copy's own corner at (6, 6), so the drop never joins onto it)
  await drag(page, [5, 5], [5.3, 7])
  const d2 = await doc(page)
  const moved = P(d2, corner.id)
  expect(moved.x).toBeGreaterThan(6); expect(moved.y).toBeGreaterThan(7)
  // one undo takes the drag back, one more the offset
  await page.keyboard.press(`${META}+z`)
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => (await doc(page)).entities.filter((e: any) => e.kind === 'path').length).toBe(1)
})

test('E: Esc mid-drag leaves it as it was; a click inside, 0.5 and Enter makes the inner copy; − flips it to the other side', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('e')
  // Esc mid-drag first
  const s = await at(page, 3, 1)
  await page.mouse.move(s.x, s.y); await page.mouse.down(); await page.mouse.move(s.x, s.y + 25, { steps: 4 })
  await expect(page.locator('[data-offset-preview]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await read(page, 'offset')).toBeNull()
  expect(JSON.stringify(await doc(page))).toBe(d0)
  const copyBox = (d: any) => {
    const copy = d.entities.find((e: any) => e.kind === 'path' && e.id !== 'S')
    const ps = copy.anchors.map((id: string) => d.entities.find((e: any) => e.id === id))
    return [Math.min(...ps.map((p: any) => p.x)), Math.min(...ps.map((p: any) => p.y)), Math.max(...ps.map((p: any) => p.x)), Math.max(...ps.map((p: any) => p.y))]
      .map(v => Math.round(v * 1e6) / 1e6)
  }
  // a click just inside the bottom side: the preview waits on the inside
  await click(page, 3, 1.1)
  await page.keyboard.type('0.5')
  await expect(page.locator('[data-offset-chip]')).toHaveText('0.5|')
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Offset')
  expect(copyBox(await doc(page))).toEqual([1.5, 1.5, 4.5, 4.5])
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
  // the same, with − : the other side
  await click(page, 3, 1.1)
  await page.keyboard.type('0.5')
  await page.keyboard.press('-')
  await expect(page.locator('[data-offset-chip]')).toHaveText('−0.5|')
  await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Offset')
  const d = await doc(page)
  expect(copyBox(d)).toEqual([0.5, 0.5, 5.5, 5.5])
  const rules = d.constraints.filter((k: any) => k.kind === 'offsetLine')
  expect(rules.length).toBeGreaterThan(0)
  expect(rules.every((k: any) => Math.abs(k.value) === 0.5)).toBe(true)
})

async function repeatFromMenu(page: Page) {
  await page.keyboard.press('v')
  await click(page, 3, 1)                                        // selects the square
  const p = await at(page, 3, 1)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.locator('[data-menu-item="repeat"]').click()
  await expect(page.locator('[data-repeat-panel]')).toBeVisible()
}

test('Repeat… Linear: previewed only, Enter in Copies applies as one step; the guide’s far end dragged and the copies follow; ⌘Z twice', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await repeatFromMenu(page)
  await page.locator('[data-repeat-mode="linear"]').click()
  await expect(page.locator('[data-repeat-mode="linear"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-repeat-preview]')).toHaveCount(1)
  expect(JSON.stringify(await doc(page))).toBe(d0)
  // the default step is the square's width × 1.25 = 5
  await expect(page.locator('[data-repeat-field="distance"] input')).toHaveValue('5')
  const count = page.locator('[data-repeat-field="count"] input')
  await count.fill('3'); await count.press('Enter')
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  await expect(status(page)).toHaveText('Repeated ×3')
  const d1 = await doc(page)
  expect(drawnPaths(d1)).toHaveLength(3)
  const guide = d1.entities.find((e: any) => e.kind === 'line' && e.construction)
  const to = d1.entities.find((e: any) => e.id === guide.p2)
  expect(to.x).toBeCloseTo(8, 6); expect(to.y).toBeCloseTo(3, 6)
  // the guide's far end, dragged up by 2 with the real mouse, pressed on its ring
  const e0 = await at(page, to.x, to.y)
  await page.mouse.move(e0.x + 4, e0.y); await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(e0.x + 4, e0.y - (68 * i) / 8)
  await page.mouse.up()
  const d2 = await doc(page)
  const tf = d2.constraints.filter((k: any) => k.kind === 'translatedFrom' && k.value === 2 && k.refs[1] === 'a')
  expect(tf).toHaveLength(1)
  const far = d2.entities.find((e: any) => e.id === tf[0].refs[0])
  const moved = d2.entities.find((e: any) => e.id === guide.p2)
  expect(moved.y).toBeCloseTo(5, 3)
  // (1, 1) + 2·(to − from): the far copy follows the guide
  expect(far.x).toBeCloseTo(1 + 2 * (moved.x - 3), 3); expect(far.y).toBeCloseTo(5, 3)
  await page.keyboard.press(`${META}+z`)                         // the guide drag
  await page.keyboard.press(`${META}+z`)                         // the repeat
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
})

// A guide point is drawn as a hollow dot; its whole disc takes the press
// (final fix wave), so a press on its centre drags it rather than selecting
// the guide line beneath (Task 10 found it; it was pinned by a test.fail).
test('a press on the centre of the linear guide’s far end drags it', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await repeatFromMenu(page)
  await page.locator('[data-repeat-mode="linear"]').click()
  const count = page.locator('[data-repeat-field="count"] input')
  await count.fill('3'); await count.press('Enter')
  const d1 = await doc(page)
  const guide = d1.entities.find((e: any) => e.kind === 'line' && e.construction)
  const to = d1.entities.find((e: any) => e.id === guide.p2)
  await drag(page, [to.x, to.y], [to.x, to.y + 2])
  const moved = (await doc(page)).entities.find((e: any) => e.id === guide.p2)
  expect(moved.y).toBeCloseTo(5, 3)
})

// (chamfered: a rounded corner's radius chip sits over its sharp, see the report)
test('a press on the centre of a virtual sharp drags the chamfered corner', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await page.keyboard.press('h')
  await click(page, 5, 5)
  await page.keyboard.type('1.5'); await page.keyboard.press('Enter')
  await expect(status(page)).toHaveText('Chamfered')
  const d1 = await doc(page)
  expect(d1.entities.find((e: any) => e.id === 'c').construction).toBe(true)
  await page.keyboard.press('v')
  await drag(page, [5, 5], [6, 6])
  const d2 = await doc(page)
  const c = d2.entities.find((e: any) => e.id === 'c')
  expect(c.x).toBeGreaterThan(5.5); expect(c.y).toBeGreaterThan(5.5)
  // the cut went with it: its two ends stay equally far from the sharp
  const P = (id: string) => d2.entities.find((e: any) => e.id === id)
  const ends = pathOf(d2).anchors.filter((id: string) => !['a', 'b', 'd'].includes(id)).map(P)
  expect(ends).toHaveLength(2)
  const r = ends.map((p: any) => Math.hypot(p.x - c.x, p.y - c.y))
  expect(r[0]).toBeCloseTo(r[1], 3)
  expect(Math.max(...ends.map((p: any) => p.x + p.y))).toBeGreaterThan(8.6)   // it moved out from (5, 3.5) / (3.5, 5)
})

test('the Repeat panel: Copies 3, Tab, Distance 6, click Apply — 3 copies at 6', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  await repeatFromMenu(page)
  await page.locator('[data-repeat-mode="linear"]').click()
  const count = page.locator('[data-repeat-field="count"] input')
  await count.click(); await count.fill('3'); await page.keyboard.press('Tab')
  const distance = page.locator('[data-repeat-field="distance"] input')
  await expect(count).toHaveValue('3')                                   // kept on leaving
  await expect.poll(async () => (await read(page, 'repeatPanel'))?.count).toBe(3)
  await distance.click(); await distance.fill('6')
  await page.locator('[data-act="repeat-apply"]').click()
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  await expect(status(page)).toHaveText('Repeated ×3')
  const d = await doc(page)
  expect(drawnPaths(d)).toHaveLength(3)
  const guide = d.entities.find((e: any) => e.kind === 'line' && e.construction)
  const P = (id: string) => d.entities.find((e: any) => e.id === id)
  expect(Math.hypot(P(guide.p2).x - P(guide.p1).x, P(guide.p2).y - P(guide.p1).y)).toBeCloseTo(6, 6)
})

test('Repeat… Along a path (Apply) and Radial with a sweep (Enter in Sweep)', async ({ page }) => {
  await open(page)
  await load(page, {
    entities: [...SQUARE.entities,
      { id: 'r0', kind: 'point', x: 0, y: -1 }, { id: 'r1', kind: 'point', x: 16, y: -1 },
      { id: 'R', kind: 'path', anchors: ['r0', 'r1'], segments: [{ kind: 'line' }], closed: false }],
    constraints: [],
  })
  await repeatFromMenu(page)
  await page.locator('[data-repeat-mode="along"]').click()
  await expect(page.locator('[data-repeat-hint]')).toHaveText('Click the path to repeat along')
  await expect(page.locator('[data-act="repeat-apply"]')).toBeDisabled()
  await click(page, 8, -1)
  await expect(page.locator('[data-repeat-field="path"]')).toContainText(/Line \d+/)
  await expect(page.locator('[data-repeat-preview]')).toHaveCount(1)
  await page.locator('[data-act="repeat-apply"]').click()
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  expect(drawnPaths(await doc(page))).toHaveLength(2 + 5)
  // one step
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => drawnPaths(await doc(page)).length).toBe(2)

  await load(page, SQUARE)
  await repeatFromMenu(page)
  await expect(page.locator('[data-repeat-hint]')).toHaveText('Click the centre of the ring — a point, or empty space')
  await click(page, 8, 3)                                        // the centre: empty space
  await expect(page.locator('[data-repeat-centre]')).toHaveCount(1)
  await expect(page.locator('[data-repeat-field="centre"]')).toContainText('New point')
  const sweep = page.locator('[data-repeat-field="sweep"] input')
  await sweep.fill('90'); await sweep.press('Enter')
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  const d = await doc(page)
  expect(drawnPaths(d)).toHaveLength(6)
  const vals = [...new Set(d.constraints.filter((k: any) => k.kind === 'rotatedFrom').map((k: any) => Math.round(k.value * 1e6) / 1e6))].sort((x: any, y: any) => x - y)
  expect(vals).toEqual([18, 36, 54, 72, 90])
})

test('the panel: Esc and Cancel leave it as it was, Space still pans after a click in it, Enter on a focused Apply applies and keeps the pen', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const d0 = JSON.stringify(await doc(page))
  await repeatFromMenu(page)
  await click(page, 8, 3)
  await page.locator('[data-repeat-mode="linear"]').click()     // a mouse click: the button takes no focus
  await page.locator('[data-repeat-mode="radial"]').click()
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-repeat-panel]'))).toBe(false)
  expect((await read(page, 'repeatPanel')).mode).toBe('radial')
  const v0 = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  const m = await at(page, 10, 8)
  await page.mouse.move(m.x, m.y)
  await page.keyboard.down('Space')
  await page.mouse.down(); await page.mouse.move(m.x + 60, m.y + 30, { steps: 5 }); await page.mouse.up()
  await page.keyboard.up('Space')
  const v1 = await page.evaluate(() => (window as any).__sketchDraw.getViewport())
  expect(JSON.stringify(v1)).not.toBe(JSON.stringify(v0))       // it panned
  await expect(page.locator('[data-repeat-panel]')).toBeVisible()
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  await expect(page.locator('[data-repeat-preview]')).toHaveCount(0)
  expect(JSON.stringify(await doc(page))).toBe(d0)
  // the view moved: put it back so the drawing-space clicks below land
  await page.evaluate(() => (window as any).__sketchDraw.panBy(-60, -30))
  // Cancel
  await repeatFromMenu(page)
  await click(page, 8, 3)
  await page.locator('[data-act="repeat-cancel"]').click()
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  await expect(status(page)).toHaveText('Repeat cancelled')
  expect(JSON.stringify(await doc(page))).toBe(d0)
  // Enter on a keyboard-focused Apply
  await repeatFromMenu(page)
  await click(page, 8, 3)
  await page.locator('[data-act="repeat-apply"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-repeat-panel]')).toHaveCount(0)
  await expect(page.locator('[data-tool="round"]')).toBeVisible()  // the pen is still open
  expect((await doc(page)).entities.filter((e: any) => e.kind === 'path').length).toBe(6)
  // one ⌘Z takes the whole ring back
  await page.keyboard.press(`${META}+z`)
  await expect.poll(async () => JSON.stringify(await doc(page))).toBe(d0)
})

test('the right-click menu: Offset… on a path, Round corner… / Chamfer… on a corner, greyed with a reason otherwise', async ({ page }) => {
  await open(page); await load(page, SQUARE)
  const mi = (id: string) => page.locator(`[data-pen-menu] [data-menu-item="${id}"]`)
  // a side: the path is selected → Offset… acts, the corner items say why not
  const p = await at(page, 3, 1)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(page.locator('[data-pen-menu]')).toBeVisible()
  await expect(mi('offset')).toContainText('Offset…')
  await expect(mi('offset')).toContainText('E')
  await expect(mi('offset')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(mi('round-corner')).toHaveAttribute('aria-disabled', 'true')
  await expect(mi('chamfer')).toHaveAttribute('aria-disabled', 'true')
  await mi('round-corner').hover()
  await expect(page.locator('[data-pen-tip-id="round"] [data-pen-tip-reason]')).toHaveText('Select a corner where two pieces meet')
  await mi('offset').click()
  await expect(page.locator('[data-pen-menu]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('offset')
  await page.keyboard.press('Escape')
  // a corner: Round corner… and Chamfer… act
  await page.keyboard.press('v')
  const c = await at(page, 5, 5)
  await page.mouse.click(c.x, c.y, { button: 'right' })
  await expect(page.locator('[data-pen-menu]')).toBeVisible()
  await expect(mi('round-corner')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(mi('chamfer')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(mi('round-corner')).toContainText('F')
  await expect(mi('chamfer')).toContainText('H')
  await mi('round-corner').click()
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('round')
  const d0 = JSON.stringify(await doc(page))
  await page.keyboard.press('Escape')
  expect(JSON.stringify(await doc(page))).toBe(d0)
  await page.keyboard.press('v')                                 // the menu opens from Select
  await page.mouse.click(c.x, c.y, { button: 'right' })
  await mi('chamfer').click()
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('chamfer')
})

for (const width of [1280, 1024]) {
  test(`the new buttons and the Repeat panel fit at ${width} px on the pen page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page); await load(page, SQUARE)
    for (const t of ['round', 'chamfer', 'offset']) {
      const b = (await page.locator(`[data-tool="${t}"]`).boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width); expect(b.y + b.height).toBeLessThanOrEqual(800)
    }
    await page.locator('[data-tool="offset"]').click()
    expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('offset')
    await repeatFromMenu(page)
    const p = (await page.locator('[data-act="repeat-apply"]').boundingBox())!
    expect(p.x + p.width).toBeLessThanOrEqual(width)
    expect(p.y + p.height).toBeLessThanOrEqual(800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
