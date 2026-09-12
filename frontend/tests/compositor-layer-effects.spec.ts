import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels, setStudioRow } from './_helpers'

/**
 * Per-layer effects as an ordered stack — end to end.
 *
 * The load-bearing test is `read-through parity`: a layer stored in the LEGACY shape (no ids,
 * torn edge and feather as their own fields) and the same layer stored explicitly in the new
 * shape must render identical pixels. That is what protects every saved frame, and it cannot
 * be argued with by looking at a screenshot.
 */

/** Add a rectangle through the toolbar; it becomes the selected layer. */
async function addRect(page: Page): Promise<void> {
  await page.getByTitle('Add rectangle').click()
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
    { timeout: 10_000 }).toBe(1)
}

/** Seeding a stack through the hook does not open the layer's disclosure — that is UI state a
 *  user click owns. Open it so the effect rows are on screen. */
async function expandLayerEffects(page: Page): Promise<void> {
  const chevron = page.locator('[data-testid="layer-fx-toggle"]').first()
  await chevron.waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('[data-testid="effect-row"]').count() === 0) await chevron.click()
  await expect(page.locator('[data-testid="effect-row"]').first()).toBeVisible()
}

const kindsOf = (page: Page) => page.evaluate(() =>
  ((window as any).__compositorLayers()[0].effects || []).map((e: any) => e.type))

test.describe('Frame per-layer effect stack', () => {
  test('read-through parity: a legacy-shaped layer renders exactly like the explicit stack', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    // The bare rect, so the comparison below is known to be over a render the effects
    // actually changed — two identically-empty canvases would "match" for the wrong reason.
    const bare = await stackPixels(page)

    // Explicit new shape: ids, canonical order, torn edge and feather as entries.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'e1', type: 'adjust', brightness: 1.4, contrast: 1, saturation: 1, hue: 0, visible: true },
        { id: 'e2', type: 'grain', amount: 0.5, size: 3, visible: true },
        { id: 'e3', type: 'torn_edge', style: 'ripped', amount: 14, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7, visible: true },
        { id: 'e4', type: 'feather', amount: 0.18, curve: 'smooth', visible: true },
        { id: 'e5', type: 'drop_shadow', color: 'rgba(0,0,0,0.4)', x: 0.01, y: 0.01, blur: 0.02, visible: true },
      ]
      delete ls[0].tornEdge; delete ls[0].feather
      ;(window as any).__compositorSetLayers(ls)
    })
    const explicit = await stackPixels(page)
    expect(explicit).not.toBe(bare)

    // The same layer in the LEGACY shape: no ids, effects in an arbitrary order, torn edge and
    // feather back on their own fields.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { type: 'drop_shadow', color: 'rgba(0,0,0,0.4)', x: 0.01, y: 0.01, blur: 0.02, visible: true },
        { type: 'grain', amount: 0.5, size: 3, visible: true },
        { type: 'adjust', brightness: 1.4, contrast: 1, saturation: 1, hue: 0, visible: true },
      ]
      ls[0].tornEdge = { style: 'ripped', amount: 14, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7 }
      ls[0].feather = { amount: 0.18, curve: 'smooth' }
      ;(window as any).__compositorSetLayers(ls)
    })
    const legacy = await stackPixels(page)

    expect(legacy).toBe(explicit)
  })

  test('order matters: swapping two effects changes the pixels', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    const set = (order: string[]) => page.evaluate((ord) => {
      const ls = (window as any).__compositorLayers()
      const byType: Record<string, any> = {
        gradientMap: { id: 'g', type: 'gradientMap', stops: [{ pos: 0, color: '#001133' }, { pos: 1, color: '#ffcc00' }], contrast: 0, mix: 1, visible: true },
        adjust: { id: 'a', type: 'adjust', brightness: 1, contrast: 1.9, saturation: 1, hue: 0, visible: true },
      }
      ls[0].effects = ord.map(t => byType[t])
      ;(window as any).__compositorSetLayers(ls)
    }, order)

    await set(['gradientMap', 'adjust'])
    const mapThenAdjust = await stackPixels(page)
    await set(['adjust', 'gradientMap'])
    const adjustThenMap = await stackPixels(page)
    expect(adjustThenMap).not.toBe(mapThenAdjust)
  })

  test('two instances of one kind both apply', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    const withN = (n: number) => page.evaluate((count) => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = Array.from({ length: count }, (_, i) => ({
        id: `b${i}`, type: 'bloom', threshold: 0.2, radius: 0.02, intensity: 1, visible: true,
      }))
      ;(window as any).__compositorSetLayers(ls)
    }, n)
    await withN(1)
    const one = await stackPixels(page)
    await withN(2)
    expect(await stackPixels(page)).not.toBe(one)
  })

  test('tree flow: add from the plus menu, tune, reorder by drag, remove', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)

    const row = page.locator('[data-testid="add-effect"]').first()
    await row.hover()
    await row.click()
    await page.locator('[data-testid="add-effect-item"][data-kind="bloom"]').click()

    const bloomRow = page.locator('[data-testid="effect-row"][data-effect-kind="bloom"]')
    await expect(bloomRow).toBeVisible()
    await expect(bloomRow).toHaveText(/Bloom/)
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()

    // The inspector shows this instance's dials, and a dial write reaches the stored effect.
    const intensity = page.locator('[data-testid="postfx-bloom-intensity"]')
    await expect(intensity).toBeVisible()
    await setStudioRow(page, 'postfx-bloom-intensity', 1.4)
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || [])
        .find((e: any) => e.type === 'bloom')?.intensity)).toBe(1.4)

    // A second kind, then reorder them by dragging the first onto the second.
    await row.click()
    await page.locator('[data-testid="add-effect-item"][data-kind="grain"]').click()
    expect(await kindsOf(page)).toEqual(['bloom', 'grain'])
    await bloomRow.dragTo(page.locator('[data-testid="effect-row"][data-effect-kind="grain"]'))
    await expect.poll(() => kindsOf(page)).toEqual(['grain', 'bloom'])

    // Eye toggle writes visible:false; trash removes the instance.
    await bloomRow.hover()
    await bloomRow.getByRole('button', { name: 'Hide effect' }).click()
    expect(await page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'bloom').visible)).toBe(false)
    await bloomRow.hover()
    await bloomRow.getByRole('button', { name: 'Remove effect' }).click()
    await expect(bloomRow).toHaveCount(0)
    expect(await kindsOf(page)).toEqual(['grain'])
  })

  // Delete used to fall straight through to the layer handler, so pressing it while tuning an
  // effect threw away the whole layer. The layer must survive, and only the effect go.
  test('Backspace with an effect row selected removes the effect, not its layer', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'a', type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true },
        { id: 'g', type: 'grain', amount: 0.2, size: 2, visible: true },
      ]
      ;(window as any).__compositorSetLayers(ls)
    })
    await expandLayerEffects(page)
    const layerCount = () => page.evaluate(() => (window as any).__compositorLayers().length)
    expect(await layerCount()).toBe(1)

    await page.locator('[data-testid="effect-row"][data-effect-kind="grain"]').click()
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()
    await page.keyboard.press('Backspace')

    await expect.poll(() => kindsOf(page)).toEqual(['adjust'])
    expect(await layerCount()).toBe(1)
  })

  test('a pinned effect cannot be dragged out of position', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'bg', type: 'background_blur', radius: 0.02, visible: true },
        { id: 'a', type: 'adjust', brightness: 1.2, contrast: 1, saturation: 1, hue: 0, visible: true },
      ]
      ;(window as any).__compositorSetLayers(ls)
    })
    await expandLayerEffects(page)
    const bg = page.locator('[data-testid="effect-row"][data-effect-kind="background_blur"]')
    const adj = page.locator('[data-testid="effect-row"][data-effect-kind="adjust"]')
    await expect(bg).toBeVisible()
    await expect(bg).toHaveAttribute('draggable', 'false')
    await adj.dragTo(bg)
    expect(await kindsOf(page)).toEqual(['background_blur', 'adjust'])
  })
})

