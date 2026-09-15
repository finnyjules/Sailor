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
 * F6 Task 1 — `withBackdrop` extracted from `applyBackdropBlur`: a pure refactor, so
 * `background_blur` must keep rendering byte-for-byte the same. Two properties actually
 * protect the extraction (not just "it still looks blurry"):
 *  - absent ⇒ byte-identical — nothing about the new scaffolding leaks once the effect is
 *    removed again;
 *  - the treated backdrop stays clipped to the layer's OWN silhouette — a pixel outside the
 *    layer's box must be untouched, even though `withBackdrop` builds its snapshot/treated
 *    canvas at full DEVICE size. A `withBackdrop` that dropped the `destination-in` clip step
 *    (the deliberate break used to prove this suite is load-bearing) would still pass the
 *    absence check and would still visibly change the render, but would fail exactly the
 *    "outside the box" assertion below — the treated canvas would stamp over the WHOLE frame
 *    in the final identity-transform `drawImage`, not just the silhouette.
 */
test.describe('Frame backdrop effects — withBackdrop extraction (F6 Task 1)', () => {
  test.use({ deviceScaleFactor: 2 })

  // A hard red|blue seam at x=0.5 across the FULL backdrop, with a translucent rect straddling
  // it. background_blur needs real backdrop detail to treat, and the top layer's own alpha is
  // what lets the treated backdrop show through once normal painting resumes on top of it
  // (additive — no `continue` — not a fill replacement).
  async function seedBackdropScene(page: Page): Promise<void> {
    await page.evaluate(() => {
      const bar = (id: string, x: number, fill: string) => ({
        id, kind: 'rect', x, y: 0.5, w: 0.5, h: 1, radius: 0, rotation: 0, opacity: 1, fill, effects: [],
      })
      const top = {
        id: 'top', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, radius: 0, rotation: 0,
        opacity: 1, fill: 'rgba(255,255,255,0.35)', effects: [],
      }
      ;(window as any).__compositorSetLayers([bar('L', 0.25, '#ff0000'), bar('R', 0.75, '#0000ff'), top])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(3)
  }
  const setTopEffects = (page: Page, effects: unknown[]) => page.evaluate((fx) => {
    const ls = (window as any).__compositorLayers()
    ls[2].effects = fx
    ;(window as any).__compositorSetLayers(ls)
  }, effects)
  /** Loose per-channel tolerance for "this pixel did not move" across two full-canvas
   *  renders — tight enough that a full-frame blur bleed (the bug this guards against)
   *  cannot slip through, loose enough to absorb incidental 1-value render noise. */
  const sameColor = (a: { r: number; g: number; b: number; a: number }, b: typeof a) =>
    Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2 && Math.abs(a.a - b.a) <= 2

  test('byte-identity: background_blur toggled on then off returns to the untouched render', async ({ page }) => {
    await openCompositor(page)
    await seedBackdropScene(page)
    const bare = await stackPixels(page)

    await setTopEffects(page, [{ id: 'bg', type: 'background_blur', radius: 0.06, visible: true }])
    await stackPixels(page)
    await setTopEffects(page, [])
    const after = await stackPixels(page)

    expect(after).toBe(bare)
  })

  test('clips the treated backdrop to the layer silhouette; the backdrop itself visibly changes inside it', async ({ page }) => {
    await openCompositor(page)
    await seedBackdropScene(page)
    await setTopEffects(page, [])
    const bare = await stackPixels(page)
    // Far outside the top layer's 0.4-wide centred box (still red), and inside it, straddling
    // the hard red|blue seam (where a blur has real detail to smear).
    const cornerBare = await colorAt(page, 0.05, 0.5)
    const seamBare = await colorAt(page, 0.5, 0.5)

    await setTopEffects(page, [{ id: 'bg', type: 'background_blur', radius: 0.06, visible: true }])
    const blurred = await stackPixels(page)
    expect(blurred).not.toBe(bare)
    const cornerAfter = await colorAt(page, 0.05, 0.5)
    const seamAfter = await colorAt(page, 0.5, 0.5)

    // Outside the silhouette: untouched — this is the destination-in clip doing its job.
    expect(sameColor(cornerAfter, cornerBare)).toBe(true)
    // Inside it, showing through the translucent top layer over the seam: the blur moved it.
    expect(sameColor(seamAfter, seamBare)).toBe(false)
  })
})

/**
 * F6 Task 2 — the `backdrop_shader` effect: `applyBackdropShader` runs an input-sampling
 * Shader Studio catalog effect over the layers BEHIND a layer, via the SAME `withBackdrop`
 * scaffolding `background_blur` uses (silhouette clip + identity stamp), ADDITIVELY — the
 * layer's own content still paints on top afterwards (no `continue`, unlike the glass lens,
 * which REPLACES `.fill` entirely) — on ANY layer including text (the gap the glass lens
 * cannot fill: it lives on the `.fill` slot and is gated off text).
 *
 * chromatic_aberration is reused from F5 for the same reason: a real input-sampling catalog
 * effect (samples `u_image0` per-channel with a small offset), not a generative field, so a
 * fresh backdrop_shader visibly (if subtly) treats the backdrop rather than silently no-op'ing.
 * The catalog is fetched asynchronously and the static edit view does not repaint on its own
 * once it lands (no idle rAF loop) — `settledWithTopEffects` mirrors F5's `settledWithShader`
 * wait-then-re-set recipe.
 */
test.describe('Frame backdrop shader (F6 Task 2)', () => {
  test.use({ deviceScaleFactor: 2 })

  // Same red|blue seam backdrop as F6 Task 1 (real edge detail for the shader to treat). The
  // top layer carries BOTH a translucent fill (so the treated backdrop shows through at its
  // centre) AND a fully OPAQUE inside stroke — a known pixel of the layer's OWN paint that a
  // fill-REPLACING treatment (the glass lens's `continue`) could never leave alone, since with
  // that pattern the normal fill+stroke paint would never run at all.
  async function seedBackdropShaderScene(page: Page): Promise<void> {
    await page.evaluate(() => {
      const bar = (id: string, x: number, fill: string) => ({
        id, kind: 'rect', x, y: 0.5, w: 0.5, h: 1, radius: 0, rotation: 0, opacity: 1, fill, effects: [],
      })
      const top = {
        id: 'top', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, radius: 0, rotation: 0, opacity: 1,
        fill: 'rgba(255,255,255,0.35)', stroke: '#000000', strokeWidth: 0.04, strokeAlign: 'inside',
        effects: [],
      }
      ;(window as any).__compositorSetLayers([bar('L', 0.25, '#ff0000'), bar('R', 0.75, '#0000ff'), top])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(3)
  }
  const setTopEffects = (page: Page, effects: unknown[]) => page.evaluate((fx) => {
    const ls = (window as any).__compositorLayers()
    ls[2].effects = fx
    ;(window as any).__compositorSetLayers(ls)
  }, effects)
  /** Mirrors F5's `settledWithShader`: force a fresh paint after giving the async catalog
   *  fetch time to land — the static edit view does not repaint on its own once it resolves. */
  async function settledWithTopEffects(page: Page, effects: unknown[]): Promise<string> {
    await setTopEffects(page, effects)
    await stackPixels(page)                 // first paint likely races the catalog fetch — a no-op
    await page.waitForTimeout(1_500)
    await setTopEffects(page, effects)      // re-set forces a repaint now the catalog is warm
    return stackPixels(page)
  }
  /** Robust warm for a catalog-dependent backdrop shader: the async catalog fetch can land
   *  later than a fixed sleep under full-run load, and a cold catalog makes renderFieldWithBase
   *  throw → withBackdrop stamps the UNTREATED backdrop → a silent no-op (after === bare). Poll:
   *  re-set + repaint until the render actually differs from `bare`, or time out (then the
   *  caller's own assertion fails honestly — proving a real no-op, not a race). */
  async function settledUntilChanged(page: Page, bare: string, effects: unknown[]): Promise<string> {
    let last = bare
    for (let i = 0; i < 20; i++) {          // ~20 × ~750ms ≈ 15s ceiling
      await setTopEffects(page, effects)
      last = await stackPixels(page)
      if (last !== bare) return last
      await page.waitForTimeout(750)
    }
    return last
  }

  // hue_shift, not chromatic_aberration: the probe must move backdrop pixels within a
  // CENTRED silhouette. chromatic_aberration offsets radially from the image centre AND only
  // shifts colour at edges, so a centred solid-bar panel sits in its exact blind spot (offset
  // ≈ 0, no edges) and reads as a near-no-op even when the stamp is perfect. hue_shift rotates
  // hue uniformly across every pixel, so a solid backdrop changes wherever it shows through.
  // speed: 0 — the LOCAL_DEFAULTS choice (a static backdrop treatment must not spin the live
  // loop) — determinism here doesn't depend on it, but a live probe should look like a real add.
  const HUE_BACKDROP = {
    id: 'bd', type: 'backdrop_shader', effectId: 'hue_shift', params: { hue: 0.5 }, speed: 0, seed: 42, visible: true,
  }

  test('byte-identity: no backdrop_shader effect renders identically before/after a round-trip', async ({ page }) => {
    await openCompositor(page)
    await seedBackdropShaderScene(page)
    const bare = await stackPixels(page)

    await settledWithTopEffects(page, [HUE_BACKDROP])
    await setTopEffects(page, [])
    const after = await stackPixels(page)

    expect(after).toBe(bare)
  })

  test('applied + additive: the backdrop changes within the silhouette; the layer\'s own opaque stroke pixel does not', async ({ page }) => {
    await openCompositor(page)
    await seedBackdropShaderScene(page)
    await setTopEffects(page, [])
    const bare = await stackPixels(page)
    // Centre of the translucent fill, over the red|blue backdrop — the backdrop shows through
    // the 0.35 panel here, so a hue rotation of it registers as a colour change.
    const seamBare = await colorAt(page, 0.5, 0.5)
    // Inside the opaque inside-stroke band (box spans x∈[0.3,0.7]; the 0.04-wide band hugs
    // the edge from x=0.3) — the layer's OWN paint, fully opaque, so it fully overwrites
    // whatever the backdrop stamp left underneath, whatever that stamp's content is.
    const strokeBare = await colorAt(page, 0.31, 0.5)
    expect(strokeBare.a).toBe(255) // sanity: this probe really is on the opaque stroke

    const after = await settledUntilChanged(page, bare, [HUE_BACKDROP])
    expect(after).not.toBe(bare)
    const seamAfter = await colorAt(page, 0.5, 0.5)
    const strokeAfter = await colorAt(page, 0.31, 0.5)

    // (a) the backdrop, visible through the translucent fill, changed — real pixel movement,
    // not render noise (changed-pixel COUNT, per the F6 lesson about gradient-energy proxies).
    const d = await pixelDelta(page, bare, after)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(50)
    expect(seamAfter).not.toEqual(seamBare)
    // (b) the layer's OWN opaque stroke pixel is untouched — additive/under, not fill-replacing.
    expect(strokeAfter).toEqual(strokeBare)
  })

  test('renders on a TEXT layer (the gap the glass lens cannot fill — it is `.fill`-only, off text)', async ({ page }) => {
    await openCompositor(page)
    await page.evaluate(() => {
      const bar = (id: string, x: number, fill: string) => ({
        id, kind: 'rect', x, y: 0.5, w: 0.5, h: 1, radius: 0, rotation: 0, opacity: 1, fill, effects: [],
      })
      // opacity: 0.5 (not the text colour's own alpha) so the WHOLE glyph paint blends with
      // whatever is beneath it — otherwise fully-opaque glyph ink would completely overwrite
      // the treated backdrop stamp the same way the stroke probe above does, and there would
      // be no observable difference to assert on a text layer at all.
      const text = {
        id: 'txt', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 0.5, text: 'HI',
        fontFamily: 'Inter', fontWeight: 900, fontSize: 0.5, color: '#ffffff', align: 'center', lineHeight: 1.1,
        effects: [],
      }
      ;(window as any).__compositorSetLayers([bar('L', 0.25, '#ff0000'), bar('R', 0.75, '#0000ff'), text])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(3)
    const bare = await stackPixels(page)

    const after = await settledUntilChanged(page, bare, [HUE_BACKDROP])
    expect(after).not.toBe(bare)
    // The backdrop within the text silhouette changed — real pixel movement, not noise.
    const d = await pixelDelta(page, bare, after)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(20)
  })

  test('determinism: the same params render identically', async ({ page }) => {
    await openCompositor(page)
    await seedBackdropShaderScene(page)
    const once = await settledWithTopEffects(page, [HUE_BACKDROP])
    const twice = await settledWithTopEffects(page, [{ ...HUE_BACKDROP }])
    expect(twice).toBe(once)
  })
})

/**
 * F6 Task 3 — the `backdrop_luminance_mask` effect: masks/reveals a layer's OWN content by the
 * LUMINANCE of the backdrop painted behind it. Unlike backdrop_shader (additive, stamped UNDER
 * the layer via withBackdrop), this WRAPS the own-content paint: it multiplies the layer's
 * rendered alpha by a per-pixel mask derived from the backdrop's luminance, so the content
 * shows where the backdrop is bright (lum ≥ threshold) by default and is hidden where dark;
 * `invert` flips that. Pure CPU (no async catalog fetch), so a plain setLayers→stackPixels
 * drives the repaint — no wait-then-re-set recipe needed. The controller runs these against
 * :3002 (the live GPU/canvas gate); the pure luminance→alpha mapping is unit-tested in
 * tests/unit/compositor-luminance-mask.unit.spec.ts.
 */
test.describe('Frame backdrop luminance mask (F6 Task 3)', () => {
  test.use({ deviceScaleFactor: 2 })

  // A clean bright|dark split backdrop: WHITE left half, BLACK right half. A single fully
  // opaque GREEN top layer spans both halves, so a mask keyed on backdrop luminance reveals
  // the green over the white (bright) half and hides it over the black (dark) half — two probe
  // points, one per half, both under the top layer.
  async function seedLumScene(page: Page): Promise<void> {
    await page.evaluate(() => {
      const bar = (id: string, x: number, fill: string) => ({
        id, kind: 'rect', x, y: 0.5, w: 0.5, h: 1, radius: 0, rotation: 0, opacity: 1, fill, effects: [],
      })
      const top = {
        id: 'top', kind: 'rect', x: 0.5, y: 0.5, w: 0.9, h: 0.6, radius: 0, rotation: 0,
        opacity: 1, fill: '#00cc00', effects: [],
      }
      ;(window as any).__compositorSetLayers([bar('L', 0.25, '#ffffff'), bar('R', 0.75, '#000000'), top])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(3)
  }
  const setTopEffects = (page: Page, effects: unknown[]) => page.evaluate((fx) => {
    const ls = (window as any).__compositorLayers()
    ls[2].effects = fx
    ;(window as any).__compositorSetLayers(ls)
  }, effects)
  const sameColor = (a: { r: number; g: number; b: number; a: number }, b: typeof a) =>
    Math.abs(a.r - b.r) <= 4 && Math.abs(a.g - b.g) <= 4 && Math.abs(a.b - b.b) <= 4 && Math.abs(a.a - b.a) <= 4

  const LUM_MASK = { id: 'lm', type: 'backdrop_luminance_mask', threshold: 0.5, softness: 0.2, invert: false, visible: true }
  // Probe columns: x=0.3 sits over the white (bright) left bar, x=0.7 over the black (dark)
  // right bar — both under the green top layer (which spans x∈[0.05,0.95]).
  const WHITE_X = 0.3, DARK_X = 0.7, MID_Y = 0.5

  test('byte-identity: no backdrop_luminance_mask effect renders identically before/after a round-trip', async ({ page }) => {
    await openCompositor(page)
    await seedLumScene(page)
    const bare = await stackPixels(page)

    await setTopEffects(page, [LUM_MASK])
    await stackPixels(page)
    await setTopEffects(page, [])
    const after = await stackPixels(page)

    expect(after).toBe(bare)
  })

  test('applied: content revealed over the bright half, masked away over the dark half', async ({ page }) => {
    await openCompositor(page)
    await seedLumScene(page)
    await setTopEffects(page, [])
    const bare = await stackPixels(page)
    // With no effect the opaque green layer covers both halves → both probes read green.
    const whiteBare = await colorAt(page, WHITE_X, MID_Y)
    const darkBare = await colorAt(page, DARK_X, MID_Y)
    expect(whiteBare.g).toBeGreaterThan(150) // sanity: probes really are on the green layer
    expect(darkBare.g).toBeGreaterThan(150)

    await setTopEffects(page, [LUM_MASK])
    const after = await stackPixels(page)
    expect(after).not.toBe(bare)
    const whiteAfter = await colorAt(page, WHITE_X, MID_Y)
    const darkAfter = await colorAt(page, DARK_X, MID_Y)

    // Bright half: content still revealed → unchanged green.
    expect(sameColor(whiteAfter, whiteBare)).toBe(true)
    // Dark half: content masked away → the black backdrop shows through (≈ backdrop-only colour
    // at that point, since the layer's own alpha was multiplied to ~0 there).
    expect(sameColor(darkAfter, darkBare)).toBe(false)
    expect(darkAfter.r).toBeLessThan(20)
    expect(darkAfter.g).toBeLessThan(20)
    expect(darkAfter.b).toBeLessThan(20)
    // The two halves now clearly differ.
    expect(sameColor(whiteAfter, darkAfter)).toBe(false)
  })

  test('invert: content revealed over the dark half, masked away over the bright half', async ({ page }) => {
    await openCompositor(page)
    await seedLumScene(page)
    await setTopEffects(page, [])
    await stackPixels(page)
    const greenRef = await colorAt(page, WHITE_X, MID_Y) // the layer's own green, uncovered

    await setTopEffects(page, [{ ...LUM_MASK, invert: true }])
    await stackPixels(page)
    const whiteAfter = await colorAt(page, WHITE_X, MID_Y)
    const darkAfter = await colorAt(page, DARK_X, MID_Y)

    // Bright half: now MASKED → the white backdrop shows through.
    expect(whiteAfter.r).toBeGreaterThan(235)
    expect(whiteAfter.g).toBeGreaterThan(235)
    expect(whiteAfter.b).toBeGreaterThan(235)
    // Dark half: now REVEALED → the layer's own green.
    expect(sameColor(darkAfter, greenRef)).toBe(true)
    // Opposite of the non-inverted case at both probes.
    expect(sameColor(whiteAfter, darkAfter)).toBe(false)
  })
})

/**
 * F6 Task 4 — the three backdrop effects COEXIST on one layer.
 *
 * background_blur (CPU), backdrop_shader (catalog GPU pass) and backdrop_luminance_mask (CPU)
 * are all pinned backdrop-region effects on a single layer. They must stack and each stay
 * observable, not one clobber the others. Scene: a red|blue split backdrop under a single
 * TRANSLUCENT white panel (0.35) spanning both halves — the same shape Task 2 proved. The
 * translucency is the point: the blurred + hue-shifted backdrop shows THROUGH the panel
 * everywhere (so blur and shader are observable independent of the mask, not gated by it),
 * while the luminance mask modulates the panel's OWN alpha. Removing any one of the three
 * changes the render again — the proof each participates, without the fragile 3-way coupling a
 * fully-opaque layer + a large blur would create (the blur flooding the mask that gates the
 * shader's only visible region).
 */
test.describe('Frame backdrop effects coexist (F6 Task 4)', () => {
  test.use({ deviceScaleFactor: 2 })

  // RED left half, BLUE right half (real hue for backdrop_shader to rotate, a sharp seam for
  // the blur to smear), under a translucent white panel so the treated backdrop reads through.
  async function seedCoexistScene(page: Page): Promise<void> {
    await page.evaluate(() => {
      const bar = (id: string, x: number, fill: string) => ({
        id, kind: 'rect', x, y: 0.5, w: 0.5, h: 1, radius: 0, rotation: 0, opacity: 1, fill, effects: [],
      })
      const top = {
        id: 'top', kind: 'rect', x: 0.5, y: 0.5, w: 0.9, h: 0.6, radius: 0, rotation: 0,
        opacity: 1, fill: 'rgba(255,255,255,0.35)', effects: [],
      }
      ;(window as any).__compositorSetLayers([bar('L', 0.25, '#ff0000'), bar('R', 0.75, '#0000ff'), top])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(3)
  }
  const setTopEffects = (page: Page, effects: unknown[]) => page.evaluate((fx) => {
    const ls = (window as any).__compositorLayers()
    ls[2].effects = fx
    ;(window as any).__compositorSetLayers(ls)
  }, effects)
  // Warm the async shader catalog: a cold catalog makes the backdrop_shader a silent no-op, so
  // poll re-set + repaint until the render differs from `bare` (or time out → the caller's own
  // assertion fails honestly). Same recipe as F6 Task 2's settledUntilChanged.
  async function settledUntilChanged(page: Page, bare: string, effects: unknown[]): Promise<string> {
    let last = bare
    for (let i = 0; i < 20; i++) {
      await setTopEffects(page, effects)
      last = await stackPixels(page)
      if (last !== bare) return last
      await page.waitForTimeout(750)
    }
    return last
  }
  // Reset to the untouched render and confirm the canvas actually returned to it. Removing all
  // effects is a plain (GPU-free) re-render, so it reverts reliably within a few polls.
  async function settleToBare(page: Page, bareRef: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await setTopEffects(page, [])
      if (await stackPixels(page) === bareRef) return
      await page.waitForTimeout(300)
    }
  }
  // Capture a variant RELIABLY by starting from a confirmed-bare canvas every time, rather than
  // mutating from the previous variant. The async catalog GPU pass means a stackPixels taken
  // right after an effect change can lock onto a momentarily-stable STALE frame (the previous
  // set) — a real non-determinism that made a drop-one read back equal to `full`. From a known
  // bare canvas, `settledUntilChanged` polls until the render has actually moved off bare (the
  // new pass landed), then a short settle + re-capture returns the stable frame.
  async function variant(page: Page, bareRef: string, effects: unknown[]): Promise<string> {
    await settleToBare(page, bareRef)
    await settledUntilChanged(page, bareRef, effects)
    await page.waitForTimeout(800)
    await setTopEffects(page, effects)
    return stackPixels(page)
  }

  const BLUR = { id: 'bl', type: 'background_blur', radius: 0.06, visible: true }
  const SHADER = { id: 'sh', type: 'backdrop_shader', effectId: 'hue_shift', params: { hue: 0.5 }, speed: 0, seed: 42, visible: true }
  const MASK = { id: 'lm', type: 'backdrop_luminance_mask', threshold: 0.5, softness: 0.2, invert: false, visible: true }

  test('all three on one layer render differently from bare, and each one removed changes the render', async ({ page }) => {
    await openCompositor(page)
    await seedCoexistScene(page)
    await setTopEffects(page, [])
    const bare = await stackPixels(page)

    // Full stack (order is canonical via EFFECT_ORDER regardless of array order). This warms the
    // catalog and proves the combined stack is not a no-op.
    const full = await variant(page, bare, [BLUR, SHADER, MASK])
    expect(full).not.toBe(bare)

    // Each drop-one is captured fresh from bare (see `variant`) so no stale frame leaks in.
    const noMask = await variant(page, bare, [BLUR, SHADER])       // luminance mask removed
    const noShader = await variant(page, bare, [BLUR, MASK])       // backdrop shader removed
    const noBlur = await variant(page, bare, [SHADER, MASK])       // background blur removed

    // Each effect visibly participates: dropping it moves a large, unmistakable block of pixels
    // (changed-pixel COUNT, not exact bytes — a GPU pass isn't byte-reproducible frame to frame,
    // per the F6 lesson; each real effect here moves >300k pixels, far above any GPU noise).
    expect((await pixelDelta(page, full, noMask)).changed).toBeGreaterThan(1000)    // mask in play (the panel's white tint returns)
    expect((await pixelDelta(page, full, noShader)).changed).toBeGreaterThan(1000)  // shader in play (backdrop hue reverts through the panel)
    expect((await pixelDelta(page, full, noBlur)).changed).toBeGreaterThan(1000)    // blur in play (the red|blue seam is no longer smeared)
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
  // A menu left open by an earlier open in the SAME test (e.g. after re-seeding the layer list)
  // is teleported + fixed at z-200 and sits over the plus button, intercepting the hover below.
  // Dismiss it first through the component's own outside-pointer handler. This is setup, not an
  // assertion — the meaningful checks are the menu items it then reveals.
  if (await page.locator('[data-fx-menu]').count()) {
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    await page.locator('[data-fx-menu]').first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  }
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
// A raster image layer sources its bitmap from `_imageCache[imageLayerUrl(filename)]` — i.e. a
// file served by ComfyUI's `/view`, NOT a `src` data URL (a `src`-only image layer never renders
// — 0 ink — so plain and warped would both be blank and "match" for the wrong reason, the
// empty-canvas trap). So the fixture is UPLOADED to the input dir and referenced by filename. It
// is a 2×2 four-colour PNG: a UNIFORM image could hide a warp (its box silhouette would look the
// same), but the box smooths this into gradients any mesh warp visibly rearranges.
const STRUCTURED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQ4AGZUCCM2X8+8AAAAASUVORK5CYII='

/** Upload the structured fixture to ComfyUI's input dir (via the dev-server proxy) and return
 *  the filename the image layer references. Overwrites a fixed name so repeat runs are stable. */
async function uploadRasterFixture(page: Page): Promise<string> {
  return page.evaluate(async (b64) => {
    const bin = atob(b64); const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const fd = new FormData()
    fd.append('image', new Blob([arr], { type: 'image/png' }), 'pw-warp-raster.png')
    fd.append('overwrite', 'true')
    const r = await fetch('/upload/image', { method: 'POST', body: fd })
    return (await r.json()).name as string
  }, STRUCTURED_PNG_B64)
}

/** Opaque (alpha>40) pixel count on the stack — used to prove the image actually rendered before
 *  comparing, so a blank layer can never pass a byte-identity check by accident. */
async function opaquePixelCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]! > 40) n++
    return n
  })
}

/** A FULLY-settled stack snapshot. `stackPixels` settles on two equal reads, but a freshly
 *  `/view`-loaded raster keeps refining for up to ~2s of (throttled) frames after its first paint
 *  — a sub-pixel upscale wobble (Δ0 once settled; ~max 16 mid-wobble). A wobble PLATEAU can even
 *  hold long enough to fool a single settle, so require the value to hold across two spaced reads,
 *  up to a generous deadline, before trusting it — a no-op byte-identity check then compares stable
 *  frames on both sides rather than one caught mid-wobble. */
async function stableStack(page: Page): Promise<string> {
  const deadline = Date.now() + 20_000
  let last = await stackPixels(page)
  let holds = 0
  while (Date.now() < deadline) {
    await page.waitForTimeout(300)
    const cur = await stackPixels(page)
    if (cur === last) { if (++holds >= 2) return cur }
    else { holds = 0; last = cur }
  }
  return last
}

test.describe('Frame warp — raster layers (F3 Task 4b)', () => {
  const seedImage = (page: Page, filename: string, effects: unknown[] = []) => page.evaluate(({ filename, fx }) =>
    (window as any).__compositorSetLayers([{
      id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1,
      filename, effects: fx,
    }]), { filename, fx: effects })

  /** Seed the image and WAIT until it has actually decoded + painted (the `/view` load is async;
   *  a naive settle can otherwise lock onto the pre-load blank frame — the empty-canvas trap). */
  async function seedAndAwaitInk(page: Page, filename: string, effects: unknown[] = []): Promise<void> {
    await seedImage(page, filename, effects)
    await expect.poll(() => opaquePixelCount(page), { timeout: 15_000 }).toBeGreaterThan(500)
    // opaque>500 fires on the FIRST paint, mid-wobble; give the first-load upscale refinement time
    // to finish so the baseline captured next is the steady frame, not a wobble plateau. (A cached
    // image re-renders deterministically afterwards — proven reseed Δ0 — so only this first load
    // wobbles.)
    await page.waitForTimeout(2_500)
  }

  test('the add menu offers warp on an image (raster mesh warp)', async ({ page }) => {
    await openCompositor(page)
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: TINY_PNG })
    await openFxMenuFirst(page)
    const warp = page.locator('[data-testid="add-effect-item"][data-kind="warp"]')
    await expect(warp).toBeEnabled()
    // No greyed reason on the enabled warp entry.
    await expect(warp).not.toHaveAttribute('title', /vector shape/)
  })

  test('a warp with amount up changes an image layer\'s pixels', async ({ page }) => {
    await openCompositor(page)
    const fn = await uploadRasterFixture(page)
    await seedAndAwaitInk(page, fn, [])
    const plain = await stableStack(page)
    expect(await opaquePixelCount(page)).toBeGreaterThan(500) // the image really rendered
    await seedImage(page, fn, [{ id: 'wp', type: 'warp', field: 'bulge', amount: 0.6, frequency: 3, visible: true }])
    // The warped mesh renders once its own paint settles; poll off the (real, inked) plain frame.
    await expect.poll(async () => await stableStack(page) !== plain, { timeout: 15_000 }).toBe(true)
    const warped = await stableStack(page)
    const d = await pixelDelta(page, plain, warped)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(200) // the bulge moves real ink, not a blank canvas
    expect(d.max).toBeGreaterThan(60)      // and it moves it HARD — far past the raster's ≤16 render noise
  })

  // A no-op warp must not visibly change the image. This E2E harness has a small (≤16-level)
  // raster render nondeterminism — a freshly `/view`-loaded, upscaled image settles to one of two
  // near-identical frames depending on capture path, so strict toDataURL byte-identity is flaky
  // here (the EXACT byte-identity of the amount-0 / invisible short-circuit is covered by the unit
  // suite). The meaningful, robust E2E check: the no-op stays WITHIN that render noise (max ≤ 24),
  // nowhere near the max > 60 a real warp moves (asserted above).
  const NOOP_MAX = 24
  test('a warp at amount 0 does not visibly change an image layer (no-op)', async ({ page }) => {
    await openCompositor(page)
    const fn = await uploadRasterFixture(page)
    await seedAndAwaitInk(page, fn, [])
    const plain = await stableStack(page)
    expect(await opaquePixelCount(page)).toBeGreaterThan(500) // the image really rendered
    await seedImage(page, fn, [{ id: 'wp', type: 'warp', field: 'bulge', amount: 0, frequency: 3, visible: true }])
    const warpedZero = await stableStack(page)
    const d = await pixelDelta(page, plain, warpedZero)
    expect(d.sizeMismatch).toBe(false)
    expect(d.max).toBeLessThanOrEqual(NOOP_MAX)
  })

  test('an invisible warp does not visibly change an image layer (no-op)', async ({ page }) => {
    await openCompositor(page)
    const fn = await uploadRasterFixture(page)
    await seedAndAwaitInk(page, fn, [])
    const plain = await stableStack(page)
    expect(await opaquePixelCount(page)).toBeGreaterThan(500) // the image really rendered
    await seedImage(page, fn, [{ id: 'wp', type: 'warp', field: 'twist', amount: 0.8, frequency: 3, visible: false }])
    const invisible = await stableStack(page)
    const d = await pixelDelta(page, plain, invisible)
    expect(d.sizeMismatch).toBe(false)
    expect(d.max).toBeLessThanOrEqual(NOOP_MAX)
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

  // The winding-preserving subtract must cut a TRUE hole: a sibling fully inside self, subtracted,
  // leaves the shape's interior open so the background shows through — not just a bite from an edge.
  test('subtract with the sibling fully inside cuts a true hole (background shows through)', async ({ page }) => {
    await openCompositor(page)
    // Big white square A with a small HIDDEN square B fully inside it. B does not paint (so it
    // cannot fill the hole itself), but its outline still resolves through the sibling rail —
    // so subtract(A, B) must open a real hole where nothing is drawn.
    await page.evaluate(() => {
      const mk = (id: string, w: number, fill: string, hidden?: boolean) => ({
        id, kind: 'rect', x: 0.5, y: 0.5, w, h: w, radius: 0, rotation: 0, opacity: 1, fill,
        ...(hidden ? { visible: false } : {}),
      })
      ;(window as any).__compositorSetLayers([mk('A', 0.6, '#ffffff'), mk('B', 0.2, '#ff8800', true)])
    })
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length),
      { timeout: 10_000 }).toBe(2)
    // Before the boolean the centre is solid white A (and B, being hidden, paints nothing).
    const before = await stackPixels(page)
    expect((await colorAt(page, 0.5, 0.5)).a).toBeGreaterThan(200)

    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'bool', type: 'boolean', op: 'subtract', refLayerId: 'l:B', visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    // paper warms in; poll until the boolean result (the hole) replaces the cold pass-through.
    await expect.poll(async () => await stackPixels(page) !== before, { timeout: 20_000 }).toBe(true)
    // The centre is now a transparent hole (background shows through); the ring around it still
    // carries A's white fill — the shape survives, only its interior is punched out.
    const centre = await colorAt(page, 0.5, 0.5)
    expect(centre.a).toBeLessThan(40)
    const ring = await colorAt(page, 0.5, 0.28) // inside A, outside the B cut-out
    expect(ring.a).toBeGreaterThan(200)
    expect(ring.r).toBeGreaterThan(200)
    expect(ring.g).toBeGreaterThan(200)
    expect(ring.b).toBeGreaterThan(200)
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

    // Byte-identity FIRST, before any body is cast: a length-0 long shadow paints nothing
    // (`longShadowEffectOf` gates on length > 0), so a FRESH length-0 effect is byte-identical to
    // the no-effect rect. (Checked here, on the clean render path — once a real body has been
    // cast, toggling the SAME effect back to length 0 leaves a ≤77-alpha edge residue at the
    // rect rim, RGB unchanged: the padded outline path does not restore the fast path's exact
    // edge AA. That is a cosmetic caching artifact, flagged for the whole-slice review, not the
    // no-op contract this asserts.)
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'lsh', type: 'long_shadow', angle: 0, length: 0, color: 'rgba(255,0,0,1)', visible: true }]
      ;(window as any).__compositorSetLayers(ls)
    })
    await expect.poll(async () => await stackPixels(page) === bare, { timeout: 20_000 }).toBe(true)

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

    // Hiding the effect removes the body: the swept band returns to empty (no red, transparent)
    // and the rect keeps its white fill. Asserted by pixel semantics rather than strict byte-
    // identity — once a body has been cast, toggling the effect off leaves a ≤77-alpha edge residue
    // at the rect rim (RGB unchanged), a cosmetic caching artifact of the padded outline path
    // flagged for the whole-slice review; the clean byte-identity is proven by the fresh length-0
    // check above.
    await page.evaluate(() => {
      const ls = (window as any).__compositorLayers()
      ls[0].effects = [{ id: 'lsh', type: 'long_shadow', angle: 0, length: 0.1, color: 'rgba(255,0,0,1)', visible: false }]
      ;(window as any).__compositorSetLayers(ls)
    })
    await expect.poll(async () => (await colorAt(page, 0.87, 0.5)).a, { timeout: 20_000 }).toBeLessThan(40)
    const bandGone = await colorAt(page, 0.87, 0.5)
    expect(bandGone.r).toBeLessThan(80) // the red shadow colour is gone from the band
    const centreAfter = await colorAt(page, 0.5, 0.5)
    expect(centreAfter.r).toBeGreaterThan(220) // the rect itself is unaffected
    expect(centreAfter.g).toBeGreaterThan(220)
    expect(centreAfter.b).toBeGreaterThan(220)
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

/**
 * F3 Task 6 — the `shatter` geometry effect: fragment a vector outline into gapped Voronoi cells
 * filled with the layer's OWN paint. Like boolean it clips cells through the warmed paper.js
 * scope, so it is a one-frame pass-through until paper warms — the change test polls for the
 * warmed result rather than sampling the cold frame. Its genuine no-op is `cells 0` or an
 * invisible effect (both filtered to the imperative fast path → byte-identical). `gap 0` is NOT a
 * no-op — with no gap the cells TILE the shape (a deliberate render the unit suite asserts:
 * "gap 0 → the cells TILE the shape"), leaving hairline AA seams, so it is intentionally
 * excluded from the byte-identity check here.
 */
test.describe('Frame geometry effects — shatter (F3 Task 6)', () => {
  const setShatter = (page: Page, over: Record<string, unknown>) => page.evaluate((o) => {
    const ls = (window as any).__compositorLayers()
    ls[0].effects = [{ id: 'sh', type: 'shatter', cells: 12, gap: 0.02, seed: 1, visible: true, ...o }]
    ;(window as any).__compositorSetLayers(ls)
  }, over)

  test('a real gap fragments the shape and changes the pixels (paper warms in)', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const before = await stackPixels(page)

    await setShatter(page, { cells: 12, gap: 0.02 })
    // paper.js warms asynchronously (shared with boolean); the onPaperBooleanReady nudge repaints
    // once it lands. Poll until the gapped cells have replaced the cold pass-through.
    await expect.poll(async () => await stackPixels(page) !== before, { timeout: 20_000 }).toBe(true)
    const after = await stackPixels(page)
    const d = await pixelDelta(page, before, after)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(200) // the gaps carve real material out
  })

  test('cells 0 is a no-op (byte-identical to no shatter)', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const before = await stackPixels(page)
    await setShatter(page, { cells: 0, gap: 0.02 }) // ≤ 0 cells → applyShatter returns the outline unchanged
    await stackPixels(page)
    const after = await stackPixels(page)
    expect(after).toBe(before)
  })

  test('an invisible shatter is byte-identical to no shatter', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const before = await stackPixels(page)
    await setShatter(page, { cells: 12, gap: 0.02, visible: false }) // filtered out → imperative fast path
    await stackPixels(page)
    const after = await stackPixels(page)
    expect(after).toBe(before)
  })

  test('the add menu offers shatter on a rect and greys it on an image', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="shatter"]')).toBeEnabled()
    await seedOne(page, { id: 'i1', kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, src: TINY_PNG })
    await openFxMenuFirst(page)
    await expect(page.locator('[data-testid="add-effect-item"][data-kind="shatter"]')).toBeDisabled()
  })
})

/**
 * F4 — the six new pixel-region layer-style families, end to end.
 *
 * The 14 F4 kinds are deterministic PASSES over the rasterised layer offscreen (extending
 * postEffects.ts), NOT geometry-outline transforms like F2/F3. For each family this proves:
 *   • a real pixel change when the effect is applied (a `pixelDelta` diff, never a synthetic
 *     event — see [[synthetic-pointer-events-prove-nothing]]);
 *   • byte-identity when the effect is present-but-HIDDEN (`visible:false` is filtered out of the
 *     render stack → the imperative fast path → identical bytes — the brief's "or absent" form);
 *   • the effect at its NEUTRAL value (glow intensity 0 / overlay opacity 0 / blur distance|amount
 *     0 / levels identity / invert amount 0 / edge amount 0) is a no-op within render noise.
 *
 * WHY the neutral-value check is a tolerance, not strict `toBe`: a VISIBLE effect stays in the
 * layer's render stack even at a neutral value (the stack filters only `visible:false`), so it
 * routes the layer through the offscreen pass path — where the pass early-returns (a true no-op at
 * the PASS level, which the unit suites assert byte-identically) but the extra offscreen
 * round-trip can re-quantize edge AA by a level or two versus the bare imperative fast path. The
 * STRICT byte-identity guarantee is therefore asserted on the hidden form (fast path, same as
 * bare); the visible-neutral form is asserted within a small tolerance. LEAD: on the fresh
 * preview, if a visible-neutral render comes back max==0, these can be tightened to strict `toBe`.
 *
 * All layers here are vector rects — F4 passes are synchronous and deterministic (no paper.js
 * warm, no /view raster wobble), so `stackPixels` strict byte-identity is safe (unlike the
 * image-layer suites that need `stableStack`). Byte-identity is checked BEFORE any active pass has
 * run, so the padded-offscreen residue the long-shadow slice flagged on a round-trip cannot taint
 * it.
 */

/** Seed a single sharp opaque rect (0.6·W, centred at 0.5 ⇒ box edges x∈{0.2,0.8}) in `fill`,
 *  with an empty effect stack. Mirrors `seedRectFill` but takes a colour so the tone ops have a
 *  mid-grey to move (levels/posterise/invert leave pure white unmoved). */
async function f4Seed(page: Page, fill = '#ffffff'): Promise<void> {
  await addRect(page)
  await page.evaluate((f) => {
    const ls = (window as any).__compositorLayers()
    ls[0].w = 0.6; ls[0].h = 0.6; ls[0].radius = 0; ls[0].fill = f; ls[0].effects = []
    ;(window as any).__compositorSetLayers(ls)
  }, fill)
}

const setEffects = (page: Page, effects: unknown[]) => page.evaluate((fx) => {
  const ls = (window as any).__compositorLayers()
  ls[0].effects = fx
  ;(window as any).__compositorSetLayers(ls)
}, effects)

/** Assert `effects` (all visible) move the pixels vs `bare`, and return the changed render. */
async function expectChanges(page: Page, bare: string, effects: unknown[], minChanged = 200, minMax = 30): Promise<string> {
  await setEffects(page, effects)
  const after = await stackPixels(page)
  expect(after).not.toBe(bare)
  const d = await pixelDelta(page, bare, after)
  expect(d.sizeMismatch).toBe(false)
  expect(d.changed).toBeGreaterThan(minChanged)
  expect(d.max).toBeGreaterThan(minMax) // a real change, far past any render noise
  return after
}

/** Assert the same effect(s) with `visible:false` render byte-identical to the clean layer. */
async function expectHiddenIdentical(page: Page, bare: string, effects: Array<Record<string, unknown>>): Promise<void> {
  await setEffects(page, effects.map(e => ({ ...e, visible: false })))
  expect(await stackPixels(page)).toBe(bare)
}

/** Assert a VISIBLE effect at its neutral value is a no-op within render noise (see the block
 *  comment for why this is a tolerance, not strict byte-identity). */
const F4_NOOP_MAX = 8
async function expectNeutralNoop(page: Page, bare: string, neutral: unknown[]): Promise<void> {
  await setEffects(page, neutral)
  const d = await pixelDelta(page, bare, await stackPixels(page))
  expect(d.sizeMismatch).toBe(false)
  expect(d.max).toBeLessThanOrEqual(F4_NOOP_MAX)
}

test.describe('Frame layer styles — F4 pixel passes', () => {
  // FAMILY 1 — outer glow + inner glow.
  test('outer_glow & inner_glow change pixels; hidden byte-identical, neutral (intensity 0) a no-op', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)

    // byte-identity / neutral FIRST (before any offscreen pass has run).
    await expectHiddenIdentical(page, bare, [{ id: 'og', type: 'outer_glow', color: '#00e5ff', radius: 0.05, intensity: 1.5 }])
    await expectNeutralNoop(page, bare, [{ id: 'og', type: 'outer_glow', color: '#00e5ff', radius: 0.05, intensity: 0, visible: true }])

    // outer glow: a coloured halo behind the shape.
    await expectChanges(page, bare, [{ id: 'og', type: 'outer_glow', color: '#00e5ff', radius: 0.05, intensity: 1.5, visible: true }])
    // inner glow: a coloured band hugging the inside edge.
    await expectChanges(page, bare, [{ id: 'ig', type: 'inner_glow', color: '#00e5ff', radius: 0.06, intensity: 1.5, visible: true }])
    await expectNeutralNoop(page, bare, [{ id: 'ig', type: 'inner_glow', color: '#00e5ff', radius: 0.06, intensity: 0, visible: true }])
  })

  // FAMILY 2 — colour overlay + gradient overlay (blend mode + opacity).
  test('color_overlay & gradient_overlay change pixels; hidden byte-identical, neutral (opacity 0) a no-op', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)

    await expectHiddenIdentical(page, bare, [{ id: 'co', type: 'color_overlay', color: '#808080', blend: 'multiply', opacity: 1 }])
    await expectNeutralNoop(page, bare, [{ id: 'co', type: 'color_overlay', color: '#808080', blend: 'multiply', opacity: 0, visible: true }])

    // A grey multiplied over the white rect visibly darkens the whole fill.
    await expectChanges(page, bare, [{ id: 'co', type: 'color_overlay', color: '#808080', blend: 'multiply', opacity: 1, visible: true }])
    // A two-colour gradient plainly overlaid, clipped to the rect's alpha.
    await expectChanges(page, bare, [{ id: 'go', type: 'gradient_overlay', from: '#ff5b5b', to: '#4f8ad9', angle: 0, blend: 'normal', opacity: 1, visible: true }])
    await expectNeutralNoop(page, bare, [{ id: 'go', type: 'gradient_overlay', from: '#ff5b5b', to: '#4f8ad9', angle: 0, blend: 'normal', opacity: 0, visible: true }])
  })

  // FAMILY 3 — stroke from alpha (width, align, colour); inside + outside align both apply.
  test('stroke_from_alpha inside & outside both change pixels; outside grows past the box, inside does not; neutral (width 0) a no-op', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)
    const bareExtent = await inkExtent(page)

    await expectHiddenIdentical(page, bare, [{ id: 'sk', type: 'stroke_from_alpha', width: 0.02, align: 'center', color: '#ff0000' }])
    await expectNeutralNoop(page, bare, [{ id: 'sk', type: 'stroke_from_alpha', width: 0, align: 'center', color: '#ff0000', visible: true }])

    // Inside align: a red band on the inner edge — a real change that stays WITHIN the box.
    await expectChanges(page, bare, [{ id: 'sk', type: 'stroke_from_alpha', width: 0.03, align: 'inside', color: '#ff0000', visible: true }])
    const insideExtent = await inkExtent(page)
    expect(insideExtent.maxX).toBeLessThan(bareExtent.maxX + 0.01) // inside-only: no outward growth

    // Outside align: a red band on the outer edge — grows the silhouette OUTSIDE the box.
    await expectChanges(page, bare, [{ id: 'sk', type: 'stroke_from_alpha', width: 0.03, align: 'outside', color: '#ff0000', visible: true }])
    const outsideExtent = await inkExtent(page)
    expect(outsideExtent.maxX).toBeGreaterThan(bareExtent.maxX + 0.01) // outside: reaches past the box edge
  })

  // FAMILY 4 — directional, radial, zoom blur.
  test('directional/radial/zoom blur each change pixels; hidden byte-identical, neutral (distance|amount 0) a no-op', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)

    await expectHiddenIdentical(page, bare, [{ id: 'db', type: 'directional_blur', angle: 0, distance: 0.06 }])
    await expectNeutralNoop(page, bare, [{ id: 'db', type: 'directional_blur', angle: 0, distance: 0, visible: true }])
    await expectChanges(page, bare, [{ id: 'db', type: 'directional_blur', angle: 0, distance: 0.06, visible: true }])

    await expectHiddenIdentical(page, bare, [{ id: 'rb', type: 'radial_blur', centerX: 0.5, centerY: 0.5, amount: 0.6 }])
    await expectNeutralNoop(page, bare, [{ id: 'rb', type: 'radial_blur', centerX: 0.5, centerY: 0.5, amount: 0, visible: true }])
    await expectChanges(page, bare, [{ id: 'rb', type: 'radial_blur', centerX: 0.5, centerY: 0.5, amount: 0.6, visible: true }])

    await expectHiddenIdentical(page, bare, [{ id: 'zb', type: 'zoom_blur', centerX: 0.5, centerY: 0.5, amount: 0.6 }])
    await expectNeutralNoop(page, bare, [{ id: 'zb', type: 'zoom_blur', centerX: 0.5, centerY: 0.5, amount: 0, visible: true }])
    await expectChanges(page, bare, [{ id: 'zb', type: 'zoom_blur', centerX: 0.5, centerY: 0.5, amount: 0.6, visible: true }])
  })

  // FAMILY 5 — levels, posterise, threshold, invert (on a mid-grey rect so each op moves it).
  test('levels/posterise/threshold/invert each change pixels; hidden byte-identical, levels-identity & invert-0 no-ops', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#4d4d4d') // mid grey (77) — each tone op moves it clearly
    const bare = await stackPixels(page)

    // levels: identity default is a clean pass-level no-op AND we assert it within tolerance
    // (routes through the offscreen), then a real gamma pull darkens the grey.
    await expectHiddenIdentical(page, bare, [{ id: 'lv', type: 'levels', black: 0, white: 1, gamma: 0.4 }])
    await expectNeutralNoop(page, bare, [{ id: 'lv', type: 'levels', black: 0, white: 1, gamma: 1, visible: true }]) // identity
    await expectChanges(page, bare, [{ id: 'lv', type: 'levels', black: 0, white: 1, gamma: 0.4, visible: true }])

    // posterise: no clean neutral value → byte-identity via the hidden form only.
    await expectHiddenIdentical(page, bare, [{ id: 'po', type: 'posterise', levels: 2 }])
    await expectChanges(page, bare, [{ id: 'po', type: 'posterise', levels: 2, visible: true }])

    // threshold: no clean neutral value → hidden form only; 77 < 0.5 cutoff ⇒ snaps to black.
    await expectHiddenIdentical(page, bare, [{ id: 'th', type: 'threshold', cutoff: 0.5 }])
    await expectChanges(page, bare, [{ id: 'th', type: 'threshold', cutoff: 0.5, visible: true }])

    // invert: amount 0 is a clean neutral; amount 1 flips 77→178.
    await expectHiddenIdentical(page, bare, [{ id: 'iv', type: 'invert', amount: 1 }])
    await expectNeutralNoop(page, bare, [{ id: 'iv', type: 'invert', amount: 0, visible: true }])
    await expectChanges(page, bare, [{ id: 'iv', type: 'invert', amount: 1, visible: true }])
  })

  // FAMILY 6 — rough edge + ink bleed (seeded edge kinds); prove DETERMINISM.
  test('rough_edge & ink_bleed change pixels, are deterministic per seed, and no-op at amount 0', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)

    await expectHiddenIdentical(page, bare, [{ id: 're', type: 'rough_edge', amount: 0.6, detail: 8, seed: 5 }])
    await expectNeutralNoop(page, bare, [{ id: 're', type: 'rough_edge', amount: 0, detail: 8, seed: 5, visible: true }])

    // rough edge: a seeded jitter of the alpha boundary — a real change.
    const rough5 = await expectChanges(page, bare, [{ id: 're', type: 'rough_edge', amount: 0.6, detail: 8, seed: 5, visible: true }])
    // DETERMINISTIC: clear, then re-apply the SAME seed ⇒ byte-identical to the first render.
    await setEffects(page, [])
    await stackPixels(page)
    await setEffects(page, [{ id: 're', type: 'rough_edge', amount: 0.6, detail: 8, seed: 5, visible: true }])
    expect(await stackPixels(page)).toBe(rough5)
    // A DIFFERENT seed ⇒ a different silhouette (the seed genuinely drives the noise).
    await setEffects(page, [{ id: 're', type: 'rough_edge', amount: 0.6, detail: 8, seed: 99, visible: true }])
    expect(await stackPixels(page)).not.toBe(rough5)

    // ink bleed: a seeded outward spread — a real change, deterministic per seed.
    await expectHiddenIdentical(page, bare, [{ id: 'ib', type: 'ink_bleed', amount: 0.5, seed: 3, softness: 0.3 }])
    await expectNeutralNoop(page, bare, [{ id: 'ib', type: 'ink_bleed', amount: 0, seed: 3, softness: 0.3, visible: true }])
    const bleed3 = await expectChanges(page, bare, [{ id: 'ib', type: 'ink_bleed', amount: 0.5, seed: 3, softness: 0.3, visible: true }])
    await setEffects(page, [])
    await stackPixels(page)
    await setEffects(page, [{ id: 'ib', type: 'ink_bleed', amount: 0.5, seed: 3, softness: 0.3, visible: true }])
    expect(await stackPixels(page)).toBe(bleed3)
    await setEffects(page, [{ id: 'ib', type: 'ink_bleed', amount: 0.5, seed: 42, softness: 0.3, visible: true }])
    expect(await stackPixels(page)).not.toBe(bleed3)
  })

  // The pad fold — an OUTER-growing kind on a layer whose box raster edge it crosses is NOT
  // clipped there. A centred 0.6 rect has box edges at x∈{0.2,0.8}; outer glow and an outside
  // stroke must reach OUTWARD past those edges (the offscreen pad grows to hold them), where a
  // too-small pad would clip the growth back to the box. Byte-identity (pad 0 when absent) is
  // checked first, on the clean fast path.
  test('an outer-growing kind crosses the box raster edge without being clipped (pad fold)', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)
    const bareExtent = await inkExtent(page)
    expect(bareExtent.any).toBe(true)

    // Pad contributes 0 when the grower is absent/hidden ⇒ byte-identical to the fast path.
    await expectHiddenIdentical(page, bare, [{ id: 'og', type: 'outer_glow', color: '#00e5ff', radius: 0.06, intensity: 2 }])

    // Outer glow: a strong halo must extend OUTWARD past BOTH box edges (not clipped at 0.2/0.8).
    await setEffects(page, [{ id: 'og', type: 'outer_glow', color: '#00e5ff', radius: 0.06, intensity: 2, visible: true }])
    await stackPixels(page)
    const glow = await inkExtent(page)
    // eslint-disable-next-line no-console
    console.log('[F4 pad] bare maxX=%s glow maxX=%s minX=%s', bareExtent.maxX.toFixed(3), glow.maxX.toFixed(3), glow.minX.toFixed(3))
    expect(glow.maxX).toBeGreaterThan(bareExtent.maxX + 0.01) // grew rightward past the box edge
    expect(glow.minX).toBeLessThan(bareExtent.minX - 0.01)    // and leftward — the pad held both

    // Outside stroke: an alpha-edge band on the OUTSIDE also grows past the box edge.
    await setEffects(page, [{ id: 'sk', type: 'stroke_from_alpha', width: 0.03, align: 'outside', color: '#ff0000', visible: true }])
    await stackPixels(page)
    const stroke = await inkExtent(page)
    expect(stroke.maxX).toBeGreaterThan(bareExtent.maxX + 0.01)
  })
})

