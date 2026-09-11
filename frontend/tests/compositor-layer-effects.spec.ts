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

/**
 * F2 Task 6 — add-menu gating and inspector dials for the four geometry effects.
 *
 * Gating: geometry kinds are greyed for a layer with no outline (image) and for decorated
 * text, and enabled for a plain vector (rect). Inspector: selecting a geometry effect shows
 * its dials, a dial write reaches the stored param and moves the pixels — no dead control.
 * Render fix A: a geometry effect on a text layer whose `renderAsOutline` is unset still
 * forces the outline path (Inter) and safely falls back to fillText on a system font (Arial).
 */
const GEOMETRY_KINDS = ['trim', 'offset', 'round_corners', 'roughen', 'boolean', 'morph', 'warp', 'shatter', 'long_shadow'] as const
// A 1×1 transparent PNG so an image layer has a valid, instantly-decoding source.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Open the plus menu for the (single seeded) layer and wait for its items. */
async function openFxMenuFirst(page: Page): Promise<void> {
  const btn = page.locator('[data-testid="add-effect"]').first()
  await btn.hover()
  await btn.click()
  await expect(page.locator('[data-testid="add-effect-item"][data-kind="trim"]')).toBeVisible()
}

async function seedOne(page: Page, layer: Record<string, unknown>): Promise<void> {
  await page.evaluate((l) => (window as any).__compositorSetLayers([l]), layer)
}

test.describe('Frame geometry effects — menu gating + inspector dials (F2 Task 6)', () => {
  test('greyed on an image layer, with a "needs a vector shape" reason — except warp', async ({ page }) => {
    await openCompositor(page)
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: TINY_PNG })
    await openFxMenuFirst(page)
    // Every outline-only geometry kind is greyed on an image; WARP is the one kind that also
    // runs on raster layers (F3 4b — pixel-domain mesh warp), so it stays enabled.
    for (const k of GEOMETRY_KINDS) {
      const item = page.locator(`[data-testid="add-effect-item"][data-kind="${k}"]`)
      if (k === 'warp') await expect(item, k).toBeEnabled()
      else await expect(item, k).toBeDisabled()
    }
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="trim"]'))
      .toHaveAttribute('title', /vector shape/)
    // A pixel effect stays offered — only geometry is gated on the outline.
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="grain"]')).toBeEnabled()
  })

  test('enabled on a rect', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    for (const k of GEOMETRY_KINDS)
      await expect(page.locator(`[data-testid="add-effect-item"][data-kind="${k}"]`)).toBeEnabled()
  })

  test('greyed on underlined text, with a decoration reason', async ({ page }) => {
    await openCompositor(page)
    await seedOne(page, {
      id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'Hi',
      fontFamily: 'Inter', fontWeight: 700, fontSize: 0.1, color: '#ffffff', align: 'center', lineHeight: 1.1,
      underline: true,
    })
    await openFxMenuFirst(page)
    const trim = page.locator('[data-testid="add-effect-item"][data-kind="trim"]')
    await expect(trim).toBeDisabled()
    await expect(trim).toHaveAttribute('title', /Underlined or struck-through/)
  })

  test('selecting Trim path shows a dial that moves the stored param and the pixels', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const before = await stackPixels(page)

    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="trim"]').click()

    // The inspector shows this instance's trim card (breadcrumb + a start/end control).
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()
    const end = page.locator('[data-testid="geo-trim-end"]')
    await expect(end).toBeVisible()

    // A dial write reaches the stored effect param …
    await end.fill('50')
    await end.blur()
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'trim')?.end))
      .toBeCloseTo(0.5, 5)
    // … and moves the pixels (a half-trimmed, auto-closed fill is a different shape).
    const after = await stackPixels(page)
    expect(after).not.toBe(before)
  })

  test('Trim on an Inter text layer changes pixels; on an Arial system font it still renders', async ({ page }) => {
    await openCompositor(page)

    // Inter — outline-able. Render fix A: geometry forces the outline path even with
    // renderAsOutline unset.
    await seedOne(page, {
      id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'Trim',
      fontFamily: 'Inter', fontWeight: 700, fontSize: 0.2, color: '#ffffff', align: 'center', lineHeight: 1.1,
    })
    await expect.poll(() => page.evaluate(() => {
      const d = (window as any).__compositorTextOutline?.(0)
      return typeof d === 'string' && d.length > 10
    }), { timeout: 15_000 }).toBe(true)
    const interBefore = await stackPixels(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'tr', type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const interAfter = await stackPixels(page)
    expect(interAfter).not.toBe(interBefore)

    // Arial — a system font with no byte source. collectTextOutline returns null → safe
    // fillText fallback: no crash, still inks.
    await seedOne(page, {
      id: 't2', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'Trim',
      fontFamily: 'Arial', fontWeight: 700, fontSize: 0.2, color: '#ffffff', align: 'center', lineHeight: 1.1,
      effects: [{ id: 'tr', type: 'trim', start: 0, end: 0.5, offset: 0, visible: true }],
    })
    await stackPixels(page)
    const distinct = await page.evaluate(() => {
      const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
      const seen = new Set<number>()
      for (let i = 0; i < d.length; i += 4) { seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!); if (seen.size > 3) break }
      return seen.size
    })
    expect(distinct).toBeGreaterThan(1)
  })
})

