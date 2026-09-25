import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels, setStudioRow } from './_helpers'

/**
 * Print finishes Plan A — browser verification (Task 8).
 *
 * Seeds a Frame with a Gold foil text layer, a Spot UV layer, a varnish-only Spot UV
 * layer and document Halation, then checks the things a screenshot can't prove on its
 * own: the light preset actually moves the highlight, the on-canvas handle only shows
 * while a finish effect is selected, a drag + one undo round-trips cleanly, and Halation
 * changes the composite. A `cost` describe block times a synchronous paint of three foils on a
 * Frame — see its own comment for why it doesn't assert a hard threshold.
 */

const SHOTS_DIR = '/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/2ba127bf-7c10-49a0-baf2-54531bd87c59/scratchpad/finish-shots'

async function colorAt(page: Page, nx: number, ny: number) {
  return page.evaluate(([x, y]) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const px = Math.round(x * cv.width), py = Math.round(y * cv.height)
    const d = cv.getContext('2d')!.getImageData(px, py, 1, 1).data
    return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! }
  }, [nx, ny] as const)
}

/** Seeds: a dark-green background rect inset from the edges (so a canvas corner stays
 *  empty — clicking it deselects, the way `compositor-post-effects.spec.ts` does), a big
 *  serif "GOLD" text layer carrying `gold_foil`, an ellipse carrying `spot_uv`, and a
 *  stroked ring ellipse carrying `spot_uv` + `varnishOnly`. */
async function seedFinishScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const layers = [
      {
        id: 'bg', kind: 'rect', x: 0.5, y: 0.5, w: 0.96, h: 0.96, radius: 0.01,
        rotation: 0, opacity: 1, fill: '#0b3d2e', effects: [],
      },
      {
        id: 'foil', kind: 'text', x: 0.5, y: 0.32, rotation: 0, opacity: 1,
        text: 'GOLD', fontFamily: 'Georgia', fontWeight: 700, fontSize: 0.2, color: '#ffffff',
        align: 'center', lineHeight: 1.1,
        effects: [{ id: 'gf1', type: 'gold_foil', visible: true, metal: 'gold', brushed: 0.5, pressed: 0.5 }],
      },
      {
        id: 'uv', kind: 'ellipse', x: 0.3, y: 0.72, w: 0.3, h: 0.2, rotation: 0, opacity: 1,
        fill: '#0b3d2e',
        effects: [{ id: 'uv1', type: 'spot_uv', visible: true, gloss: 0.75, raised: 0.5, varnishOnly: false }],
      },
      {
        id: 'ring', kind: 'ellipse', x: 0.72, y: 0.72, w: 0.24, h: 0.24, rotation: 0, opacity: 1,
        fill: 'none', stroke: '#0b3d2e', strokeWidth: 0.02, strokeAlign: 'inside',
        effects: [{ id: 'uv2', type: 'spot_uv', visible: true, gloss: 0.9, raised: 0.4, varnishOnly: true }],
      },
    ]
    ;(window as any).__compositorSetLayers(layers)
  })
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
    { timeout: 10_000 }).toBe(4)
}

/** Expands every layer's effect disclosure so every `effect-row` is on screen — there are
 *  three (foil, uv, ring), each with exactly one effect, so `data-effect-kind` alone finds
 *  the right row without also keying on `data-layer-id`. */
async function expandAllLayerEffects(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid="layer-fx-toggle"]')
  await toggles.first().waitFor({ state: 'visible', timeout: 10_000 })
  const n = await toggles.count()
  for (let i = 0; i < n; i++) await toggles.nth(i).click()
  await expect(page.locator('[data-testid="effect-row"]')).toHaveCount(3)
}

function effectRow(page: Page, kind: 'gold_foil' | 'spot_uv') {
  return page.locator(`[data-testid="effect-row"][data-effect-kind="${kind}"]`)
}

/** Click a light preset button by its label, inside the `finish-light-preset` control
 *  (`FinishLightControl.vue`'s `StudioSegmented`, whose button text IS the label). */
async function clickPreset(page: Page, label: 'Top left' | 'Top right' | 'Overhead' | 'Raking') {
  await page.locator('[data-testid="finish-light-preset"]').getByRole('button', { name: label, exact: true }).click()
}

