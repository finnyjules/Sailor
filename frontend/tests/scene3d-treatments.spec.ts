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

/** Gradient energy in a top band and a bottom band of the left sphere. */
async function bandEnergy(page: Page, dataUrl: string): Promise<{ top: number; bottom: number }> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const score = (fy0: number, fy1: number) => {
      let s = 0, n = 0
      for (let y = Math.floor(height * fy0); y < height * fy1; y++)
        for (let x = Math.floor(width * 0.25); x < width * 0.45 - 1; x++) {
          const i = (y * width + x) * 4; const d = lum(i) - lum(i + 4); s += d * d; n++
        }
      return s / n
    }
    return { top: score(0.34, 0.44), bottom: score(0.56, 0.66) }
  }, dataUrl)
}

/** Run one treatment twice — ramped, and with the ramp ramping to nothing (start = end = 1,
 *  a hard edge at the far end, so every pixel sits in the untouched region) — and return each
 *  band's energy as a fraction of the control. Same composer path both times, so the path's own
 *  background shift cancels. */
async function rampAttenuation(page: Page, treatment: Record<string, unknown>) {
  await openLab(page, twoSpheres([{ ...treatment, rampStart: 1, rampEnd: 1 }]))
  const control = await bandEnergy(page, await snapshot(page))
  await openLab(page, twoSpheres([treatment]))
  const s = await stats(page)
  expect(s.frames).toBeGreaterThan(0)
  expect(s.groups).toBe(1)
  const test = await bandEnergy(page, await snapshot(page))
  return {
    control, test,
    top: test.top / control.top,
    bottom: test.bottom / control.bottom,
  }
}

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

  /**
   * The Fade dial must read PROPORTIONALLY on screen: at 0.5 the object should look half
   * way between fully there and fully gone. The stage composites in linear HDR and the
   * composer's OutputPass applies the ACES filmic curve afterwards, so a plain linear
   * alpha blend lands far too bright — ACES compresses highlights, and half the light is
   * nearly all the brightness. Measured before the display-space composite landed: the
   * 0.5 frame sat at 0.64 of the way from gone to solid (and the brightest pixel at 0.90),
   * i.e. half the slider bought a tenth of the change. `compositeFade` in treatmentStage.ts
   * is what holds this.
   *
   * Metric: mean luminance over the left sphere's screen box. Each pixel is display-
   * referred, so the mean of a per-pixel mix IS the mix of the means — the box may include
   * background without biasing the fraction. Compared only WITHIN this trio of frames, so
   * the composer path's darker background cancels (see the header note).
   */
  test('a fade at 0.5 reads half way between solid and gone', async ({ page }) => {
    const errs = watchConsole(page)
    const box = async () => page.evaluate(async (url) => {
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
      const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
      let s = 0, n = 0, mx = 0
      for (let y = Math.floor(height * 0.35); y < height * 0.65; y++)
        for (let x = Math.floor(width * 0.25); x < width * 0.45; x++) {
          const l = lum((y * width + x) * 4); s += l; n++; if (l > mx) mx = l
        }
      return { mean: s / n, max: mx }
    }, await snapshot(page))

    const read = async (opacity: number) => {
      await openLab(page, twoSpheres([{ ...FADE, opacity }]))
      const s = await stats(page)
      expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
      expect(s.groups).toBe(1)
      return box()
    }
    const solid = await read(1)
    const half = await read(0.5)
    const gone = await read(0)

    // There IS a range to sit inside — otherwise "half way" is vacuously true.
    expect(solid.mean).toBeGreaterThan(gone.mean + 8)
    const fraction = (half.mean - gone.mean) / (solid.mean - gone.mean)
    const peakFraction = (half.max - gone.max) / (solid.max - gone.max)
    console.log(`[fade] solid=${solid.mean.toFixed(1)} half=${half.mean.toFixed(1)} gone=${gone.mean.toFixed(1)} `
      + `fraction=${fraction.toFixed(3)} peakFraction=${peakFraction.toFixed(3)}`)
    expect(fraction).toBeGreaterThan(0.42)
    expect(fraction).toBeLessThan(0.58)
    // The highlight is where a linear-light blend goes worst wrong (0.90 before the fix).
    expect(peakFraction).toBeLessThan(0.65)
  })

  /**
   * A progressive blur must actually RAMP: at angle 90 (sharp top, blurred bottom) the
   * bottom of the sphere has to be measurably softer than its top -- but the sphere's own
   * specular highlight sits near the top, so the two bands have very different NATURAL
   * detail (measured unblurred: top ~67.05, bottom ~5.17, a 13x gap). A shared absolute
   * floor is therefore the wrong instrument: at angle 270 the bottom band IS the sharp end
   * yet still only scores ~4.2 -- under the floor the top band clears by miles at angle 90
   * -- purely because it started with almost no headroom, not because the ramp is wrong.
   *
   * The fix: score each band's ATTENUATION relative to a control frame that goes through
   * the exact same render path (composer + progressive-blur stage) but ramps to nothing
   * everywhere, via rampStart === rampEnd (a hard edge at ramp=1, so effectively every
   * pixel gets ramp 0 and stays unblurred). That cancels each band's own baseline detail.
   * A plain untreated render would also cancel it, but takes the direct render path
   * instead of the composer path (see the file header on why absolute numbers across
   * paths don't compare) -- so the control has to be a treatment, not an absence of one.
   */
  const CONTROL_BLUR = {
    id: 't-pblur-control', kind: 'blur', enabled: true, invert: false, amount: 1,
    progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 1, rampEnd: 1,
  }

  /** Gradient energy (same measure as `sharpness`) inside a TOP and BOTTOM horizontal
   *  band of the left sphere -- the two bands the progressive-blur tests compare. */
  async function bandEnergy(page: Page, dataUrl: string): Promise<{ top: number; bottom: number }> {
    return page.evaluate(async (url) => {
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
      const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
      const score = (fy0: number, fy1: number) => {
        let s = 0, n = 0
        for (let y = Math.floor(height * fy0); y < height * fy1; y++)
          for (let x = Math.floor(width * 0.25); x < width * 0.45 - 1; x++) {
            const i = (y * width + x) * 4; const d = lum(i) - lum(i + 4); s += d * d; n++
          }
        return s / n
      }
      return { top: score(0.34, 0.44), bottom: score(0.56, 0.66) }
    }, dataUrl)
  }

  test('a progressive blur softens the bottom of the object, not the top', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([CONTROL_BLUR]))
    expect((await stats(page)).frames, `control stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    const control = await bandEnergy(page, await snapshot(page))

    await openLab(page, twoSpheres([{
      id: 't-pblur', kind: 'blur', enabled: true, invert: false, amount: 1,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    }]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const testFrame = await bandEnergy(page, await snapshot(page))

    const attenuation = { top: testFrame.top / control.top, bottom: testFrame.bottom / control.bottom }
    console.log(`[progressive 90] control top=${control.top.toFixed(3)} bottom=${control.bottom.toFixed(3)} | `
      + `test top=${testFrame.top.toFixed(3)} bottom=${testFrame.bottom.toFixed(3)} | `
      + `attenuation top=${attenuation.top.toFixed(3)} bottom=${attenuation.bottom.toFixed(3)}`)
    // The control frame must actually HAVE detail in both bands to attenuate -- scaled per
    // band since they legitimately differ ~13x (top ~67, bottom ~5.2 unblurred).
    expect(control.top).toBeGreaterThan(20)
    expect(control.bottom).toBeGreaterThan(1.5)
    // Angle 90: bottom is the blurred end, top stays sharp. (Measured: bottom=0.040,
    // top=0.294 -- a 0.65 factor still leaves a ~78% margin below the observed ratio.)
    expect(attenuation.bottom).toBeLessThan(attenuation.top * 0.65)
  })

  test('angle 270 flips which end of the object is sharp', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([CONTROL_BLUR]))
    expect((await stats(page)).frames, `control stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    const control = await bandEnergy(page, await snapshot(page))

    await openLab(page, twoSpheres([{
      id: 't-pblur', kind: 'blur', enabled: true, invert: false, amount: 1,
      progressive: true, rampSpace: 'object', rampAngle: 270, rampStart: 0, rampEnd: 1,
    }]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const testFrame = await bandEnergy(page, await snapshot(page))

    const attenuation = { top: testFrame.top / control.top, bottom: testFrame.bottom / control.bottom }
    console.log(`[progressive 270] control top=${control.top.toFixed(3)} bottom=${control.bottom.toFixed(3)} | `
      + `test top=${testFrame.top.toFixed(3)} bottom=${testFrame.bottom.toFixed(3)} | `
      + `attenuation top=${attenuation.top.toFixed(3)} bottom=${attenuation.bottom.toFixed(3)}`)
    expect(control.top).toBeGreaterThan(20)
    expect(control.bottom).toBeGreaterThan(1.5)
    // Angle 270: top is the blurred end, bottom stays sharp -- the reverse of angle 90.
    // (Measured: top=0.046, bottom=0.106 -- a 0.65 factor leaves a ~33% margin, the
    // tightest of the two directions since the ramp's separation is smaller here.)
    expect(attenuation.top).toBeLessThan(attenuation.bottom * 0.65)
  })

  /**
   * The Progressive rows must actually REACH the panel. Everything else about this feature can
   * pass while the switch is invisible: the rows are declared in treatmentControls.ts, the
   * shader reads the uniforms, and the browser tests drive the ramp through a URL state that
   * never opens the inspector. `showIf` in particular is inert unless the panel is handed a
   * `visible` predicate, and a row declared with a gate that nobody evaluates looks correct in
   * every unit test while being permanently hidden — or permanently shown.
   */
  /**
   * The Progressive rows must actually REACH the panel, on EVERY masked kind. Everything else
   * about this feature can pass while a switch is invisible: the rows are declared in
   * treatmentControls.ts, the shaders read the uniforms, and every other browser case drives the
   * ramp through a URL state that never opens the inspector. `showIf` in particular is inert
   * unless the panel is handed a `visible` predicate, and a row declared with a gate nobody
   * evaluates looks correct in every unit test while being permanently hidden — or shown.
   */
  for (const kind of ['blur', 'glow', 'pixelate', 'fade'] as const) {
    test(`Progressive is in the inspector and gates the ramp rows — ${kind}`, async ({ page }) => {
      await openLab(page, twoSpheres())
      const row = page.locator('[data-testid="object-row"][data-object-name="Left"]')
      await row.hover()
      await row.locator('[data-testid="add-treatment"]').click()
      await page.locator(`[data-testid="add-treatment-item"][data-kind="${kind}"]`).click()
      await expect(page.getByTestId('treatment-breadcrumb')).toBeVisible()

      const RAMP_ROWS = ['Measured across', 'Angle', 'Start', 'End']
      await expect(page.getByLabel('Progressive')).toBeVisible()
      for (const label of RAMP_ROWS) {
        await expect(page.getByLabel(label), `${label} must be hidden while Progressive is off on ${kind}`).toHaveCount(0)
      }

      await page.getByLabel('Progressive').click()
      for (const label of RAMP_ROWS) {
        await expect(page.getByLabel(label), `${label} must appear once Progressive is on for ${kind}`).toBeVisible()
      }
      // The switch wrote through to the document, not just to the panel.
      expect(await page.evaluate(() => (window as any).__scene3dDoc().objects[0].treatments[0]))
        .toMatchObject({ kind, progressive: true, rampSpace: 'object', rampAngle: 90 })
    })
  }

  /**
   * Glow and pixelate need DIFFERENT measurements from blur and fade. Gradient energy measures
   * SHARPNESS, which is what blur and fade change. Glow ADDS LIGHT and pixelate FLATTENS BLOCKS
   * while adding hard edges — neither moves gradient energy in a way that discriminates.
   * Measured on this exact scene, a fully-ramped pixelate moved gradient energy only
   * 11.0 → 12.9 (ambiguous) while blockiness moved 0.889 → 0.986 (decisive).
   */
  async function bandMetrics(page: Page): Promise<{
    top: { mean: number; blocky: number }; bottom: { mean: number; blocky: number }
  }> {
    return page.evaluate(async (url) => {
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
      const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
      const band = (fy0: number, fy1: number) => {
        let m = 0, same = 0, n = 0
        for (let y = Math.floor(height * fy0); y < height * fy1; y++)
          for (let x = Math.floor(width * 0.25); x < width * 0.45 - 1; x++) {
            const i = (y * width + x) * 4
            m += lum(i)
            // "Blocky" = identical to the right-hand neighbour. Inside a pixelate block every
            // pair matches; on a smoothly shaded sphere almost none do.
            if (Math.abs(lum(i) - lum(i + 4)) < 0.5) same++
            n++
          }
        return { mean: m / n, blocky: same / n }
      }
      return { top: band(0.34, 0.44), bottom: band(0.56, 0.66) }
    }, await snapshot(page))
  }

  test('a progressive glow follows the ramp, not the object', async ({ page }) => {
    const errs = watchConsole(page)
    const glow = { id: 't-glow', kind: 'glow', enabled: true, invert: false, strength: 3, threshold: 0.2, tint: '#ffffff' }
    const at = async (extra: Record<string, unknown>) => {
      await openLab(page, twoSpheres([{ ...glow, ...extra }]))
      const s = await stats(page)
      expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
      expect(s.groups).toBe(1)
      return (await bandMetrics(page)).top.mean
    }
    const off = await at({ progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 1, rampEnd: 1 })
    const a90 = await at({ progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1 })
    const a270 = await at({ progressive: true, rampSpace: 'object', rampAngle: 270, rampStart: 0, rampEnd: 1 })
    const gain90 = a90 - off, gain270 = a270 - off
    console.log(`[ramp glow] off=${off.toFixed(2)} a90=${a90.toFixed(2)} a270=${a270.toFixed(2)} `
      + `gain90=${gain90.toFixed(2)} gain270=${gain270.toFixed(2)}`)
    // There IS glow to measure when the ramp's full end lands on the lit part…
    expect(gain270).toBeGreaterThan(5)
    // …and turning the ramp around all but removes it from the same band.
    expect(gain270).toBeGreaterThan(gain90 * 3)
  })

  /**
   * Pixelate is measured by BLOCKINESS, not sharpness — see bandMetrics. At angle 90 the ramp's
   * full end is the bottom band, which should end up almost entirely flat runs, while the top
   * band stays close to the un-ramped control.
   */
  test('a progressive pixelate blocks the ramp end and leaves the other alone', async ({ page }) => {
    const errs = watchConsole(page)
    const pix = { id: 't-pix', kind: 'pixelate', enabled: true, invert: false, cellSize: 48 }
    const at = async (extra: Record<string, unknown>) => {
      await openLab(page, twoSpheres([{ ...pix, ...extra }]))
      const s = await stats(page)
      expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
      return bandMetrics(page)
    }
    const off = await at({ progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 1, rampEnd: 1 })
    const on = await at({ progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1 })
    const dBottom = on.bottom.blocky - off.bottom.blocky
    const dTop = on.top.blocky - off.top.blocky
    console.log(`[ramp pixelate] off top=${off.top.blocky.toFixed(3)} bottom=${off.bottom.blocky.toFixed(3)} | `
      + `on top=${on.top.blocky.toFixed(3)} bottom=${on.bottom.blocky.toFixed(3)} | `
      + `dTop=${dTop.toFixed(3)} dBottom=${dBottom.toFixed(3)}`)
    // The far end really does block up…
    expect(on.bottom.blocky).toBeGreaterThan(0.95)
    expect(dBottom).toBeGreaterThan(0.05)
    // …and it blocks up far more than the sharp end does.
    expect(dBottom).toBeGreaterThan(dTop * 2)
  })

  test('a progressive fade sweeps from solid to faded', async ({ page }) => {
    const a = await rampAttenuation(page, {
      id: 't-fade-ramp', kind: 'fade', enabled: true, invert: false, opacity: 0.05,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
    console.log(`[ramp fade] control=${JSON.stringify(a.control)} test=${JSON.stringify(a.test)} `
      + `atten top=${a.top.toFixed(3)} bottom=${a.bottom.toFixed(3)}`)
    expect(a.bottom).toBeLessThan(a.top * 0.65)
  })

  /** The display-blend gate used to read `opacity < 1`. A ramped fade at opacity 1 still varies
   *  per pixel and must take the tone-mapped path; this is the case that would catch it
   *  silently falling back to the linear blend. */
  test('a ramped fade at opacity 1 still ramps', async ({ page }) => {
    const a = await rampAttenuation(page, {
      id: 't-fade-one', kind: 'fade', enabled: true, invert: false, opacity: 1,
      progressive: true, rampSpace: 'object', rampAngle: 90, rampStart: 0, rampEnd: 1,
    })
    console.log(`[ramp fade@1] atten top=${a.top.toFixed(3)} bottom=${a.bottom.toFixed(3)}`)
    // opacity 1 means "fully solid" at every ramp value, so nothing should change — the point is
    // that it does not CRASH or blank, and that both bands stay near their control.
    expect(a.top).toBeGreaterThan(0.8)
    expect(a.bottom).toBeGreaterThan(0.8)
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