/**
 * F2 Task 8 (Minor 1) — offscreen rasters pad for OUTWARD geometry growth.
 *
 * A box-sized silhouette raster (torn edge / feather) is sized from the layer's box, which
 * knows nothing about a geometry transform. Before the fix, a positive `offset` pushed the
 * fill PAST the box edge and the feather raster clipped it back to the box. `geometryOutwardPx`
 * grows the pad by the geometry's outward reach, so the grown ink survives.
 *
 * The two Task-6 dial tests below also cover the two params the inspector was missing until
 * Task 7's engine/agent added them: trim `offset` and roughen `detail`.
 */

/** Normalized [0,1] bounding box of ink (alpha > 40) on the stack canvas. */
async function inkExtent(page: Page) {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    let minX = 1, maxX = 0, minY = 1, maxY = 0, any = false
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (d[(y * cv.width + x) * 4 + 3]! > 40) {
          any = true
          const nx = x / cv.width, ny = y / cv.height
          if (nx < minX) minX = nx; if (nx > maxX) maxX = nx
          if (ny < minY) minY = ny; if (ny > maxY) maxY = ny
        }
      }
    }
    return { any, minX, maxX, minY, maxY }
  })
}

test.describe('Frame geometry effects — offscreen pad for outward growth (F2 Task 8)', () => {
  test('a big positive offset + feather is NOT clipped at the box edge', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    // A 0.6-wide, sharp white rect centred at 0.5 ⇒ original box edges at x∈{0.2,0.8}.
    await seedRectFill(page)

    // Reference: offset ONLY. It never touches the silhouette raster, so its grown extent is
    // never clipped — grown edge ≈ 0.8 + 0.1 = 0.9.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'off', type: 'offset', distance: 0.1, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    await stackPixels(page)
    const offsetOnly = await inkExtent(page)
    expect(offsetOnly.any).toBe(true)
    expect(offsetOnly.maxX).toBeGreaterThan(0.85) // grown well past the 0.8 box edge

    // Now the same offset PLUS a feather. Before the pad fix the feather raster was box-sized
    // and clipped the grown fill back to ~0.8; with the fix it holds the grown ink.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'off', type: 'offset', distance: 0.1, visible: true },
        { id: 'ft', type: 'feather', amount: 0.06, curve: 'smooth', visible: true },
      ]
      ;(window as any).__compositorSetLayers(ls)
    })
    await stackPixels(page)
    const withFeather = await inkExtent(page)

    // eslint-disable-next-line no-console
    console.log('[F2 clip] offsetOnly.maxX=%s withFeather.maxX=%s', offsetOnly.maxX.toFixed(3), withFeather.maxX.toFixed(3))
    // The grown ink still reaches well past the original box edge (0.8) — not clipped back.
    expect(withFeather.maxX).toBeGreaterThan(0.83)
    // And it tracks the unclipped reference within the feather's own soft falloff.
    expect(withFeather.maxX).toBeGreaterThan(offsetOnly.maxX - 0.06)
  })

  test('the trim Offset dial reaches the stack and moves the pixels', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)

    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="trim"]').click()
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()

    // Trim to half so the window has somewhere to rotate to (a full 0..1 loop would be a no-op).
    const end = page.locator('[data-testid="geo-trim-end"]')
    await end.fill('50'); await end.blur()
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'trim')?.end))
      .toBeCloseTo(0.5, 5)
    const before = await stackPixels(page)

    // The Offset dial (shown as a percentage) must reach the stored fraction and rotate the window.
    const off = page.locator('[data-testid="geo-trim-offset"]')
    await expect(off).toBeVisible()
    await off.fill('25'); await off.blur()
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'trim')?.offset))
      .toBeCloseTo(0.25, 5)
    const after = await stackPixels(page)
    expect(after).not.toBe(before)
  })

  test('the roughen Detail dial reaches the stack and changes the pixels', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)

    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="roughen"]').click()
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()
    const before = await stackPixels(page)

    const detail = page.locator('[data-testid="geo-roughen-detail"]')
    await expect(detail).toBeVisible()
    await detail.fill('24'); await detail.blur()
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'roughen')?.detail))
      .toBe(24)
    const after = await stackPixels(page)
    expect(after).not.toBe(before)
  })

  test('selecting Warp shows a field + amount dial that moves the stored param and the pixels', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const before = await stackPixels(page)

    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="warp"]').click()
    await expect(page.getByTestId('effect-breadcrumb')).toBeVisible()

    // A default warp (bulge, amount 0.3) already displaces the outline → pixels differ.
    const afterAdd = await stackPixels(page)
    expect(afterAdd).not.toBe(before)

    // The field picker is a live control; frequency is hidden until the field is wave.
    await expect(page.locator('[data-testid="geo-warp-field"]')).toBeVisible()
    await expect(page.locator('[data-testid="geo-warp-frequency"]')).toHaveCount(0)

    // The amount dial reaches the stored param …
    const amount = page.locator('[data-testid="geo-warp-amount"]')
    await amount.fill('60'); await amount.blur()
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'warp')?.amount))
      .toBeCloseTo(0.6, 5)
    // … and moves the pixels again (a stronger bulge is a different shape).
    const afterAmount = await stackPixels(page)
    expect(afterAmount).not.toBe(afterAdd)

    // Switching to wave reveals the frequency dial (only the wave field reads it).
    await page.locator('[data-testid="geo-warp-field"]').selectOption('wave')
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'warp')?.field))
      .toBe('wave')
    await expect(page.locator('[data-testid="geo-warp-frequency"]')).toBeVisible()
  })

  test('amount 0 leaves the warp a no-op (byte-identical to no warp)', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const plain = await stackPixels(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'wp', type: 'warp', field: 'bulge', amount: 0, frequency: 3, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const warpedZero = await stackPixels(page)
    expect(warpedZero).toBe(plain)
  })
})

