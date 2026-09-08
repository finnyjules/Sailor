import { test, expect, type Page } from '@playwright/test'
import { openCompositor } from './_helpers'

/**
 * THE STROKE INSPECTOR'S PROP WIRING — driven through the real modal.
 *
 * Task 7's unit spec asserts `strokeInspectorRows` directly, so the eight gating rules are
 * covered as pure logic. That is not the same claim as "the inspector shows those rows":
 * the reviewer demonstrated that swapping `:show-join="hasStrokeRow('join')"` for
 * `hasStrokeRow('dash')`, or deleting `v-if="hasStrokeRow('width')"` on the Width row,
 * leaves all 23 unit cases green. A pure function cannot see which prop the template
 * handed its value to.
 *
 * So this file asks the QUESTION THE USER ASKS: with this layer selected and this stroke
 * picked, which rows are on screen? Every assertion reads the live DOM of the running app,
 * and every case asserts both the rows that must appear AND the rows that must not — a
 * one-sided assertion cannot catch a gate wired to the wrong value.
 *
 * The row markers are the `data-stroke-*` attributes the controls already carry, so this
 * spec adds no test-only hooks to production markup.
 */

const L = (over: Record<string, unknown>) => ({
  opacity: 1, rotation: 0, visible: true, ...over,
})

const RECT = (id: string, strokes: unknown[]) => L({
  id, kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.25, radius: 0, fill: '#3b82f6',
  stroke: undefined, strokeWidth: undefined, strokes,
})

/** Which inspector rows are actually rendered right now. */
async function rows(page: Page) {
  return page.evaluate(() => {
    const q = (sel: string) => !!document.querySelector(sel)
    return {
      inspector: q('[data-testid="stroke-inspector"]'),
      width: q('[data-stroke-width]'),
      distance: q('[data-stroke-distance]'),
      join: q('[data-stroke-join]'),
      align: q('[data-stroke-align]'),
      dash: q('[data-stroke-dashed]'),
      style: q('[data-stroke-style]'),
      shapes: q('[data-testid="stroke-shapes-rows"]'),
    }
  })
}

/** Set one layer, open its disclosure, pick its first stroke row. */
async function pickFirstStroke(page: Page, layer: unknown) {
  await page.evaluate(l => (window as any).__compositorSetLayers([l]), layer)
  const toggle = page.locator('[data-testid="layer-fx-toggle"]').first()
  await toggle.waitFor({ state: 'visible' })
  // The disclosure starts collapsed for a freshly committed layer.
  await toggle.click()
  const row = page.locator('[data-testid="stroke-row"]').first()
  await row.click()
  await expect(page.locator('[data-testid="stroke-inspector"]')).toBeVisible()
}

