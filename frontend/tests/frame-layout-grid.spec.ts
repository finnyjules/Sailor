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
    // …and the quiet neutral column lines are what IS drawn.
    expect(html).toMatch(/rgba\(\s*255,\s*255,\s*255,\s*0?\.09\s*\)/)
    expect(await overlay.locator('[data-testid="compositor-grid-columns"]').getAttribute('d')).toMatch(/^M/)
  })

  test('clicking a layer selects it without showing modules or recording a step', async ({ page }) => {
    const before = (await frameLab(page)).historyRev
    const layer = page.locator('[data-testid="compositor-stack-canvas"]')
    const box = (await layer.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.locator('[data-testid="compositor-grid-modules"]')).not.toHaveClass(/\bon\b/)
    expect(before).not.toBeNull()
    expect((await frameLab(page)).historyRev).toBe(before)
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
    const original = (await frameLab(page)).layoutGrid.cols.count as number
    expect(original).not.toBe(6)
    const field = page.locator('[data-testid="grid-columns"] input, input[data-testid="grid-columns"]').first()
    await field.fill('6'); await field.press('Enter'); await field.blur()
    expect((await props(page)).sailor_layoutGrid.cols.count).toBe(6)
    await page.keyboard.press('Meta+z')
    expect((await frameLab(page)).layoutGrid.cols.count).toBe(original)
  })

  test('resizing from a side handle lands the box edge on a column edge', async ({ page }) => {
    await page.evaluate(() => (window as any).__frameLab.editor.selectLocal('strokecenter'))
    const cvBox = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
    const layer = () => page.evaluate(() => {
      const l = (window as any).__frameLab.node.data.properties.sailor_localLayers.find((x: any) => x.id === 'strokecenter')
      return { x: l.x as number, y: l.y as number, w: l.w as number }
    })
    const before = await layer()
    const grid = (await frameLab(page)).layoutGridResolved as { W: number; xs: number[] }
    // The right-edge handle: the [data-handle] nearest the box's right edge at its centre line.
    const ex = cvBox.x + (before.x + before.w / 2) * cvBox.width
    const ey = cvBox.y + before.y * cvBox.height
    const handles = await page.locator('[data-handle]').evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }))
    const h = handles.reduce((b, c) => Math.hypot(c.x - ex, c.y - ey) < Math.hypot(b.x - ex, b.y - ey) ? c : b)
    expect(Math.hypot(h.x - ex, h.y - ey)).toBeLessThan(2)
    // A column edge ≥ 30 screen px right of the box edge (a real drag).
    const scr = (xDesign: number) => cvBox.x + (xDesign / grid.W) * cvBox.width
    const line = grid.xs.find(x => scr(x) > ex + 30 && x < grid.W)!
    expect(line).toBeDefined()
    // Press 3 px off the handle's centre, then move so the EDGE sits 2 screen px short of the line
    // (the pointer is then 5 px from the line — snapping the pointer would leave the edge 3 px off).
    const px0 = h.x + 3, py0 = h.y
    const mx = px0 + (scr(line) - 2 - ex)
    await page.mouse.move(px0, py0)
    await page.mouse.down()
    await page.mouse.move(mx, py0, { steps: 8 })
    await page.mouse.up()
    const after = await layer()
    const edgeDesign = (after.x + after.w / 2) * grid.W
    expect(Math.abs(edgeDesign - line)).toBeLessThan(0.5)
  })

  test('⌘G groups two selected layers and leaves the grid alone', async ({ page }) => {
    const show0 = (await frameLab(page)).layoutGrid.show
    await page.evaluate(() => {
      const ed = (window as any).__frameLab.editor
      ed.selectLocal('strokecenter'); ed.toggleSelect('strokeinside')
    })
    await page.keyboard.press('Meta+g')
    const groups = await page.evaluate(() => {
      const ls = (window as any).__frameLab.node.data.properties.sailor_localLayers
      return ['strokecenter', 'strokeinside'].map(id => ls.find((l: any) => l.id === id)?.groupId ?? null)
    })
    expect(groups[0]).not.toBeNull()
    expect(groups[0]).toBe(groups[1])
    expect((await frameLab(page)).layoutGrid.show).toBe(show0)
  })

  test('⌃G does nothing in the middle of a drag', async ({ page }) => {
    const cvBox = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
    const l = await page.evaluate(() => (window as any).__frameLab.node.data.properties.sailor_localLayers.find((x: any) => x.id === 'strokecenter'))
    const sx = cvBox.x + l.x * cvBox.width, sy = cvBox.y + l.y * cvBox.height
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx + 40, sy, { steps: 6 })
    await page.keyboard.press('Control+g')
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toBeVisible()
    await page.mouse.up()
    expect((await frameLab(page)).layoutGrid.show).toBe(true)
  })

  test('dragging text lands its capitals on a row top, with a badge on the way', async ({ page }) => {
    const id = await page.evaluate(() => (window as any).__frameLab.node.data.properties.sailor_localLayers
      .find((l: any) => l.kind === 'text' && l.text === 'Plain text').id as string)
    await page.evaluate((i) => (window as any).__frameLab.editor.selectLocal(i), id)
    const marks = () => page.evaluate(() => (window as any).__frameLab.editor.selectedTextMarks.value as { capTop: number; baselines: number[] } | null)
    const m0 = (await marks())!
    expect(m0).not.toBeNull()
    await expect(page.locator('[data-testid="compositor-grid-text-marks"] line')).toHaveCount(m0.baselines.length + 1)
    const grid = (await frameLab(page)).layoutGridResolved as { W: number; H: number; rows: { a: number; w: number }[]; bottom: number }
    expect(grid.rows.length).toBeGreaterThan(2)
    const cvBox = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
    const k = cvBox.height / grid.H                                    // screen px per design px
    const span = m0.baselines[m0.baselines.length - 1]! - m0.capTop
    const bottoms = [...grid.rows.map(r => r.a + r.w), grid.bottom]
    // A row top ≥ 30 screen px below the capitals where the last baseline can't compete.
    const target = grid.rows.map(r => r.a).find(t => (t - m0.capTop) * k >= 30 && bottoms.every(b => Math.abs(t + span - b) * k > 8))
    expect(target).toBeDefined()
    // The canvas hit test is pixel-accurate: press on an inked pixel of the (white) text, inside
    // its own measured ink band (capitals → baseline, its own width) — the fixture's arched
    // "BADGE OF HONOUR" sits on top and reaches up next to it, so a wider scan can press that.
    const press = await page.evaluate(({ m, GW, GH }) => {
      const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
      const r = cv.getBoundingClientRect(), sx = cv.width / r.width, sy = cv.height / r.height
      const ctx = cv.getContext('2d')!
      const y0 = (m.capTop / GH) * r.height, y1 = (m.baselines[0]! / GH) * r.height
      const xa = (m.x / GW) * r.width, xb = ((m.x + m.w) / GW) * r.width
      const cx = (xa + xb) / 2
      for (let dx = 0; dx < (xb - xa) / 2; dx += 1) for (const x of [cx + dx, cx - dx]) for (let y = y0 + 2; y < y1 - 2; y += 1) {
        const px = ctx.getImageData(Math.round(x * sx), Math.round(y * sy), 1, 1).data
        if (px[0]! > 200 && px[1]! > 200 && px[2]! > 200) return { x: r.left + x, y: r.top + y }
      }
      return null
    }, { m: m0 as any, GW: grid.W, GH: grid.H })
    expect(press).not.toBeNull()
    const dyScreen = (target! - m0.capTop) * k - 2                     // capitals 2 screen px short of the row top
    await page.mouse.move(press!.x, press!.y)
    await page.mouse.down()
    expect(await page.evaluate(() => [...(window as any).__frameLab.editor.selectedIds.value])).toEqual([id])
    await page.mouse.move(press!.x, press!.y + 8, { steps: 2 })        // past the 4 px slop
    await page.mouse.move(press!.x, press!.y + dyScreen, { steps: 10 })
    await expect(page.locator('[data-testid="compositor-grid-badge"]')).toHaveText(/^\d+ × \d+ modules?$/)
    await page.mouse.up()
    const m1 = (await marks())!
    expect(Math.abs(m1.capTop - target!)).toBeLessThan(0.5)
  })

  test('typing a column moves the layer onto it in one undo step', async ({ page }) => {
    await page.evaluate(() => (window as any).__frameLab.editor.selectLocal('strokecenter'))
    const layer = () => page.evaluate(() => {
      const l = (window as any).__frameLab.node.data.properties.sailor_localLayers.find((x: any) => x.id === 'strokecenter')
      return { x: l.x as number, w: l.w as number }
    })
    const grid = (await frameLab(page)).layoutGridResolved as { W: number; cols: { a: number; w: number }[] }
    const before = await layer()
    const rev0 = (await frameLab(page)).historyRev as number
    const field = page.locator('[data-testid="layer-grid-col"]')
    const want = Number(await field.inputValue()) === 3 ? 5 : 3
    await field.fill(String(want)); await field.press('Enter'); await field.blur()
    const after = await layer()
    expect(Math.abs((after.x - after.w / 2) * grid.W - grid.cols[want - 1]!.a)).toBeLessThan(0.5)
    expect(after.w).toBe(before.w)
    expect((await frameLab(page)).historyRev).toBe(rev0 + 1)
    await page.keyboard.press('Meta+z')
    expect((await layer()).x).toBeCloseTo(before.x, 9)
  })
})

test.describe('Frame layout grid — old Frames', () => {
  test('a Frame with layers and no saved grid opens with the grid hidden', async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    // Close the editor, strip the grid the first open wrote, reopen: an old Frame's first open.
    await page.locator('[data-testid="frame-lab-toggle-modal"]').click()
    await page.evaluate(() => { delete (window as any).__frameLab.node.data.properties.sailor_layoutGrid })
    const p0 = await props(page)
    expect(p0.sailor_layoutGrid).toBeUndefined()
    expect(p0.sailor_localLayers.length).toBeGreaterThan(0)
    await page.locator('[data-testid="frame-lab-toggle-modal"]').click()
    await expect(page.locator('[data-testid="compositor-stack-canvas"]')).toBeVisible()
    await expect(page.locator('[data-testid="compositor-grid-overlay"]')).toHaveCount(0)
    await expect.poll(async () => (await props(page)).sailor_layoutGrid?.show).toBe(false)
    expect((await frameLab(page)).layoutGrid.show).toBe(false)
  })
})