/**
 * F3 Task 4b — warp on RASTER layers (image / wired / brush) as a pixel-domain mesh warp of the
 * rasterised content. Proves: the add menu offers warp (and only warp) on an image; a warp with
 * amount up changes the rendered pixels; a warp at amount 0 is byte-identical to no warp (the
 * warp branch never runs); and a raster layer with NO warp is unaffected by the 4b seam.
 */
// A 16×16 fully-opaque red PNG, so a mesh warp of its box visibly moves ink (a transparent
// image would warp to the same nothing).
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGO4o6HxnxLMMGrAqAGjBgwXAwBpmSsfoVs4IAAAAABJRU5ErkJggg=='

test.describe('Frame warp — raster layers (F3 Task 4b)', () => {
  const seedImage = (page: Page, effects: unknown[] = []) => page.evaluate(({ src, fx }) =>
    (window as any).__compositorSetLayers([{
      id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1,
      src, effects: fx,
    }]), { src: RED_PNG, fx: effects })

  test('the add menu offers warp on an image (raster mesh warp)', async ({ page }) => {
    await openCompositor(page)
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: RED_PNG })
    await openFxMenuFirst(page)
    const warp = page.locator('[data-testid="add-effect-item"][data-kind="warp"]')
    await expect(warp).toBeEnabled()
    // No greyed reason on the enabled warp entry.
    await expect(warp).not.toHaveAttribute('title', /vector shape/)
  })

  test('a warp with amount up changes an image layer\'s pixels', async ({ page }) => {
    await openCompositor(page)
    await seedImage(page, [])
    const plain = await stackPixels(page)
    await seedImage(page, [{ id: 'wp', type: 'warp', field: 'bulge', amount: 0.6, frequency: 3, visible: true }])
    const warped = await stackPixels(page)
    expect(warped).not.toBe(plain)
  })

  test('a warp at amount 0 is byte-identical to no warp on an image layer', async ({ page }) => {
    await openCompositor(page)
    await seedImage(page, [])
    const plain = await stackPixels(page)
    await seedImage(page, [{ id: 'wp', type: 'warp', field: 'bulge', amount: 0, frequency: 3, visible: true }])
    const warpedZero = await stackPixels(page)
    expect(warpedZero).toBe(plain)
  })

  test('an invisible warp is byte-identical to no warp on an image layer', async ({ page }) => {
    await openCompositor(page)
    await seedImage(page, [])
    const plain = await stackPixels(page)
    await seedImage(page, [{ id: 'wp', type: 'warp', field: 'twist', amount: 0.8, frequency: 3, visible: false }])
    const invisible = await stackPixels(page)
    expect(invisible).toBe(plain)
  })
})