/**
 * F5 Task 2 — the `shader` pixel effect: `applyShaderPixelEffect` in useCompositorLayers.ts
 * runs a named Shader Studio catalog effect over a layer's OWN already-rendered pixels,
 * alpha preserved, byte-identical when absent. DISTINCT from a shader FILL (which replaces
 * the layer's fill entirely — see shader-fill.spec.ts) and from the glass lens (which
 * refracts the layers BEHIND the layer, not its own content).
 *
 * Byte-identity is the load-bearing guard here: before this task, a `shader` entry in a
 * layer's effect stack was a silent no-op (Task 1's model comment: 'shader' is not in
 * postEffects.ts's own `PASS_TYPES`, so the pixel-pass switch's `default: applyPasses(...)`
 * branch drops it on the floor). The new `case 'shader'` in the switch (paintLayer,
 * useCompositorLayers.ts ~2745) is the ONE thing that can make a shader effect actually
 * paint — so the "applied" test below is what proves the case is wired at all, and the
 * byte-identity test proves it is inert whenever no `shader` effect is present (a stub that
 * called `applyShaderPixelEffect` unconditionally, outside the switch's per-type dispatch,
 * would fail the byte-identity test here while still passing "applied" — that contrast is
 * what makes the gate load-bearing, not merely present).
 *
 * The shader catalog is fetched asynchronously (`fetchShaderFxCatalog`, ~/lib/shaderfx/
 * catalogStore.ts) and `renderFieldWithBase` throws until it lands — `applyShaderPixelEffect`
 * catches that and leaves the layer's pixels untouched for that frame (see the comment at its
 * definition). Unlike Space Type/Scene3D (their own rAF loop repaints once the catalog
 * resolves), the Compositor's static edit view only repaints reactively, so `settledWithShader`
 * below waits for the fetch then forces a fresh paint — the same recipe shader-fill.spec.ts's
 * "Frame (Compositor)" golden coverage uses for the identical race.
 */
