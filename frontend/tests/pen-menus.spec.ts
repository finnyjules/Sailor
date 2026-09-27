// tests/pen-menus.spec.ts
// Pen stage 6 with the REAL mouse and keyboard: the right-click list menu
// (heading, rules, actions with keys, greyed items and their reasons, the
// keyboard, empty space, a refused pick), the action wheel (right-press-drag,
// release on a slice, the middle cancels, greyed slices, a lost release),
// Copy / Paste and Copy as SVG, the Properties panel (typing, the radius lock,
// rule hover and removal, copy rules hidden), the Frame and Shape Studio, and
// laptop widths. __sketchDraw / __compositorLayers only set drawings up and
// read them back.
import { test, expect, type Page } from '@playwright/test'

const META = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
const D = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__sketchDraw.doc)))
const sel = (page: Page) => page.evaluate(() => (window as any).__sketchDraw.selection as string[])
const svg = (page: Page) => page.locator('svg[data-pen-overlay]')
// drawing → page px on the pen page (34 px/unit, y up, origin at (40, 400) of the 680×460 board)
async function at(page: Page, x: number, y: number) {
  const b = (await svg(page).boundingBox())!
  return { x: b.x + 40 + 34 * x, y: b.y + 400 - 34 * y }
}
// two lines, a line running into a tangent arc
async function load(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__sketchDraw.load({
      entities: [
        { id: 'a', kind: 'point', x: 2, y: 2 }, { id: 'b', kind: 'point', x: 8, y: 2 }, { id: 'L1', kind: 'line', p1: 'a', p2: 'b' },
        { id: 'c', kind: 'point', x: 2, y: 5 }, { id: 'd', kind: 'point', x: 8, y: 6 }, { id: 'L2', kind: 'line', p1: 'c', p2: 'd' },
        { id: 'q1', kind: 'point', x: 10, y: 2 }, { id: 'q2', kind: 'point', x: 14, y: 2 }, { id: 'q5', kind: 'point', x: 16, y: 4 },
        { id: 'qc', kind: 'point', x: 14, y: 4 }, { id: 'L3', kind: 'line', p1: 'q1', p2: 'q2' },
        { id: 'A1', kind: 'path', anchors: ['q2', 'q5'], segments: [{ kind: 'arc', center: 'qc', sweep: 1 }], closed: false },
      ],
      constraints: [
        { id: 'k1', kind: 'equalDist', refs: ['qc', 'q2', 'qc', 'q5'] },
        { id: 'k2', kind: 'perpendicular', refs: ['q1', 'q2', 'q2', 'qc'] },
      ],
    })
  })
}
async function addRule(page: Page, c: any) {
  await page.evaluate((c) => {
    const raw = JSON.parse(JSON.stringify((window as any).__sketchDraw.doc))
    raw.constraints.push(c)
    ;(window as any).__sketchDraw.load(raw)
  }, c)
}
const menu = (page: Page) => page.locator('[data-pen-menu]')
const mi = (page: Page, id: string) => page.locator(`[data-pen-menu] [data-menu-item="${id}"]`)
const wheel = (page: Page) => page.locator('[data-pen-wheel]')

test('a right-click on a line selects it and lists its rules and actions; a greyed one says why', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 5.5)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  expect(await sel(page)).toEqual(['L2'])
  await expect(page.locator('[data-pen-menu-header]')).toHaveText('1 line')
  await expect(mi(page, 'rule:horizontal')).toBeVisible()
  await expect(mi(page, 'construction')).toContainText('X')
  await expect(mi(page, 'mirror')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'mirror').hover()
  await expect(page.locator('[data-pen-tip-id="mirror"] [data-pen-tip-reason]')).toHaveText('Select a shape first')
  await mi(page, 'rule:horizontal').click()
  await expect(menu(page)).toHaveCount(0)
  const d = await D(page)
  expect(d.constraints.some((k: any) => k.kind === 'horizontal')).toBe(true)
  const c = d.entities.find((e: any) => e.id === 'c'), dd = d.entities.find((e: any) => e.id === 'd')
  expect(Math.abs(c.y - dd.y)).toBeLessThan(1e-6)
  // the item was one undo step
  await page.keyboard.press(`${META}+z`)
  const u = await D(page)
  expect(u.constraints.map((k: any) => k.id)).toEqual(['k1', 'k2'])
  expect(u.entities.find((e: any) => e.id === 'd').y).toBeCloseTo(6, 6)
})

