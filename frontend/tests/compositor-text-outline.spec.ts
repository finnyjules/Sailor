import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Frame slice F1, Task 3 — layout parity between `fillText` and glyph OUTLINES.
 *
 * The proof: the SAME text layer, rendered once through `fillText` (renderAsOutline
 * off) and once from real glyph outlines (renderAsOutline on), must land on the same
 * pixels — because the outline reuses `drawText`'s own layout via the collect sink,
 * not a reimplementation. We compare the two composites per-pixel and require ≥99%
 * within Δ2 (a 3-channel + alpha max-delta histogram computed in-page).
 *
 * The font is Inter at weight 400: a family Vector Type curates as a VARIABLE
 * file, so the outline path (`compositorFontToken` → catalog id) and the CSS
 * `fillText` path load the SAME bytes at the SAME (default) axis position — the
 * only way glyph geometry is guaranteed identical, so any pixel gap is a LAYOUT
 * gap (the thing under test), not a font-file or weight-axis difference. (Weight
 * axis threading into the outline is Task 6; a `google:Family@700` static cut
 * fetches DIFFERENT bytes than css2's Google file and drifts a few percent.)
 * `__compositorTextOutline(0)` returning a non-null `d` confirms the outline path
 * actually ran rather than silently falling back to `fillText`.
 */

const FONT = 'Inter'
const WEIGHT = 400

function textLayer(patch: Record<string, unknown> = {}) {
  return {
    id: 't1', kind: 'text',
    x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    text: 'Outline', fontFamily: FONT, fontWeight: WEIGHT, fontSize: 0.16,
    color: '#111111', align: 'center', lineHeight: 1.2,
    strokeColor: '#000000', strokeWidth: 0,
    renderAsOutline: false,
    ...patch,
  }
}

async function seed(page: Page, layers: Record<string, unknown>[]) {
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), layers)
}

/** Wait until the CSS face used by `fillText` is actually available, so the
 *  fillText capture is the real font (not a fallback), then let the render settle. */
async function waitFontReady(page: Page) {
  await expect.poll(async () => page.evaluate(
    ([fam, w]) => (document as any).fonts.check(`${w} 100px "${fam}"`),
    [FONT, WEIGHT] as const,
  ), { timeout: 15_000 }).toBe(true)
  await stackPixels(page) // poll the composite to stability
}

/** Stash the current stack-canvas pixels on `window[key]`. */
async function stash(page: Page, key: string) {
  await page.evaluate((k) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    ;(window as any)[k] = { w: cv.width, h: cv.height, data: ctx.getImageData(0, 0, cv.width, cv.height).data }
  }, key)
}

/** Per-pixel max-delta histogram of the current composite vs the stashed one. */
async function compareToStash(page: Page, key: string) {
  return page.evaluate((k) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    const prev = (window as any)[k] as { w: number; h: number; data: Uint8ClampedArray }
    const cur = ctx.getImageData(0, 0, cv.width, cv.height).data
    const a = prev.data, b = cur
    if (a.length !== b.length) return { total: 0, within2: 0, withinPct: 0, mismatchSize: true }
    let within2 = 0
    const total = a.length / 4
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(
        Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!),
        Math.abs(a[i + 2]! - b[i + 2]!), Math.abs(a[i + 3]! - b[i + 3]!),
      )
      if (d <= 2) within2++
    }
    return { total, within2, withinPct: within2 / total, mismatchSize: false }
  }, key)
}

/** Confirm the outline path resolved a real `d` (font loaded), not a fallback. */
async function outlineResolved(page: Page) {
  await expect.poll(async () => page.evaluate(() => {
    const d = (window as any).__compositorTextOutline?.(0)
    return typeof d === 'string' && d.length > 10
  }), { timeout: 15_000 }).toBe(true)
}

/** Assert the composite has ink (not a blank canvas). */
async function assertNonBlank(page: Page) {
  const distinct = await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    const seen = new Set<number>()
    for (let i = 0; i < d.length; i += 4) { seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!); if (seen.size > 3) break }
    return seen.size
  })
  expect(distinct).toBeGreaterThan(1)
}