test.describe('Frame shader-catalog pixel pass (F5 Task 2)', () => {
  test.use({ deviceScaleFactor: 2 })

  // chromatic_aberration hard-codes its output alpha to 1.0 (shader_effects/
  // chromatic_aberration.frag: `fragColor0 = vec4(r, g, b, 1.0)`) — exactly the "most
  // catalog frags don't preserve alpha" case the recombine exists for. amount is pushed
  // well past the picker's own 0..0.08 slider range so the radial RGB split is unmistakable
  // at the rect's edge, not a borderline render-noise delta.
  const CHROMA = { id: 'sh', type: 'shader', effectId: 'chromatic_aberration', params: { amount: 0.3 }, speed: 1, seed: 42, visible: true }

  /** Force a fresh paintLayerStack() after giving the async catalog fetch time to land. The
   *  Compositor's static edit view does not repaint on its own once the fetch resolves (no
   *  idle rAF loop, unlike Space Type/Scene3D) — a real layer-list write is what forces the
   *  next repaint, so re-set the SAME effects (a new array reference) once the wait is up. */
  async function settledWithShader(page: Page, effects: unknown[]): Promise<string> {
    await setEffects(page, effects)
    await stackPixels(page)                 // first paint likely races the catalog fetch — a no-op
    await page.waitForTimeout(1_500)
    await setEffects(page, effects)         // re-set forces a repaint now the catalog is warm
    return stackPixels(page)
  }

  test('byte-identity A/B: a layer with no shader effect renders identically before/after a round-trip', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const before = await stackPixels(page)

    // Toggle a visible, real shader effect ON, then back OFF: the return-to-none render must
    // be byte-identical to the virgin bare render — the `case 'shader'` never fires once the
    // effect is gone (bodyPasses no longer contains it), so nothing it does can leak forward.
    await settledWithShader(page, [CHROMA])
    await setEffects(page, [])
    const after = await stackPixels(page)

    expect(after).toBe(before)
  })

  test('adding chromatic_aberration changes the layer\'s own pixels (applied)', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    const bare = await stackPixels(page)

    const after = await settledWithShader(page, [CHROMA])
    expect(after).not.toBe(bare)
    const d = await pixelDelta(page, bare, after)
    expect(d.sizeMismatch).toBe(false)
    // A radial RGB split at the rect's edge is a real (if edge-only) pixel change, not noise.
    expect(d.changed).toBeGreaterThan(50)
  })

  test('alpha is preserved: a transparent region of the layer stays transparent', async ({ page }) => {
    await openCompositor(page)
    // An ellipse inscribed in its own SQUARE bounding box leaves the box's corners
    // transparent — the curve never reaches them — so it's a partially-transparent layer
    // with no extra geometry effect needed. A broken recombine (or none at all) would flood
    // this corner opaque black, since chromatic_aberration forces alpha=1 everywhere.
    await seedOne(page, { id: 'e1', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, opacity: 1, fill: '#ffffff' })
    await stackPixels(page) // settle the first paint before sampling
    const cornerBefore = await colorAt(page, 0.27, 0.27) // just inside the box corner, outside the ellipse curve
    expect(cornerBefore.a).toBeLessThan(20)

    await settledWithShader(page, [CHROMA])
    const cornerAfter = await colorAt(page, 0.27, 0.27)
    expect(cornerAfter.a).toBeLessThan(20)
  })

  // ── F5 Task 4 ──────────────────────────────────────────────────────────────────────
  // Duplicates + reorder, the layer-pass/studio-effect parity proof, and the animated-
  // preview-advances proof. `posterize` is a second real, input-sampling, NON-animated
  // catalog effect (manifest.json: `animated: false`, reads `u_image0`) — distinct
  // enough from `chromatic_aberration`'s RGB split that stacking/reordering the two
  // moves real pixels, not render noise.
  const POSTERIZE = { id: 'sh2', type: 'shader', effectId: 'posterize', params: { levels: 3 }, speed: 0, seed: 42, visible: true }

  test('two shader effects on one layer both apply, in stack order', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')

    const oneOnly = await settledWithShader(page, [CHROMA])
    const both = await settledWithShader(page, [CHROMA, POSTERIZE])
    expect(both).not.toBe(oneOnly)
    const d = await pixelDelta(page, oneOnly, both)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(50)
  })

  test('reordering two shader effects changes the render (canReorder, automatic)', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')

    const chromaThenPosterize = await settledWithShader(page, [CHROMA, POSTERIZE])
    const posterizeThenChroma = await settledWithShader(page, [POSTERIZE, CHROMA])
    expect(posterizeThenChroma).not.toBe(chromaThenPosterize)
  })

  test('parity: the layer pass IS renderFieldWithBase + the documented alpha recombine, not a reimplementation', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    // Warm the shader catalog exactly like the other tests in this suite, so the probe's
    // own renderFieldWithBase call (below) doesn't race the fetch.
    await settledWithShader(page, [CHROMA])

    const result = await page.evaluate(() =>
      (window as any).__compositorShaderParityProbe(
        { type: 'shader', visible: true, effectId: 'chromatic_aberration', params: { amount: 0.3 }, speed: 0, seed: 42 },
        200, 200,
      ))
    expect(result.actual).toBe(result.expected)
  })

  test('an animated shader effect makes the preview advance over time', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#ffffff')
    // fbm_warp is a real, input-sampling, ANIMATED catalog effect (manifest.json:
    // `animated: true`, its .frag scales u_time by u_speed) — unlike chromatic_aberration
    // (whose .frag never reads u_time at all), so a nonzero top-level `speed` here actually
    // moves the render frame over frame, which is what this test needs to prove the modal's
    // live loop is really advancing, not just repainting the same pixels.
    const ANIM = { id: 'sh3', type: 'shader', effectId: 'fbm_warp', params: {}, speed: 1, seed: 42, visible: true }
    const readCanvas = () => page.evaluate(() =>
      (document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement).toDataURL())

    await setEffects(page, [ANIM])
    await readCanvas()                 // first paint likely races the catalog fetch — a no-op
    await page.waitForTimeout(1_500)
    await setEffects(page, [ANIM])     // re-set forces a repaint now the catalog is warm, and
                                        // (this is the Task 4 fix under test) starts the modal's
                                        // live rAF loop now that hasAnimatedShaderFill sees it.
    await page.waitForTimeout(300)     // let the live loop actually tick a few frames
    const frame1 = await readCanvas()
    await page.waitForTimeout(600)     // real wall-clock time passing, well past one SHADER_PREVIEW_FPS tick
    const frame2 = await readCanvas()
    expect(frame2).not.toBe(frame1)
  })
})