test.describe('Frame geometry effects — silhouette-raster byte-identity (F2 Task 8)', () => {
  test('a torn-edge rect with NO geometry is byte-identical after a geometry round-trip', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)

    // A torn edge routes the layer through the box-sized silhouette raster — the pad path this
    // fix touches. With no geometry effect `geometryOutwardPx` returns 0, so the pad (and the
    // baked raster) must be byte-identical to before the fix existed.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'te', type: 'torn_edge', style: 'ripped', amount: 16, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const tornOnly = await stackPixels(page)

    // Add a geometry effect (grows the pad), then remove it — back to the torn-edge-only render.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [
        { id: 'off', type: 'offset', distance: 0.08, visible: true },
        { id: 'te', type: 'torn_edge', style: 'ripped', amount: 16, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7, visible: true },
      ]
      ;(window as any).__compositorSetLayers(ls)
    })
    await stackPixels(page)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'te', type: 'torn_edge', style: 'ripped', amount: 16, roughness: 0.5, grain: 2, grainTexture: 0.3, lipWidth: 3, lipVariation: 0.4, lipColor: '#f7f3ea', seed: 7, visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const tornAgain = await stackPixels(page)

    const delta = await pixelDelta(page, tornOnly, tornAgain)
    // eslint-disable-next-line no-console
    console.log('[F2 torn byte-identity] max=%d mean=%s changed=%d', delta.max, delta.mean.toFixed(4), delta.changed)
    expect(delta.sizeMismatch).toBe(false)
    expect(tornAgain).toBe(tornOnly)
  })
})

/**
 * F3 Task 2 — the `boolean` (Combine shapes) geometry effect.
 *
 * Two overlapping vector layers; a `boolean` effect on the first referencing the second via the
 * sibling rail (`refLayerId`) combines their outlines with a paper.js op. paper is lazy-loaded
 * (out of the no-boolean bundle for byte-identity), so the boolean is a one-frame no-op until it
 * warms — the test polls until the pixels settle. subtract removes the overlap, so the first
 * layer's ink shrinks; unite grows it to cover the sibling.
 */