test('the menu by keyboard: arrows, Enter; then the same rule reads Already true; a refused pick says why and adds nothing', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 2)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.keyboard.press('ArrowDown')
  await expect(mi(page, 'rule:horizontal')).toHaveAttribute('data-active', '')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  expect((await D(page)).constraints.filter((k: any) => k.kind === 'horizontal')).toHaveLength(1)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(mi(page, 'rule:horizontal')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'rule:horizontal').hover()
  await expect(page.locator('[data-pen-tip-id="horizontal"] [data-pen-tip-reason]')).toHaveText('Already true')
  // Vertical is only checked when picked (the menu opens on cheap checks): the
  // pick is refused, the reason shows, the menu stays with it greyed, nothing added
  const before = await D(page)
  await expect(mi(page, 'rule:vertical')).not.toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'rule:vertical').click()
  await expect(page.locator('[data-status]')).toHaveText('Conflicts with another rule')
  await expect(menu(page)).toBeVisible()
  await expect(mi(page, 'rule:vertical')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'construction').hover()
  await mi(page, 'rule:vertical').hover()
  await expect(page.locator('[data-pen-tip-id="vertical"] [data-pen-tip-reason]')).toHaveText('Conflicts with another rule')
  expect(await D(page)).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  expect(await D(page)).toEqual(before)
})

test('Enter with a toolbar button focused runs the highlighted menu item, not the button', async ({ page }) => {
  await open(page); await load(page)
  const lineTool = page.locator('[data-tool="line"]')
  await lineTool.focus()
  await expect(lineTool).toBeFocused()
  const p = await at(page, 5, 5.5)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(mi(page, 'rule:horizontal')).toHaveAttribute('data-active', '')
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  expect((await D(page)).constraints.some((k: any) => k.kind === 'horizontal')).toBe(true)
  expect(await page.evaluate(() => (window as any).__sketchDraw.tool)).toBe('select')
})

test('the menu opens fast on a 150-piece connected drawing', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const entities: any[] = [], constraints: any[] = []
    for (let i = 0; i <= 150; i++) entities.push({ id: `p${i}`, kind: 'point', x: 0.5 + i * 0.12, y: 3 + (i % 2) })
    for (let i = 0; i < 150; i++) {
      entities.push({ id: `l${i}`, kind: 'line', p1: `p${i}`, p2: `p${i + 1}` })
      if (i > 0 && i % 2 === 0) constraints.push({ id: `e${i}`, kind: 'equalLength', refs: [`p${i - 1}`, `p${i}`, `p${i}`, `p${i + 1}`] })
    }
    ;(window as any).__sketchDraw.load({ entities, constraints })
  })
  // select every piece with the real key, then right-click one of them
  const hit = await at(page, 0.5 + 75.5 * 0.12, 3.5)
  await page.mouse.click(hit.x, hit.y)
  await page.keyboard.press(`${META}+a`)
  expect(await sel(page)).toHaveLength(150)
  // read-only timing: from the right press to the menu in the page
  await page.evaluate(() => {
    const w = window as any
    w.__t = { down: 0, shown: 0 }
    window.addEventListener('pointerdown', () => { w.__t.down = performance.now() }, { capture: true, once: true })
    const mo = new MutationObserver(() => {
      if (!w.__t.shown && document.querySelector('[data-pen-menu]')) { w.__t.shown = performance.now(); mo.disconnect() }
    })
    mo.observe(document.body, { childList: true, subtree: true })
  })
  await page.mouse.click(hit.x, hit.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(page.locator('[data-pen-menu-header]')).toHaveText('150 lines')
  const t = await page.evaluate(() => (window as any).__t)
  expect(t.shown - t.down).toBeLessThan(250)
})

test('empty space offers Paste and Select all; Select all selects every piece', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 17, 11)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(page.locator('[data-pen-menu-header]')).toHaveCount(0)
  await expect(mi(page, 'paste')).toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'select-all').click()
  expect((await sel(page)).sort()).toEqual(['A1', 'L1', 'L2', 'L3'])
})

test('a click on the drawing closes the menu and does nothing else', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 17, 11)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  const l2 = await at(page, 5, 5.5)
  await page.mouse.click(l2.x, l2.y)
  await expect(menu(page)).toHaveCount(0)
  expect(await sel(page)).toEqual([])
})