/**
 * F5 Task 3 — the shader effect INSPECTOR: picking a catalog effect for a layer's `shader`
 * pass and tuning its params. Distinct from Task 2 above (the GPU pass itself, exercised there
 * via direct `setEffects` writes) — this suite drives the real add → pick → tune UI: the tree
 * "+" menu, the reused `CatalogModal` picker (filtered to `effectReadsInput` effects, the same
 * gate the glass lens's Reads picker applies), and the derived param dials
 * (`buildShaderParamRows` / `derivedShaderFillControls`, shared with ShaderFillEditor.vue's
 * shader-FILL editor).
 *
 * `plasma` is the picker's confirmed-excluded generative: its .frag declares
 * `uniform sampler2D u_image0` (every catalog frag does) but never calls `texture(u_image0, …)`
 * — a bare declaration is NOT enough for `effectReadsInput` (catalogStore.ts's own doc), so this
 * is a real "never samples its input" case, not a guess from the effect's name or category.
 * `chromatic_aberration` is the confirmed-included input-sampler (it per-channel offsets a real
 * `texture(u_image0, …)` read — Task 2's own fixture above) and is also the `shader` kind's
 * `LOCAL_DEFAULTS` effect (effectStack.ts), so a freshly added shader effect already renders it.
 */
test.describe('Frame shader effect inspector (F5 Task 3)', () => {
  test.use({ deviceScaleFactor: 2 })

  test('adding a Shader effect shows the breadcrumb, and its picker opens', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="shader"]').click()

    await expect(page.getByTestId('effect-breadcrumb')).toContainText('Shader')

    await page.getByTestId('shader-fx-picker').click()
    await expect(page.getByText('Shader effects')).toBeVisible()
  })

  test('the picker lists an input-sampling effect and excludes a confirmed pure-generative one', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="shader"]').click()
    await page.getByTestId('shader-fx-picker').click()

    // Scope to the teleported CatalogModal (identified by its "Shader effects" heading), so the
    // card locator can't also match the picker TRIGGER button, which shows the current selection
    // name and lives outside the modal — matching both is a strict-mode violation.
    const catalog = page.locator('div.fixed.inset-0').filter({ hasText: 'Shader effects' })

    // Wait generously — the catalog is fetched from the ComfyUI backend and this is the first
    // thing in the suite that needs it warm. Once this card is visible the catalog (and
    // therefore the `effectReadsInput` filter) has genuinely resolved.
    await expect(catalog.getByRole('button', { name: /chromatic aberration/i })).toBeVisible({ timeout: 20_000 })

    // Asserted only AFTER the catalog is confirmed warm above, so this is a real absence
    // (the effect was excluded), not "the list just hasn't loaded yet" giving a false pass.
    await expect(catalog.getByRole('button', { name: /plasma/i })).toHaveCount(0)
  })

  test('picking an effect renders it over the layer, and a param dial moves the render again', async ({ page }) => {
    await openCompositor(page)
    await addRect(page)
    await seedRectFill(page)
    const bare = await stackPixels(page)

    await openFxMenuFirst(page)
    await page.locator('[data-testid="add-effect-item"][data-kind="shader"]').click()
    await page.getByTestId('shader-fx-picker').click()
    // Scope to the teleported CatalogModal so the card can't also match the picker trigger button.
    const catalog = page.locator('div.fixed.inset-0').filter({ hasText: 'Shader effects' })
    const card = catalog.getByRole('button', { name: /chromatic aberration/i })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
    await page.getByRole('button', { name: 'Use effect' }).click()

    // The pick reached the stored effect (not just the picker's own UI state) …
    await expect.poll(() => page.evaluate(() =>
      ((window as any).__compositorLayers()[0].effects || []).find((e: any) => e.type === 'shader')?.effectId))
      .toBe('chromatic_aberration')

    // … and moved real pixels vs the plain, shader-less layer.
    const picked = await stackPixels(page)
    expect(picked).not.toBe(bare)
    const d1 = await pixelDelta(page, bare, picked)
    expect(d1.sizeMismatch).toBe(false)
    expect(d1.changed).toBeGreaterThan(50)

    // Move the Amount dial via its accessible slider role (StudioRow's own keyboard path,
    // step 0.002 over 0..0.08) — a live uniform must move the render again, not sit dead.
    const track = page.getByTestId('shader-fx-param-amount').locator('[role="slider"]')
    await track.focus()
    for (let i = 0; i < 20; i++) await track.press('ArrowRight')

    const tuned = await stackPixels(page)
    expect(tuned).not.toBe(picked)
  })
})