test.describe('Frame geometry effects — boolean / combine shapes (F3 Task 2)', () => {
  // Two opaque rects: A centred-left, B centred-right, overlapping in the middle.
  async function seedTwoOverlappingRects(page: Page): Promise<void> {
    await page.evaluate(() => {
      const mk = (id: string, x: number, fill: string) => ({
        id, kind: 'rect', x, y: 0.5, w: 0.4, h: 0.4, radius: 0, rotation: 0, opacity: 1, fill,
      })
      ;(window as any).__compositorSetLayers([mk('A', 0.42, '#ffffff'), mk('B', 0.58, '#ff8800')])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(2)
  }
  const setBoolean = (page: Page, op: string) => page.evaluate((o) => {
    const ls = (window as any).__compositorLayers()
    ls[0].effects = [{ id: 'bool', type: 'boolean', op: o, refLayerId: 'l:B', visible: true }]
    ;(window as any).__compositorSetLayers(ls)
  }, op)

  test('subtract referencing the sibling changes the rendered pixels (paper warms in)', async ({ page }) => {
    await openCompositor(page)
    await seedTwoOverlappingRects(page)
    const before = await stackPixels(page)

    await setBoolean(page, 'subtract')
    // paper.js warms asynchronously; the onPaperBooleanReady nudge repaints once it lands. Poll
    // until the boolean result has replaced the cold one-frame pass-through.
    await expect.poll(async () => await stackPixels(page) !== before, { timeout: 20_000 }).toBe(true)
    const after = await stackPixels(page)
    const d = await pixelDelta(page, before, after)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(200) // the overlap bite is a real change
  })

  test('a dangling ref is a no-op (byte-identical to no boolean)', async ({ page }) => {
    await openCompositor(page)
    await seedTwoOverlappingRects(page)
    const before = await stackPixels(page)
    // Reference a layer that does not exist → resolver returns null → the effect no-ops.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'bool', type: 'boolean', op: 'subtract', refLayerId: 'l:ghost', visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    // Give the render (and any warm) a beat, then confirm nothing moved.
    await stackPixels(page)
    const after = await stackPixels(page)
    expect(after).toBe(before)
  })

  test('the add menu offers boolean on a rect', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="boolean"]')).toBeEnabled()
  })

  test('the add menu greys boolean on an image (no outline)', async ({ page }) => {
    await openCompositor(page)
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: TINY_PNG })
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="boolean"]')).toBeDisabled()
  })
})

/**
 * F3 Task 3 — the `morph` (Morph to shape) geometry effect.
 *
 * Two vector layers of different sizes; a `morph` effect on the first references the second via
 * the sibling rail (`refLayerId`) and blends the first's outline toward the second's by `amount`
 * (0 = self, 1 = sibling). The blend maths are pure + synchronous (no paper.js), so unlike
 * boolean there is no warm to poll — a real amount changes the pixels on the next render, and
 * amount 0 (or a dangling ref) is a byte-identical no-op.
 */
test.describe('Frame geometry effects — morph / morph to shape (F3 Task 3)', () => {
  // A small sibling rect (bottom) and a much larger rect ON TOP that morphs toward it. Morphing
  // the TOP layer toward the SMALLER sibling shrinks its silhouette, revealing the background —
  // a visible change, where morphing a fully-occluded bottom layer would move no composited pixel.
  async function seedTwoRects(page: Page): Promise<void> {
    await page.evaluate(() => {
      const mk = (id: string, w: number, h: number, fill: string) => ({
        id, kind: 'rect', x: 0.5, y: 0.5, w, h, radius: 0, rotation: 0, opacity: 1, fill,
      })
      ;(window as any).__compositorSetLayers([mk('sib', 0.2, 0.2, '#3355ff'), mk('main', 0.6, 0.6, '#ffffff')])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(2)
  }
  // The morph sits on the TOP layer (index 1) so its own silhouette is the one that changes.
  const setMorph = (page: Page, amount: number, ref: string) => page.evaluate(({ amount, ref }) => {
    const ls = (window as any).__compositorLayers()
    ls[1].effects = [{ id: 'mph', type: 'morph', amount, refLayerId: ref, visible: true }]
    ;(window as any).__compositorSetLayers(ls)
  }, { amount, ref })

  test('a real amount toward the sibling changes the rendered pixels', async ({ page }) => {
    await openCompositor(page)
    await seedTwoRects(page)
    const before = await stackPixels(page)
    await setMorph(page, 0.5, 'l:sib')
    const after = await stackPixels(page)
    const d = await pixelDelta(page, before, after)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(200) // the outline blends outward — a real change
  })

  test('amount 0 is a no-op (byte-identical to no morph)', async ({ page }) => {
    await openCompositor(page)
    await seedTwoRects(page)
    const before = await stackPixels(page)
    await setMorph(page, 0, 'l:sib') // short-circuit: amount ≤ epsilon returns self d unchanged
    await stackPixels(page)
    const after = await stackPixels(page)
    expect(after).toBe(before)
  })

  test('a dangling ref is a no-op (byte-identical to no morph)', async ({ page }) => {
    await openCompositor(page)
    await seedTwoRects(page)
    const before = await stackPixels(page)
    await setMorph(page, 0.5, 'l:ghost') // resolver returns null → the effect no-ops
    await stackPixels(page)
    const after = await stackPixels(page)
    expect(after).toBe(before)
  })

  test('the add menu offers morph on a rect', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="morph"]')).toBeEnabled()
  })

  test('the add menu greys morph on an image (no outline)', async ({ page }) => {
    await openCompositor(page)
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: TINY_PNG })
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="morph"]')).toBeDisabled()
  })
})