/**
 * F2 Task 5 — geometry effects render through a computed outline `d`.
 *
 * The rect is drawn through its shared, geometry-transformed Path2D only when a geometry
 * effect is present; with none it keeps the imperative round-rect fast path, so a no-effect
 * rect stays byte-identical to the pre-F2 render. These prove both halves.
 */
async function seedRectFill(page: Page): Promise<void> {
  // A big, opaque, sharp-cornered rect so a corner change moves a lot of pixels.
  await page.evaluate(() => {
    const ls = (window as any).__compositorLayers()
    ls[0].w = 0.6; ls[0].h = 0.6; ls[0].radius = 0; ls[0].fill = '#ffffff'
    ls[0].effects = []
    ;(window as any).__compositorSetLayers(ls)
  })
}

/** Max & mean per-channel delta between two toDataURL PNGs, decoded in the page. */
async function pixelDelta(page: Page, a: string, b: string) {
  return page.evaluate(async ([da, db]) => {
    const load = (url: string) => new Promise<ImageData>((res, rej) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
        const cx = c.getContext('2d')!; cx.drawImage(img, 0, 0)
        res(cx.getImageData(0, 0, img.width, img.height))
      }
      img.onerror = rej; img.src = url
    })
    const [ia, ib] = [await load(da), await load(db)]
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true, max: 255, mean: 255, changed: -1 }
    let max = 0, sum = 0, changed = 0
    for (let i = 0; i < ia.data.length; i++) {
      const d = Math.abs(ia.data[i] - ib.data[i])
      if (d > max) max = d
      sum += d
      if (i % 4 !== 3 && d > 2) changed++
    }
    return { sizeMismatch: false, max, mean: sum / ia.data.length, changed }
  }, [a, b] as const)
}

test.describe('Frame geometry effects (F2)', () => {
  test('round_corners changes the rendered pixels; an invisible one does not', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const sharp = await stackPixels(page)

    // A real, visible round-corners effect must move pixels (the corners are eaten in).
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'rc', type: 'round_corners', radius: 0.12, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const rounded = await stackPixels(page)
    expect(rounded).not.toBe(sharp)
    const sens = await pixelDelta(page, sharp, rounded)
    expect(sens.sizeMismatch).toBe(false)
    expect(sens.changed).toBeGreaterThan(200) // corners actually carved

    // An INVISIBLE geometry effect is filtered out → the imperative fast path → identical bytes.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'rc', type: 'round_corners', radius: 0.12, visible: false }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const hidden = await stackPixels(page)
    expect(hidden).toBe(sharp)
  })

  test('byte-identity A/B: a no-geometry rect renders identically before/after the F2 seam', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const before = await stackPixels(page)

    // Toggle a visible geometry effect ON then back to none: the return-to-none render must be
    // the same imperative round-rect pixels as before it was ever touched.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'off', type: 'offset', distance: 0.05, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    await stackPixels(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = []
      ;(window as any).__compositorSetLayers(ls)
    })
    const after = await stackPixels(page)

    const delta = await pixelDelta(page, before, after)
    // eslint-disable-next-line no-console
    console.log('[F2 byte-identity A/B] max=%d mean=%s changed=%d', delta.max, delta.mean.toFixed(4), delta.changed)
    expect(delta.sizeMismatch).toBe(false)
    expect(delta.max).toBeLessThanOrEqual(2) // Δ2 threshold
    expect(after).toBe(before)               // and in fact byte-identical
  })
})
