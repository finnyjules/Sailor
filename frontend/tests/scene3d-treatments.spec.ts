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
const FADE = { id: 't-fade', kind: 'fade', enabled: true, invert: false, opacity: 0.95 }

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

/**
 * The shadow probe (C1). A masked treatment hides its object for the BASE pass; three
 * rebuilds the shadow map on every `renderer.render`, and `WebGLShadowMap` skips invisible
 * objects — so without the shadow-map freeze in `TreatmentStage.render` the treated object's
 * cast shadow vanishes from the floor even though the object itself is still composited back.
 * A Fade at 0.95 is the cleanest witness: visually a no-op on the object, fatal to its shadow.
 *
 * Rather than hard-code pixels, the patches are PROJECTED: the floor point the sun puts the
 * left sphere's shadow on, and a same-size patch of open floor on the same image row further
 * left. Camera maths mirrors three's PerspectiveCamera (vertical fov, right-handed look-at),
 * so the probe survives a viewport resize.
 */
const SUN_AZIMUTH = 90
const shadowScene = () => ({
  version: 1, background: '#202020', showFloor: true,
  // The default 'soft' preset does not cast at all (PRESETS.soft.shadow === false) — the
  // whole finding is about a shadow that EXISTS being deleted, so the scene must cast one.
  // …and the sun is swung due east so the shadow lands BESIDE the sphere rather than
  // behind it: at the default azimuth this shallow camera hides the shadow behind the
  // sphere's own silhouette, leaving no floor to probe.
  lighting: { preset: 'dramatic', sunAzimuth: SUN_AZIMUTH },
  camera: { position: [0, 1.2, 5.5], target: [0, 0.6, 0], fov: 40 },
  objects: [
    sphere('left', 'Left', -1.4, '#d94f3a', [FADE]),
    sphere('right', 'Right', 1.4, '#3a8ad9'),
  ],
})

/** Mean luminance of an `w`×`h` patch centred on (cx, cy) in image px. */
async function patchLuma(
  page: Page, dataUrl: string, patches: { cx: number; cy: number }[], w: number, h: number,
): Promise<{ values: number[]; width: number; height: number }> {
  return page.evaluate(async ({ url, patches, w, h }) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const mean = (cx: number, cy: number) => {
      let s = 0, n = 0
      for (let y = Math.round(cy - h / 2); y < Math.round(cy + h / 2); y++) {
        for (let x = Math.round(cx - w / 2); x < Math.round(cx + w / 2); x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          const i = (y * width + x) * 4
          s += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!; n++
        }
      }
      return n ? s / n : 0
    }
    return { values: patches.map((p) => mean(p.cx, p.cy)), width, height }
  }, { url: dataUrl, patches, w, h })
}

/** World → image px, matching three's PerspectiveCamera (fov is VERTICAL, look-at with +Y up). */
function projectToImage(
  world: [number, number, number], cam: { x: number; y: number; z: number; tx: number; ty: number; tz: number },
  fovDeg: number, width: number, height: number,
): { x: number; y: number } {
  const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  const cross = (a: number[], b: number[]) => [
    a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!,
  ]
  const norm = (a: number[]) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1; return [a[0]! / l, a[1]! / l, a[2]! / l] }
  const eye = [cam.x, cam.y, cam.z]
  const zAxis = norm(sub(eye, [cam.tx, cam.ty, cam.tz]))
  const xAxis = norm(cross([0, 1, 0], zAxis))
  const yAxis = cross(zAxis, xAxis)
  const rel = sub(world as unknown as number[], eye)
  const camX = dot(rel, xAxis), camY = dot(rel, yAxis), camZ = dot(rel, zAxis)
  const t = Math.tan((fovDeg * Math.PI) / 360) * -camZ
  const ndcX = camX / (t * (width / height))
  const ndcY = camY / t
  return { x: (ndcX * 0.5 + 0.5) * width, y: (1 - (ndcY * 0.5 + 0.5)) * height }
}

/** Where the sun (`SUN_AZIMUTH`, elevation 40° — the doc default) drops the shadow of a
 *  sphere centred at `[x, y, z]` onto y = 0. Mirrors `engine.ts`'s `sunDirection`. */
function shadowFootWorld(x: number, y: number, z: number): [number, number, number] {
  const az = (SUN_AZIMUTH * Math.PI) / 180, el = (40 * Math.PI) / 180
  const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]
  const t = y / dir[1]!
  return [x - dir[0]! * t, 0, z - dir[2]! * t]
}

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

  test('a masked treatment keeps the object\'s cast shadow on the floor', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, shadowScene())
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const shot = await snapshot(page)
    const cam = await page.evaluate(() => (window as any).__scene3dCamera())
    // One probe first, only to learn the image size the projection needs.
    const size = await patchLuma(page, shot, [{ cx: 0, cy: 0 }], 1, 1)
    const foot = projectToImage(shadowFootWorld(-1.4, 0.6, 0), cam, 40, size.width, size.height)
    // Same image ROW, so both patches see the same grid lines and the same floor depth;
    // only x moves, out to open floor well clear of the (PCF-softened) shadow.
    const open = { cx: Math.round(size.width * 0.06), cy: Math.round(foot.y) }
    const w = Math.round(size.width * 0.05), h = Math.round(size.height * 0.035)
    const { values } = await patchLuma(page, shot, [{ cx: Math.round(foot.x), cy: Math.round(foot.y) }, open], w, h)
    const [under, openFloor] = values as [number, number]
    console.log(`[shadow] image=${size.width}x${size.height} under=(${Math.round(foot.x)},${Math.round(foot.y)}) ${under.toFixed(2)} open=(${open.cx},${open.cy}) ${openFloor.toFixed(2)} ratio=${(under / openFloor).toFixed(3)}`)
    expect(openFloor).toBeGreaterThan(1) // there IS floor to compare against
    expect(under).toBeLessThan(openFloor * 0.85)
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