test.describe('stroke inspector — the rows that actually reach the screen', () => {
  test.beforeEach(async ({ page }) => { await openCompositor(page) })

  test('a rect stroke ON THE EDGE: Width and Dash yes, Corners no', async ({ page }) => {
    await pickFirstStroke(page, RECT('r0', [
      { id: 's1', paint: '#ffffff', width: 0.01, distance: 0, align: 'center', join: 'sharp', style: 'band' },
    ]))
    expect(await rows(page)).toEqual({
      inspector: true, width: true, distance: true,
      // Corners is dead at distance 0 — `strokeAligned` never touches `lineJoin` — and Dash
      // is live. The two disagree here, which is what makes this case able to catch a
      // `:show-join` wired to `hasStrokeRow('dash')`.
      join: false, align: true, dash: true, style: true, shapes: false,
    })
  })

  test('the SAME rect stroke at a distance: Corners in, Dash out', async ({ page }) => {
    await pickFirstStroke(page, RECT('r1', [
      { id: 's1', paint: '#ffffff', width: 0.01, distance: 0.03, align: 'center', join: 'sharp', style: 'band' },
    ]))
    expect(await rows(page)).toEqual({
      inspector: true, width: true, distance: true,
      join: true, align: true, dash: false, style: true, shapes: false,
    })
  })

  test('a SHAPES stroke hides every band-only row, Width included', async ({ page }) => {
    await pickFirstStroke(page, RECT('r2', [
      {
        id: 's1', paint: '#ffffff', width: 0.01, distance: 0, style: 'shapes',
        shapes: { shapeId: 'star', size: 0.03, spacing: 0.05, follow: true },
      },
    ]))
    expect(await rows(page)).toEqual({
      inspector: true,
      // `paintStrokeStack` dispatches on style and never reads width/align/join/dash for a
      // shapes stroke — this is the case that catches a deleted `v-if` on the Width row.
      width: false, distance: true, join: false, align: false, dash: false,
      style: true, shapes: true,
    })
    await expect(page.locator('[data-stroke-shape]')).toBeVisible()
  })

  test('a TEXT stroke on the edge: no Style row, and no Alignment either', async ({ page }) => {
    await pickFirstStroke(page, L({
      id: 't0', kind: 'text', x: 0.5, y: 0.5, text: 'Edge', fontFamily: 'Inter', fontWeight: 700,
      fontSize: 0.12, color: '#ffffff', align: 'center', lineHeight: 1.1,
      strokes: [{ id: 's1', paint: '#ff0000', width: 0.006, distance: 0, style: 'band' }],
    }))
    expect(await rows(page)).toEqual({
      inspector: true, width: true, distance: true,
      // `textStrokePasses` reads neither align nor join at distance 0, and text has no
      // outline to march shapes along.
      join: false, align: false, dash: true, style: false, shapes: false,
    })
  })

  test('a TEXT stroke AT A DISTANCE does get Alignment and Corners — the band path reads both', async ({ page }) => {
    await pickFirstStroke(page, L({
      id: 't1', kind: 'text', x: 0.5, y: 0.5, text: 'Edge', fontFamily: 'Inter', fontWeight: 700,
      fontSize: 0.12, color: '#ffffff', align: 'center', lineHeight: 1.1,
      strokes: [{ id: 's1', paint: '#ff0000', width: 0.006, distance: 0.03, style: 'band' }],
    }))
    expect(await rows(page)).toEqual({
      inspector: true, width: true, distance: true,
      join: true, align: true, dash: false, style: false, shapes: false,
    })
    // …and the panel says out loud where a distant text stroke sits in the paint order.
    await expect(page.locator('[data-testid="stroke-text-distance-note"]')).toBeVisible()
  })

  test('picking Shapes writes the style AND a usable spec — the shape rows appear at once', async ({ page }) => {
    await pickFirstStroke(page, RECT('r3', [
      { id: 's1', paint: '#ffffff', width: 0.01, distance: 0, align: 'center', join: 'sharp', style: 'band' },
    ]))
    await expect(page.locator('[data-testid="stroke-shapes-rows"]')).toHaveCount(0)
    await page.locator('[data-stroke-style]').selectOption('shapes')
    // A two-patch writer (style now, spec later) leaves `activeStroke.shapes` undefined for
    // a tick and the rows never mount — this is the wiring half of the unit spec's
    // `strokeStylePatch` claim.
    await expect(page.locator('[data-testid="stroke-shapes-rows"]')).toBeVisible()
    await expect(page.locator('[data-stroke-width]')).toHaveCount(0)
    // It really landed on the stored layer, not just in the panel.
    const stored = await page.evaluate(() => {
      const l = (window as any).__compositorLayers?.().find((x: any) => x.id === 'r3')
      return { style: l?.strokes?.[0]?.style, shapes: l?.strokes?.[0]?.shapes }
    })
    expect(stored.style).toBe('shapes')
    expect(stored.shapes).toBeTruthy()
  })

  test('the plus menu offers Add outline on a rect and never on a line', async ({ page }) => {
    // One layer at a time: the tree renders TOP-FIRST (reverse array order), so an
    // nth-index into the plus buttons of a two-layer tree silently picks the wrong row —
    // which is exactly how this case first passed its line half for the wrong reason.
    const plus = page.locator('[data-testid="add-effect"]')
    await page.evaluate(() => (window as any).__compositorSetLayers([
      { id: 'r4', kind: 'rect', x: 0.3, y: 0.3, w: 0.2, h: 0.2, radius: 0, fill: '#3b82f6', opacity: 1, rotation: 0, visible: true },
    ]))
    await expect(plus).toHaveCount(1)
    await plus.first().click({ force: true })
    await expect(page.locator('[data-testid="add-stroke"]')).toHaveCount(1)
    await plus.first().click({ force: true })          // toggle the menu shut
    await expect(page.locator('[data-testid="add-stroke"]')).toHaveCount(0)

    // …and the line, which `strokeSupportsStack` excludes: it keeps its single stroke, so
    // its menu must carry the effect kinds and no outline entry.
    await page.evaluate(() => (window as any).__compositorSetLayers([
      { id: 'ln', kind: 'line', x: 0.5, y: 0.8, w: 0.4, stroke: '#ffffff', strokeWidth: 0.004, opacity: 1, rotation: 0, visible: true },
    ]))
    await expect(plus).toHaveCount(1)
    await plus.first().click({ force: true })
    await expect(page.locator('[data-testid="add-effect-item"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="add-stroke"]')).toHaveCount(0)
  })

  /**
   * WHICH stroke the panel is showing (Task 9).
   *
   * Every case above seeds a layer with exactly ONE stroke, so an inspector hardwired to
   * `stack[0]` — ignoring the row that was clicked — passes all of them. The gap the Task 7
   * review flagged and left for the live pass.
   *
   * Nothing here reconstructs the px arithmetic. The tree row renders
   * `strokeRowLabel(row.stroke)` from its own prop and the breadcrumb renders
   * `strokeRowLabel(activeStroke)` from the selection, so the two agreeing IS the claim
   * "the panel resolved the stroke this row stands for" — and the Width field, which is
   * `strokePxW(activeStroke.width)`, must carry the same px the label already printed.
   * The three strokes differ in width AND distance so all three readings are distinguishable.
   */
  test('selecting a NON-FIRST stroke shows THAT stroke — and edits THAT stroke', async ({ page }) => {
    await page.evaluate(l => (window as any).__compositorSetLayers([l]), RECT('multi', [
      { id: 'a', paint: '#ff0000', width: 0.01, distance: 0, align: 'center', join: 'sharp', style: 'band' },
      { id: 'b', paint: '#00ff00', width: 0.04, distance: 0.06, align: 'center', join: 'sharp', style: 'band' },
      { id: 'c', paint: '#0000ff', width: 0.02, distance: 0.12, align: 'center', join: 'sharp', style: 'band' },
    ]))
    await page.locator('[data-testid="layer-fx-toggle"]').first().click()
    const rows = page.locator('[data-testid="stroke-row"]')
    await expect(rows).toHaveCount(3)

    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      await rows.nth(i).click()
      await expect(page.locator('[data-testid="stroke-inspector"]')).toBeVisible()
      const label = (await rows.nth(i).innerText()).trim()
      // `${w} px` on the edge, `${w} px, ${d} px out` at a distance.
      const m = /^(\d+) px(?:, (\d+) px out)?$/.exec(label)
      expect(m, `row ${i} label: ${label}`).toBeTruthy()
      await expect(page.locator('[data-testid="stroke-breadcrumb"]')).toContainText(label)
      await expect(page.locator('[data-stroke-width]')).toHaveValue(m![1]!)
      await expect(page.locator('[data-stroke-distance]')).toHaveValue(m![2] ?? '0')
      seen.push(label)
    }
    // Three DISTINCT readings: a panel showing stack[0] three times would repeat one.
    expect(new Set(seen).size, `distinct readings, got ${JSON.stringify(seen)}`).toBe(3)
    // …in the stored order — widths 0.01 < 0.04 > 0.02, distances 0 < 0.06 < 0.12.
    const wPx = seen.map(l => Number(/^(\d+)/.exec(l)![1]))
    expect(wPx[1]!).toBeGreaterThan(wPx[2]!)
    expect(wPx[2]!).toBeGreaterThan(wPx[0]!)

    // …and a write from the panel lands on the stroke that is on screen, not on stack[0].
    await rows.nth(1).click()
    await page.locator('[data-stroke-width]').fill(String(wPx[1]! + 20))
    await expect.poll(async () => {
      const l = await page.evaluate(() => (window as any).__compositorLayers()[0])
      return l.strokes.map((s: any) => s.width)
    }, { timeout: 10_000 }).not.toEqual([0.01, 0.04, 0.02])
    const after = await page.evaluate(() => (window as any).__compositorLayers()[0])
    expect(after.strokes.map((s: any) => s.id)).toEqual(['a', 'b', 'c'])
    expect(after.strokes[0].width, 'the first stroke is untouched').toBe(0.01)
    expect(after.strokes[2].width, 'and so is the third').toBe(0.02)
    expect(after.strokes[1].width).toBeGreaterThan(0.04)
  })

  test('one breadcrumb at a time: an effect row closes the stroke inspector, and back', async ({ page }) => {
    await pickFirstStroke(page, RECT('r5', [
      { id: 's1', paint: '#ffffff', width: 0.01, distance: 0, align: 'center', join: 'sharp', style: 'band' },
    ]))
    // Add an effect through the same plus menu the outline came from.
    await page.locator('[data-testid="add-effect"]').first().click({ force: true })
    const item = page.locator('[data-testid="add-effect-item"]:not([disabled])').first()
    await item.click()
    await expect(page.locator('[data-testid="effect-row"]').first()).toBeVisible()

    await page.locator('[data-testid="effect-row"]').first().click()
    await expect(page.locator('[data-testid="effect-breadcrumb"]')).toBeVisible()
    await expect(page.locator('[data-testid="stroke-inspector"]')).toHaveCount(0)

    await page.locator('[data-testid="stroke-row"]').first().click()
    await expect(page.locator('[data-testid="stroke-breadcrumb"]')).toBeVisible()
    await expect(page.locator('[data-testid="effect-breadcrumb"]')).toHaveCount(0)
  })
})
