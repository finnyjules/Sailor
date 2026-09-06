import { test, expect, type Page } from '@playwright/test'

/**
 * Per-object treatments, end to end against the real WebGL path (design spec §5).
 *
 * Instrument: `__scene3dSnapshot()` renders one frame and returns the canvas PNG; the
 * sharpness metric below is the mean SQUARED horizontal luminance step (gradient energy)
 * inside the middle band of each image half. A blurred sphere scores far under a sharp one.
 * Every visual assertion is paired with `__scene3dTreatmentStats()` so a stage that silently
 * fell back to the plain render (frames 0) fails loudly instead of passing on sharp/sharp.
 *
 * Why SQUARED and not the mean absolute step: total variation is conserved by a blur. Along
 * a monotone edge, sum|f(x+1)-f(x)| equals the edge's total height however wide the ramp is,
 * so mean|dx| is nearly blind to blurring a sphere — measured on this exact scene it moved
 * only 0.40 → 0.28 for a blur that visibly smears the sphere across 60 extra pixels. Squaring
 * makes the score scale as 1/width for a fixed edge height, which is what "sharpness" means;
 * on the same frames it moves 26.7 → 0.86. (Gradient energy is the standard focus measure.)
 *
 * Halves are only ever compared WITHIN one frame. The composer path renders the background
 * darker than the direct path (a pre-existing property of the post stack, reproducible with
 * zero treatments — see the task 9 report), which would bias any treated-vs-plain comparison
 * of absolute numbers; comparing left against right inside one image cancels it.
 *
 * Headless Chromium draws WebGL through SwiftShader, hence the generous settle wait.
 */

const SETTLE_MS = 3000
/** Only proves there IS an edge to measure on the sharp side; the ratio is the claim.
 *  Measured on this scene: sharp halves 16.9–26.7, blurred halves 0.86–1.09. */
const SHARP_FLOOR = 5

const sphere = (id: string, name: string, x: number, color: string, treatments?: unknown[]) => ({
  id, kind: 'primitive', primitive: 'sphere', name, visible: true,
  position: [x, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color, roughness: 0.4, metalness: 0 },
  ...(treatments ? { treatments } : {}),
})
const twoSpheres = (leftTreatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 1.2, 5.5], target: [0, 0.6, 0], fov: 40 },
  objects: [
    sphere('left', 'Left', -1.4, '#d94f3a', leftTreatments),
    sphere('right', 'Right', 1.4, '#3a8ad9'),
  ],
})
const BLUR = { id: 't-blur', kind: 'blur', enabled: true, invert: false, amount: 1 }

async function openLab(page: Page, state: unknown): Promise<void> {
  await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(state))}`)
  await expect.poll(() => page.evaluate(() => typeof (window as any).__scene3dSnapshot === 'function'), { timeout: 30_000 }).toBe(true)
  // Let the engine sync + a few rAF frames run so materials/env are settled.
  await expect.poll(() => page.evaluate(() => (window as any).__scene3dDoc().objects.length), { timeout: 10_000 }).toBe(2)
  await page.waitForTimeout(SETTLE_MS)
}

async function sharpness(page: Page, dataUrl: string): Promise<{ left: number; right: number }> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const score = (x0: number, x1: number) => {
      let s = 0, n = 0
      for (let y = Math.floor(height * 0.3); y < height * 0.7; y++) {
        for (let x = x0; x < x1 - 1; x++) { const i = (y * width + x) * 4; const d = lum(i) - lum(i + 4); s += d * d; n++ }
      }
      return s / n
    }
    return { left: score(0, Math.floor(width / 2)), right: score(Math.floor(width / 2), width) }
  }, dataUrl)
}

const stats = (page: Page) => page.evaluate(() => (window as any).__scene3dTreatmentStats() as { frames: number; groups: number })
const snapshot = (page: Page) => page.evaluate(() => (window as any).__scene3dSnapshot() as string)

/** Surfaces a GLSL compile failure or a thrown frame as the reason a test failed, rather
 *  than leaving the reader with only a sharpness number. */
function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  return errs
}

test.describe('3D Studio treatments', () => {
  test('a blur on the left sphere softens the left half only, and the stage actually ran', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([BLUR]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const { left, right } = await sharpness(page, await snapshot(page))
    console.log(`[blur] left=${left.toFixed(3)} right=${right.toFixed(3)} ratio=${(left / right).toFixed(3)}`)
    expect(right).toBeGreaterThan(SHARP_FLOOR)
    expect(left).toBeLessThan(right * 0.5)
  })

  test('"Everything else" flips which side is blurred', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([{ ...BLUR, invert: true }]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const { left, right } = await sharpness(page, await snapshot(page))
    console.log(`[invert] left=${left.toFixed(3)} right=${right.toFixed(3)} ratio=${(right / left).toFixed(3)}`)
    expect(left).toBeGreaterThan(SHARP_FLOOR)
    expect(right).toBeLessThan(left * 0.5)
  })

  test('the export bake carries the treatment (viewport and still agree)', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([BLUR]))
    expect((await stats(page)).frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    const live = await sharpness(page, await snapshot(page))
    const beauty = await page.evaluate(() => (window as any).__scene3dBeauty() as Promise<string>)
    expect(beauty.startsWith('data:image/png')).toBe(true)
    const baked = await sharpness(page, beauty)
    console.log(`[bake] live left=${live.left.toFixed(3)} right=${live.right.toFixed(3)} | baked left=${baked.left.toFixed(3)} right=${baked.right.toFixed(3)}`)
    expect(live.left).toBeLessThan(live.right * 0.5)
    expect(baked.left).toBeLessThan(baked.right * 0.5)
  })

  test('with no treatment the plain render path is used (stage never runs)', async ({ page }) => {
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames).toBe(0)
    const { left, right } = await sharpness(page, await snapshot(page))
    console.log(`[plain] left=${left.toFixed(3)} right=${right.toFixed(3)}`)
    expect(Math.abs(left - right)).toBeLessThan(Math.max(left, right) * 0.35)
  })

  test('tree flow: add a rim light from the row menu, see the breadcrumb, toggle, remove', async ({ page }) => {
    await openLab(page, twoSpheres())
    const row = page.locator('[data-testid="object-row"][data-object-name="Left"]')
    await row.hover()
    await row.locator('[data-testid="add-treatment"]').click()
    await page.locator('[data-testid="add-treatment-item"][data-kind="rimLight"]').click()
    const trow = page.locator('[data-testid="treatment-row"][data-treatment-kind="rimLight"]')
    await expect(trow).toBeVisible()
    await expect(trow).toHaveText(/Rim light/)
    await expect(page.getByTestId('treatment-breadcrumb')).toHaveText(/Left.*Rim light/)
    await expect(page.getByLabel('Strength')).toBeVisible()
    const docTreatments = () => page.evaluate(() => (window as any).__scene3dDoc().objects[0].treatments)
    expect(await docTreatments()).toHaveLength(1)
    expect((await docTreatments())[0]).toMatchObject({ kind: 'rimLight', enabled: true })
    await trow.hover()
    await trow.getByRole('button', { name: 'Hide treatment' }).click()
    expect((await docTreatments())[0].enabled).toBe(false)
    await trow.hover()
    await trow.getByRole('button', { name: 'Remove treatment' }).click()
    await expect(trow).toHaveCount(0)
    expect(await docTreatments()).toBeUndefined()
    await expect(page.getByTestId('treatment-breadcrumb')).toHaveCount(0)
  })
})