test('⌘C / ⌘V copy a line with its rule, 16 px down-right, selected; one undo step', async ({ page }) => {
  await open(page); await load(page)
  await addRule(page, { id: 'h1', kind: 'horizontal', refs: ['a', 'b'] })   // already level: the solve moves nothing
  const p = await at(page, 5, 2)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press(`${META}+c`)
  await page.keyboard.press(`${META}+v`)
  const d = await D(page)
  const lines = d.entities.filter((e: any) => e.kind === 'line')
  expect(lines).toHaveLength(4)
  const nl = lines[3]
  expect(await sel(page)).toEqual([nl.id])
  const np = d.entities.find((e: any) => e.id === nl.p1), a = d.entities.find((e: any) => e.id === 'a')
  expect(np.x - a.x).toBeCloseTo(16 / 34, 4)
  expect(np.y - a.y).toBeCloseTo(-16 / 34, 4)
  expect(d.constraints.filter((k: any) => k.kind === 'horizontal')).toHaveLength(2)
  await page.keyboard.press(`${META}+z`)
  expect((await D(page)).entities.filter((e: any) => e.kind === 'line')).toHaveLength(3)
})

test('the menu’s Paste lands on the right-clicked spot; Copy as SVG writes the outline', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page); await load(page)
  const l1 = await at(page, 5, 2)
  await page.mouse.click(l1.x, l1.y, { button: 'right' })
  await mi(page, 'copy-svg').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('M 2 2 L 8 2')
  await page.mouse.click(l1.x, l1.y, { button: 'right' })
  await mi(page, 'copy').click()
  const spot = await at(page, 12, 10)
  await page.mouse.click(spot.x, spot.y, { button: 'right' })
  await expect(mi(page, 'paste')).not.toHaveAttribute('aria-disabled', 'true')
  await mi(page, 'paste').click()
  const d = await D(page)
  const nl = d.entities.filter((e: any) => e.kind === 'line').at(-1)
  const p1 = d.entities.find((e: any) => e.id === nl.p1), p2 = d.entities.find((e: any) => e.id === nl.p2)
  expect((p1.x + p2.x) / 2).toBeCloseTo(12, 1)
  expect((p1.y + p2.y) / 2).toBeCloseTo(10, 1)
})

test('the wheel: right-press-drag opens it at the press point; a slice runs; the middle cancels; greyed says why', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 5.5)
  const drag = async (dx: number, dy: number) => {
    await page.mouse.move(p.x, p.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 })
  }
  // the middle cancels
  await drag(60, 0)
  await expect(wheel(page)).toBeVisible()
  await page.mouse.move(p.x + 2, p.y + 2, { steps: 4 })
  await page.mouse.up({ button: 'right' })
  await expect(wheel(page)).toHaveCount(0)
  await expect(menu(page)).toHaveCount(0)
  expect((await D(page)).constraints.map((k: any) => k.id)).toEqual(['k1', 'k2'])
  // a greyed slice says why and does nothing
  await drag(0, -70)
  await expect(page.locator('[data-wheel-slice="n"]')).toHaveAttribute('data-greyed', '')
  await expect(page.locator('[data-pen-wheel-note]')).toHaveText('Doesn’t apply to this selection')
  await page.mouse.up({ button: 'right' })
  expect((await D(page)).constraints).toHaveLength(2)
  // up-left is Horizontal
  await drag(-50, -50)
  await expect(wheel(page)).toHaveAttribute('data-layout', 'segment')
  await expect(page.locator('[data-wheel-slice="nw"]')).toHaveAttribute('data-hover', '')
  await expect(page.locator('[data-pen-wheel-note]')).toHaveText('Horizontal')
  await page.mouse.up({ button: 'right' })
  expect((await D(page)).constraints.some((k: any) => k.kind === 'horizontal')).toBe(true)
})