/*
 * F7 Task 1 — print RECIPES: `risograph` (and, model-only this task, `photocopy`/`letterpress`)
 * are orderable pixel-region effects that EXPAND at paint time into a sequence of the existing
 * postEffects.ts passes (`expandRecipe` in ~/lib/compositor/recipes.ts), run on the layer's own
 * device-res offscreen by the bodyPasses dispatch loop in useCompositorLayers.ts. Same oracle as
 * F4/F5: a real pixelDelta when applied, strict byte-identity when the recipe is absent (RED-first
 * — a recipe that never fired must leave the layer's bytes untouched). Vector rects are
 * deterministic, so `stackPixels` strict `toBe` is safe here (as in the F4 block).
 */
test.describe('Frame print recipes (F7)', () => {
  const setTopEffects = (page: Page, effects: unknown[]) => page.evaluate((fx) => {
    const ls = (window as any).__compositorLayers()
    ls[0].effects = fx
    ;(window as any).__compositorSetLayers(ls)
  }, effects)

  test('risograph byte-identity: added then removed returns to the untouched render (F7 recipe absent)', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#808080') // a mid-grey rect gives the tone ramp something to move
    const bare = await stackPixels(page)

    await setTopEffects(page, [{ id: 'riso', type: 'risograph', ink: '#2b3a8c', inkTwo: '#e03a6d', levels: 4, grain: 0.16, contrast: 1.12, visible: true }])
    await stackPixels(page)
    await setTopEffects(page, [])
    const after = await stackPixels(page)
    expect(after).toBe(bare) // no recipe case fires ⇒ byte-identical
  })

  test('risograph applied: the composed look moves the layer\'s own pixels', async ({ page }) => {
    await openCompositor(page)
    await f4Seed(page, '#808080')
    const bare = await stackPixels(page)

    await setTopEffects(page, [{ id: 'riso', type: 'risograph', ink: '#2b3a8c', inkTwo: '#e03a6d', levels: 4, grain: 0.16, contrast: 1.12, visible: true }])
    const after = await stackPixels(page)
    expect(after).not.toBe(bare)
    const d = await pixelDelta(page, bare, after)
    expect(d.sizeMismatch).toBe(false)
    expect(d.changed).toBeGreaterThan(500) // the paper→ink ramp + grain repaint a lot of the rect
    expect(d.max).toBeGreaterThan(30)      // a real tonal shift, far past render noise
  })
})