test.describe('Print finishes — look, handle and halation', () => {
  test('light presets move the highlight; screenshots for the look check', async ({ page }) => {
    await openCompositor(page)
    // WebGL2 must be available for the finish passes to run at all — checked here (rather
    // than as its own test) so the very first test in the file doesn't pay a cold dev-server
    // compile on top of the default 60s test timeout.
    const gl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))
    expect(gl2).toBe(true)

    await seedFinishScene(page)
    await expandAllLayerEffects(page)

    await effectRow(page, 'gold_foil').click()
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()
    await expect(page.getByTestId('frame-light-handle')).toBeVisible()
    await expect(page.getByTestId('finish-light-preset')).toBeVisible()

    const canvas = page.locator('[data-testid="compositor-stack-canvas"]')
    const presets: Array<{ label: 'Top left' | 'Top right' | 'Overhead' | 'Raking'; file: string }> = [
      { label: 'Top left', file: 'top-left.png' },
      { label: 'Top right', file: 'top-right.png' },
      { label: 'Overhead', file: 'overhead.png' },
      { label: 'Raking', file: 'raking.png' },
    ]
    const shots: Record<string, string> = {}
    for (const p of presets) {
      await clickPreset(page, p.label)
      shots[p.label] = await stackPixels(page)
      await canvas.screenshot({ path: `${SHOTS_DIR}/${p.file}` })
    }

    // The load-bearing assertion: the pixels under/around the foil text actually move
    // between two very different lighting angles — a whole-canvas compare (every finish
    // on the Frame is lit by the same light, so this also covers the spot UV + varnish
    // ring) plus a direct probe on the glyph itself.
    expect(shots['Raking']).not.toBe(shots['Top left'])
    const underTextTopLeft = await (async () => { await clickPreset(page, 'Top left'); return colorAt(page, 0.5, 0.32) })()
    const underTextRaking = await (async () => { await clickPreset(page, 'Raking'); return colorAt(page, 0.5, 0.32) })()
    expect(underTextRaking).not.toEqual(underTextTopLeft)
  })

  test('Halation changes the composite', async ({ page }) => {
    await openCompositor(page)
    await seedFinishScene(page)

    // Seeding through the hook leaves the last-seeded layer selected (same as
    // `addRect` in compositor-post-effects.spec.ts) — deselect by clicking an
    // empty artboard corner (outside the bg rect's 0.96 inset) so the frame-level
    // panel, with Post-processing, shows.
    const canvasBox = await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox()
    if (!canvasBox) throw new Error('stack canvas has no box')
    await page.mouse.click(canvasBox.x + 4, canvasBox.y + 4)
    // The section header is a `<summary>` with a chevron span ahead of the title text
    // ("› Post-processing"), so `exact: true` never matches — use a loose match instead
    // (unique on this panel). The right panel is also scrollable, with Post-processing
    // below Frame/Background/Colours, so scroll it into view before asserting.
    const postProcessing = page.getByText('Post-processing')
    await postProcessing.scrollIntoViewIfNeeded()
    await expect(postProcessing).toBeVisible()
    const before = await stackPixels(page)
    await page.locator('[data-testid="compositor-stack-canvas"]').screenshot({ path: `${SHOTS_DIR}/halation-off.png` })

    await page.locator('[data-testid="postfx-add-halation"]').click()
    await setStudioRow(page, 'postfx-halation-amount', 0.7)
    const after = await stackPixels(page)
    await page.locator('[data-testid="compositor-stack-canvas"]').screenshot({ path: `${SHOTS_DIR}/halation-on.png` })

    expect(after).not.toBe(before)
  })

  test('frame-light-handle shows only while a Gold foil or Spot UV effect is selected', async ({ page }) => {
    await openCompositor(page)
    await seedFinishScene(page)
    const handle = page.getByTestId('frame-light-handle')

    // Nothing selected: hidden.
    await expect(handle).toBeHidden()

    await expandAllLayerEffects(page)

    // A finish effect selected: visible — both kinds.
    await effectRow(page, 'gold_foil').click()
    await expect(handle).toBeVisible()
    await effectRow(page, 'spot_uv').first().click()
    await expect(handle).toBeVisible()

    // A LAYER row selected instead (no effect): the effect selection, and the handle with
    // it, clear. Picking an effect row leaves its layer's own row selected too (the
    // breadcrumb needs the layer's name), so clicking that same row again re-selects the
    // layer and clears `selectedEffect` (`onRowClick`: "picking a layer row clears the
    // effect"). Clicking empty canvas does NOT clear it — a live effect selection is
    // independent of the marquee/deselect path, by design (see CompositorModal.vue).
    await page.locator('[data-testid="compositor-left-panel"]').getByText('rect', { exact: true }).click()
    await expect(handle).toBeHidden()
  })

  test('dragging the light handle moves the highlight; one undo restores the prior light', async ({ page }) => {
    await openCompositor(page)
    await seedFinishScene(page)
    await expandAllLayerEffects(page)
    await effectRow(page, 'gold_foil').click()

    const handle = page.getByTestId('frame-light-handle')
    await expect(handle).toBeVisible()
    const before = await handle.boundingBox()
    if (!before) throw new Error('handle has no box')
    const pixelsBefore = await stackPixels(page)

    // Real pointer input (CDP mouse), not a synthetic dispatchEvent.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + 220, before.y - 120, { steps: 12 })
    await page.mouse.up()

    const after = await handle.boundingBox()
    if (!after) throw new Error('handle has no box after drag')
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(20)
    const pixelsAfter = await stackPixels(page)
    expect(pixelsAfter).not.toBe(pixelsBefore)

    // One undo — the whole drag was recorded as a single history step at pointer-down.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => {
      const b = await handle.boundingBox()
      return b ? Math.hypot(b.x - before.x, b.y - before.y) : Infinity
    }, { timeout: 5_000 }).toBeLessThan(2)
    expect(await stackPixels(page)).toBe(pixelsBefore)
  })
})