test('a right press whose release was lost never runs a wheel slice later', async ({ page }) => {
  await open(page); await load(page)
  const p = await at(page, 5, 5.5)
  const cdp = await page.context().newCDPSession(page)
  const mouse = (type: string, x: number, y: number, button: string, buttons: number) =>
    cdp.send('Input.dispatchMouseEvent', { type: type as any, x, y, button: button as any, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  // real browser input: right press, drag up-left until the wheel opens on Horizontal
  await mouse('mouseMoved', p.x, p.y, 'none', 0)
  await mouse('mousePressed', p.x, p.y, 'right', 2)
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p.x - 6 * i, p.y - 6 * i, 'right', 2)
  await expect(wheel(page)).toBeVisible()
  await expect(page.locator('[data-wheel-slice="nw"]')).toHaveAttribute('data-hover', '')
  // the release is lost (it happened outside the window): the next move has no button held
  await mouse('mouseMoved', p.x - 50, p.y - 52, 'none', 0)
  await expect(wheel(page)).toHaveCount(0)
  // a later left click where the slice was does not run it
  await mouse('mousePressed', p.x - 50, p.y - 52, 'left', 1)
  await mouse('mouseReleased', p.x - 50, p.y - 52, 'left', 0)
  await expect(wheel(page)).toHaveCount(0)
  expect((await D(page)).constraints.map((k: any) => k.id)).toEqual(['k1', 'k2'])
  // and a right release arriving late does nothing either
  await mouse('mouseReleased', p.x - 50, p.y - 52, 'right', 0)
  expect((await D(page)).constraints.map((k: any) => k.id)).toEqual(['k1', 'k2'])
})

test('the point wheel: two points, West joins them', async ({ page }) => {
  await open(page); await load(page)
  const a = await at(page, 2, 2), c = await at(page, 2, 5)
  await page.mouse.click(a.x, a.y)
  await page.keyboard.down('Shift'); await page.mouse.click(c.x, c.y); await page.keyboard.up('Shift')
  expect((await sel(page)).sort()).toEqual(['a', 'c'])
  await page.mouse.move(c.x, c.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(c.x - 70, c.y, { steps: 8 })
  await expect(wheel(page)).toHaveAttribute('data-layout', 'point')
  await page.mouse.up({ button: 'right' })
  expect((await D(page)).entities.some((e: any) => e.id === 'c')).toBe(false)
})

test.describe('on a Mac', () => {
  // the chromium project emulates a Windows desktop; this one reads as the
  // Mac Chrome it is (navigator.userAgentData.platform "macOS")
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' })
  test('a ctrl-click opens the menu too, selecting what it hit', async ({ page }) => {
    await open(page); await load(page)
    expect(await page.evaluate(() => (navigator as any).userAgentData?.platform)).toBe('macOS')
    const p = await at(page, 5, 5.5)
    await page.keyboard.down('Control')
    await page.mouse.click(p.x, p.y)
    await page.keyboard.up('Control')
    await expect(menu(page)).toBeVisible()
    await expect(page.locator('[data-pen-menu-header]')).toHaveText('1 line')
    expect(await sel(page)).toEqual(['L2'])
  })
})

test('Properties: a line’s length and a point’s X typed; an arc’s lock, its rule hover and removal', async ({ page }) => {
  await open(page); await load(page)
  const props = page.getByTestId('sketch-pen-properties')
  await expect(props.locator('[data-props-header]')).toHaveText('Nothing selected')
  const l1 = await at(page, 5, 2)
  await page.mouse.click(l1.x, l1.y)
  await expect(props.locator('[data-props-header]')).toHaveText('1 line')
  const len = props.locator('[data-prop="length"] input')
  await len.click({ clickCount: 3 }); await page.keyboard.type('4'); await page.keyboard.press('Enter')
  let d = await D(page)
  const A = d.entities.find((e: any) => e.id === 'a'), B = d.entities.find((e: any) => e.id === 'b')
  expect(Math.hypot(B.x - A.x, B.y - A.y)).toBeCloseTo(4, 4)
  const dot = page.locator('[data-point="c"]')
  await dot.click()
  await expect(props.locator('[data-props-header]')).toHaveText('1 point')
  const x = props.locator('[data-prop="x"] input')
  await x.click({ clickCount: 3 }); await page.keyboard.type('3'); await page.keyboard.press('Enter')
  expect((await D(page)).entities.find((e: any) => e.id === 'c').x).toBeCloseTo(3, 6)
  // the arc: Option-click picks the segment (from an empty selection — one
  // point plus one segment is a pair, kept together for point-on-curve rules)
  const empty = await at(page, 17, 11)
  await page.mouse.click(empty.x, empty.y)
  await expect(props.locator('[data-props-header]')).toHaveText('Nothing selected')
  const arc = await at(page, 14 + 2 * Math.cos(-Math.PI / 4), 4 + 2 * Math.sin(-Math.PI / 4))
  await page.keyboard.down('Alt'); await page.mouse.click(arc.x, arc.y); await page.keyboard.up('Alt')
  await expect(props.locator('[data-props-header]')).toHaveText('1 arc')
  await props.locator('[data-act="radius-lock"]').click()
  await expect(props.locator('[data-act="radius-lock"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(props).toContainText('Radius 2 — Arc 1')
  const row = props.locator('[data-rule-row="k2"]')
  await expect(row).toContainText('Tangent — Line 3 · Arc 1')
  await row.hover()
  expect((await page.evaluate(() => (window as any).__sketchDraw.highlight())).sort()).toEqual(['line:L3', 'seg:A1:0'].sort())
  await expect(page.locator('[data-highlight]')).toHaveCount(2)
  await row.locator('[data-act="rule-remove"]').click()
  d = await D(page)
  expect(d.constraints.some((k: any) => k.id === 'k2')).toBe(false)
  // the removed rule's pieces are no longer lit (the Radius row slid up under
  // the pointer and lights only its arc); off the list, nothing is lit
  expect(await page.evaluate(() => (window as any).__sketchDraw.highlight())).not.toContain('line:L3')
  await expect(props.locator('[data-rule-row]')).toHaveText(['Radius 2 — Arc 1'])
  await page.mouse.move(5, 5)
  await expect(page.locator('[data-highlight]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__sketchDraw.highlight())).toEqual([])
})

test('Repeat and Mirror copy rules never show in Properties or the menu', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const w = window as any
    w.__sketchDraw.load({
      entities: [
        { id: 'o', kind: 'point', x: 9, y: 6 },
        { id: 'a', kind: 'point', x: 10, y: 6 }, { id: 'b', kind: 'point', x: 12, y: 6 }, { id: 'L', kind: 'line', p1: 'a', p2: 'b' },
      ],
      constraints: [],
    })
    w.__sketchDraw.repeat(['L'], 'o', 4)
  })
  const d = await D(page)
  const copyRules = d.constraints.filter((k: any) => k.kind === 'rotatedFrom' || k.kind === 'mirroredFrom')
  expect(copyRules.length).toBeGreaterThan(0)
  const copy = d.entities.find((e: any) => e.kind === 'line' && e.id !== 'L')
  const p1 = d.entities.find((e: any) => e.id === copy.p1), p2 = d.entities.find((e: any) => e.id === copy.p2)
  const mid = await at(page, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
  await page.mouse.click(mid.x, mid.y)
  expect(await sel(page)).toEqual([copy.id])
  const props = page.getByTestId('sketch-pen-properties')
  await expect(props.locator('[data-props-header]')).toHaveText('1 line')
  await expect(props.locator('[data-props-rules]')).toBeVisible()
  for (const k of copyRules) await expect(props.locator(`[data-rule-row="${k.id}"]`)).toHaveCount(0)
  await expect(props).not.toContainText('Repeat copy')
  await page.mouse.click(mid.x, mid.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page)).not.toContainText('Repeat copy')
})

for (const width of [1280, 1024]) {
  test(`the menu and Properties fit at ${width} px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page); await load(page)
    const scrollBefore = await page.evaluate(() => document.documentElement.scrollWidth)
    const props = (await page.getByTestId('sketch-pen-properties').boundingBox())!
    expect(props.x + props.width).toBeLessThanOrEqual(width)
    const edge = await at(page, 18.5, 1)      // near the canvas's right edge (it ends at 18.8)
    await page.mouse.click(edge.x, edge.y, { button: 'right' })
    const m = (await menu(page).boundingBox())!
    expect(m.x).toBeGreaterThanOrEqual(0)
    expect(m.x + m.width).toBeLessThanOrEqual(width)
    expect(m.y + m.height).toBeLessThanOrEqual(800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(Math.max(scrollBefore, width))
  })
}

async function frameLine(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 })
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]')
  await page.locator('[data-testid="compositor-stage"] button[title^="Pen"]:not([data-tool])').first().click()
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  const box = (await page.locator('[data-testid="frame-pen-overlay"]').boundingBox())!
  // tools by key: at 1024 px the Frame's side panels cover the ends of the
  // pen's tool row (reported; the Frame's layout, not stage 6)
  await page.keyboard.press('l')
  await expect(page.locator('[data-tool="line"]')).toHaveAttribute('aria-pressed', 'true')
  const y = box.y + box.height / 2
  await page.mouse.click(box.x + box.width * 0.3, y)
  await page.mouse.click(box.x + box.width * 0.6, y)
  await page.keyboard.press('v')
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute('aria-pressed', 'true')
  return { box, y }
}

for (const width of [1280, 1024]) {
  test(`the Frame’s pen: right-click opens the pen’s menu, not the Frame’s; Properties in the right panel (${width} px)`, async ({ page }) => {
    const { box, y } = await frameLine(page, width)
    await page.mouse.click(box.x + box.width * 0.45, y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    await expect(page.locator('[data-pen-menu-header]')).toHaveText('1 line')
    await expect(page.getByText('Edit image…', { exact: true })).toHaveCount(0)
    const props = page.getByTestId('frame-pen-properties')
    await expect(props).toBeVisible()
    await expect(page.locator('[data-testid="compositor-right-panel"] [data-testid="frame-pen-properties"]')).toHaveCount(1)
    await expect(props.locator('[data-prop="length"]')).toBeVisible()
    const pb = (await props.boundingBox())!
    expect(pb.x + pb.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await expect(page.locator('[data-tool="path"]')).toBeVisible()
    // the wheel reaches the Frame too
    await page.mouse.move(box.x + box.width * 0.45, y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(box.x + box.width * 0.45 - 50, y - 50, { steps: 8 })
    await expect(wheel(page)).toBeVisible()
    await page.mouse.up({ button: 'right' })
    await expect(wheel(page)).toHaveCount(0)
    await expect(page.locator('[data-tool="path"]')).toBeVisible()
  })
}

test('the Frame: a typed size the rules refuse leaves the Frame’s layer unchanged', async ({ page }) => {
  const { box, y } = await frameLine(page, 1280)
  const mid = { x: box.x + box.width * 0.45, y }
  await page.mouse.click(mid.x, mid.y)
  const props = page.getByTestId('frame-pen-properties')
  await expect(props.locator('[data-props-header]')).toHaveText('1 line')
  // make the line level through the pen's menu (unless drawing it level already did)
  await page.mouse.click(mid.x, mid.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  const h = mi(page, 'rule:horizontal')
  if ((await h.getAttribute('aria-disabled')) !== 'true') await h.click()
  else await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await page.mouse.click(mid.x, mid.y)   // a rule applied clears the selection (as since stage 1)
  await expect(props.locator('[data-props-header]')).toHaveText('1 line')
  await expect(props.locator('[data-rule-row]').filter({ hasText: 'Horizontal' })).toHaveCount(1)
  const angle = props.locator('[data-prop="angle"] input')
  const shown = await angle.inputValue()
  const layersBefore = await page.evaluate(() => JSON.stringify((window as any).__compositorLayers()))
  await angle.click({ clickCount: 3 }); await page.keyboard.type('30'); await page.keyboard.press('Enter')
  // refused: the field shows the old angle, the Frame's layer did not move, the pen stays open
  await expect(angle).toHaveValue(shown)
  expect(await page.evaluate(() => JSON.stringify((window as any).__compositorLayers()))).toBe(layersBefore)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
})

test('Shape Studio’s pen: right-click opens the pen’s menu; Properties in the rail’s place; Escape leaves the studio open', async ({ page }) => {
  await page.goto('/dev/shape-studio-lab')
  await page.locator('[data-ready]').waitFor()
  await page.getByLabel('Shape', { exact: true }).selectOption('drawn')
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  await expect(page.getByTestId('shape-pen-properties')).toBeVisible()
  const box = (await page.locator('[data-testid="shape-pen-overlay"]').boundingBox())!
  await page.locator('[data-tool="line"]').click()
  const y = box.y + box.height * 0.7
  await page.mouse.click(box.x + box.width * 0.3, y)
  await page.mouse.click(box.x + box.width * 0.6, y)
  await page.locator('[data-tool="select"]').click()
  await page.mouse.click(box.x + box.width * 0.45, y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(page.locator('[data-pen-menu-header]')).toHaveText('1 line')
  await expect(page.getByTestId('shape-pen-properties').locator('[data-props-header]')).toHaveText('1 line')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator('[data-tool="path"]')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__shapeStudioLab.closes as number)).toBe(0)
})