test.describe('Compositor text → outline parity', () => {
  test('a single-line centred layer outlines identically to fillText', async ({ page }) => {
    await openCompositor(page)

    // fillText render.
    await seed(page, [textLayer({ renderAsOutline: false })])
    await waitFontReady(page)
    await assertNonBlank(page)
    await stash(page, '__fillText')

    // Outline render of the SAME layer.
    await seed(page, [textLayer({ renderAsOutline: true })])
    await outlineResolved(page)
    await stackPixels(page)
    await assertNonBlank(page)

    const r = await compareToStash(page, '__fillText')
    expect(r.mismatchSize).toBe(false)
    console.log(`[parity single-line] within Δ2: ${(r.withinPct * 100).toFixed(3)}% (${r.within2}/${r.total})`)
    expect(r.withinPct).toBeGreaterThanOrEqual(0.99)
  })

  test('a centred, letter-spaced, multi-line layer outlines identically to fillText', async ({ page }) => {
    await openCompositor(page)
    const patch = { text: 'Sailor\nframe', align: 'center', letterSpacing: 0.08, fontSize: 0.12, lineHeight: 1.3 }

    await seed(page, [textLayer({ ...patch, renderAsOutline: false })])
    await waitFontReady(page)
    await assertNonBlank(page)
    await stash(page, '__fillText2')

    await seed(page, [textLayer({ ...patch, renderAsOutline: true })])
    await outlineResolved(page)
    await stackPixels(page)
    await assertNonBlank(page)

    const r = await compareToStash(page, '__fillText2')
    expect(r.mismatchSize).toBe(false)
    console.log(`[parity centred+spaced+multiline] within Δ2: ${(r.withinPct * 100).toFixed(3)}% (${r.within2}/${r.total})`)
    // The configuration the Task 2 review flagged: if Chromium's canvas letterSpacing
    // model differed from runToCommands', this is where it would show.
    expect(r.withinPct).toBeGreaterThanOrEqual(0.99)
  })

  test('a badge (circle path) outlines identically to the fillText path render', async ({ page }) => {
    await openCompositor(page)
    // Type on a ring: each glyph is placed and turned by `placeGlyphs`, then drawn
    // — as `fillText` in its own rotated frame (flag off) or as its OUTLINE placed
    // on the same guide (flag on). The two must land on the same pixels.
    const patch = { text: 'BADGE', fontSize: 0.06, align: 'center', path: { follow: 'circle', radius: 0.12 } }

    await seed(page, [textLayer({ ...patch, renderAsOutline: false })])
    await waitFontReady(page)
    await assertNonBlank(page)
    await stash(page, '__fillTextBadge')

    await seed(page, [textLayer({ ...patch, renderAsOutline: true })])
    await outlineResolved(page)          // the ON-PATH outline `d` resolved, not a fillText fallback
    await stackPixels(page)
    await assertNonBlank(page)

    const r = await compareToStash(page, '__fillTextBadge')
    expect(r.mismatchSize).toBe(false)
    console.log(`[parity badge/circle] within Δ2: ${(r.withinPct * 100).toFixed(3)}% (${r.within2}/${r.total})`)
    expect(r.withinPct).toBeGreaterThanOrEqual(0.99)
  })

  test('the histogram is sensitive: two visibly different renders differ', async ({ page }) => {
    await openCompositor(page)

    // A short word…
    await seed(page, [textLayer({ text: 'Ii', fontSize: 0.1, renderAsOutline: true })])
    await outlineResolved(page)
    await stackPixels(page)
    await stash(page, '__sparse')

    // …vs a large, dense block that fills much more of the frame.
    await seed(page, [textLayer({ text: 'BLOCK', fontSize: 0.34, renderAsOutline: true })])
    await outlineResolved(page)
    await stackPixels(page)

    const r = await compareToStash(page, '__sparse')
    console.log(`[sensitivity] within Δ2: ${(r.withinPct * 100).toFixed(3)}% (should be well below 99%)`)
    // If the harness could not tell renders apart, this would be ~100%.
    expect(r.withinPct).toBeLessThan(0.99)
  })
})