/**
 * F3 Task 5 — long shadow (extrude): a SOLID directional shadow body swept from a vector
 * layer's outline, filled BENEATH the shape in a shadow colour. Unlike every other geometry
 * kind it is a paint-beneath, not a `d → d` transform (applyGeometry no-ops it). These checks
 * prove the body reaches the canvas in its own colour along the cast angle, and that a
 * length-0 / absent effect is byte-identical to no effect.
 */
/** RGBA at a normalized (nx, ny) point on the stack canvas. */
async function colorAt(page: Page, nx: number, ny: number) {
  return page.evaluate(([x, y]) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const px = Math.round(x * cv.width), py = Math.round(y * cv.height)
    const d = cv.getContext('2d')!.getImageData(px, py, 1, 1).data
    return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! }
  }, [nx, ny] as const)
}

test.describe('Frame geometry effects — long shadow (F3 Task 5)', () => {
  test('casts a coloured body along the angle; length 0 is byte-identical to none', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page) // 0.6-wide white rect centred at 0.5 ⇒ right edge at x≈0.8
    const bare = await stackPixels(page)
    // To the right of the rect, before any shadow, there is no rect ink.
    const rightBefore = await colorAt(page, 0.87, 0.5)
    expect(rightBefore.a).toBeLessThan(40)

    // A visible red long shadow cast rightward (angle 0) for 0.1·W reaches x≈0.9.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'lsh', type: 'long_shadow', angle: 0, length: 0.1, color: 'rgba(255,0,0,1)', visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    const withShadow = await stackPixels(page)
    expect(withShadow).not.toBe(bare) // the body reached the canvas

    // The swept band to the right of the rect now carries the shadow colour (red-dominant).
    const band = await colorAt(page, 0.87, 0.5)
    expect(band.a).toBeGreaterThan(200)
    expect(band.r).toBeGreaterThan(180)
    expect(band.g).toBeLessThan(80)
    expect(band.b).toBeLessThan(80)

    // The rect itself still paints on TOP of the shadow — its centre stays white.
    const centre = await colorAt(page, 0.5, 0.5)
    expect(centre.r).toBeGreaterThan(220)
    expect(centre.g).toBeGreaterThan(220)
    expect(centre.b).toBeGreaterThan(220)

    // Length 0 → the body is never painted (the paint step gates on length > 0): byte-identical.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'lsh', type: 'long_shadow', angle: 0, length: 0, color: 'rgba(255,0,0,1)', visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    await stackPixels(page)
    const zeroLen = await stackPixels(page)
    expect(zeroLen).toBe(bare)

    // A hidden long shadow is likewise a no-op.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'lsh', type: 'long_shadow', angle: 0, length: 0.1, color: 'rgba(255,0,0,1)', visible: false }]
      ;(window as any).__compositorSetLayers(ls)
    })
    await stackPixels(page)
    const hidden = await stackPixels(page)
    expect(hidden).toBe(bare)
  })

  test('the add menu offers long shadow on a rect and greys it on an image', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="long_shadow"]')).toBeEnabled()
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: TINY_PNG })
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="long_shadow"]')).toBeDisabled()
  })
})