/**
 * Cost (final review item 5). Times a SYNCHRONOUS `paintLayerStack` call with
 * `performance.now()` — not rAF-to-rAF wall clock, which vsync quantises to ~16.7 ms steps.
 * The module is imported in-page from the running dev server, so it is the real painter
 * with the real GpuPost finish passes. Offscreen canvas at a 1080×1350 Frame, painted the
 * way the editor paints it: ctx scaled by the device pixel ratio, once at 1× (1080×1350
 * device px) and once at 2× (2160×2700 — the retina editor). Three Gold foil text layers,
 * 2 warm-up paints then 30 timed. Each timed paint ends with a 1×1 getImageData so the 2D
 * canvas has really finished (a GPU-backed 2D canvas otherwise defers its work past the
 * timer). Reports median/p95; over 33 ms p95 is a finding to report, not a failure.
 */
test.describe('cost', () => {
  test('synchronous paintLayerStack with three gold_foil text layers at 1x and 2x — median/p95', async ({ page }) => {
    await openCompositor(page)
    const result = await page.evaluate(async () => {
      const mod = await import('/_nuxt/@fs/Users/julien/Documents/GitHub/Sailor/frontend/app/composables/useCompositorLayers.ts' as string)
      const foil = (id: string, y: number) => ({
        id, kind: 'text', x: 0.5, y, rotation: 0, opacity: 1,
        text: 'FOIL', fontFamily: 'Georgia', fontWeight: 700, fontSize: 0.14, color: '#ffffff',
        align: 'center', lineHeight: 1.1,
        effects: [{ id: `gf-${id}`, type: 'gold_foil', visible: true, metal: 'gold', brushed: 0.5, pressed: 0.5 }],
      })
      const layers = [foil('f1', 0.2), foil('f2', 0.5), foil('f3', 0.8)]
      const items = layers.map(l => ({ type: 'local', key: `l:${l.id}`, layer: l }))
      const W = 1080, H = 1350
      const out: Record<string, { w: number; h: number; ms: number[]; goldPx: number }> = {}
      for (const dpr of [1, 2]) {
        const cv = document.createElement('canvas')
        cv.width = W * dpr; cv.height = H * dpr
        const ctx = cv.getContext('2d')!
        const paintOnce = () => {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, cv.width, cv.height)
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          mod.paintLayerStack(ctx, W, H, items, layers)
          ctx.getImageData(0, 0, 1, 1)
        }
        paintOnce(); paintOnce() // warm-up: shader compile, texture alloc, font raster
        const ms: number[] = []
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now()
          paintOnce()
          ms.push(performance.now() - t0)
        }
        // Proof the foil pass ran: white text turns gold (r well above b) only through the finish.
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data
        let goldPx = 0
        for (let p = 0; p < d.length; p += 16) if (d[p + 3]! > 128 && d[p]! - d[p + 2]! > 60) goldPx++
        out[`${dpr}x`] = { w: cv.width, h: cv.height, ms, goldPx }
      }
      return out
    })

    for (const [k, r] of Object.entries(result)) {
      const sorted = [...r.ms].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]!
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!
      test.info().annotations.push(
        { type: `${k}-canvas`, description: `${r.w}x${r.h}` },
        { type: `${k}-median-ms`, description: median.toFixed(2) },
        { type: `${k}-p95-ms`, description: p95.toFixed(2) },
        { type: `${k}-all-ms`, description: r.ms.map(d => d.toFixed(1)).join(',') },
      )
      console.log(`[print-finishes cost] ${k} canvas=${r.w}x${r.h} median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${sorted.at(-1)!.toFixed(2)}ms goldPx=${r.goldPx}`)
      expect(r.ms.length).toBe(30)
      expect(r.goldPx).toBeGreaterThan(100) // the finish really ran — not a plain-text timing
    }
  })
})
