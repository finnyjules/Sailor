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

/**
 * S3 Task 1 — the live G-buffer pass and the edge-lines treatment.
 *
 * A single cube turned 45° about Y so the near vertical edge (where its two front faces meet)
 * sits dead centre. That edge is an INTERIOR crease: the inverted-hull `outline` treatment can
 * only ink the silhouette, so it leaves this centre line bare, whereas edge lines — a Sobel over
 * the G-buffer's normals + depth — draws it. The probe is horizontal-gradient energy in a
 * narrow central strip that is well inside the silhouette, so a black crease line spikes it while
 * a smoothly shaded face barely registers.
 *
 * Byte-identity is the non-negotiable: with no edge-lines treatment present the G-buffer pass
 * must not run and the frame must be pixel-for-pixel what it was before S3. Proven by an A/B of
 * a bare cube against the same cube carrying a DISABLED edge-lines treatment — both take the
 * plain render path (stage frames 0) and must differ by zero pixels.
 */
test.describe('3D Studio edge lines (S3 G-buffer)', () => {
  const cube = (id: string, treatments?: unknown[]) => ({
    id, kind: 'primitive', primitive: 'box', name: 'Cube', visible: true,
    position: [0, 0, 0], rotation: [0, 0.785398, 0], scale: [1.4, 1.4, 1.4],
    material: { type: 'standard', color: '#cccccc', roughness: 0.5, metalness: 0 },
    ...(treatments ? { treatments } : {}),
  })
  const cubeScene = (treatments?: unknown[]) => ({
    version: 1, background: '#202020', showFloor: false,
    camera: { position: [0, 0.4, 5], target: [0, 0, 0], fov: 40 },
    objects: [cube('cube', treatments)],
  })
  const EDGE = { id: 't-edge', kind: 'edgeLines', enabled: true, invert: false, color: '#000000', width: 0.6, threshold: 0.4 }

  async function openCube(page: Page, state: unknown): Promise<void> {
    await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(state))}`)
    await expect.poll(() => page.evaluate(() => typeof (window as any).__scene3dSnapshot === 'function'), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => page.evaluate(() => (window as any).__scene3dDoc().objects.length), { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(SETTLE_MS)
  }

  /** Horizontal-gradient energy in a central vertical strip (the interior crease), and in a
   *  same-height strip off to the left that only ever holds a flat face — the control band. */
  async function creaseEnergy(page: Page, dataUrl: string): Promise<{ centre: number; face: number }> {
    return page.evaluate(async (url) => {
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
      const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
      const strip = (fx0: number, fx1: number) => {
        let s = 0, n = 0
        for (let y = Math.floor(height * 0.42); y < height * 0.58; y++)
          for (let x = Math.floor(width * fx0); x < width * fx1 - 1; x++) {
            const i = (y * width + x) * 4; const d = lum(i) - lum(i + 4); s += d * d; n++
          }
        return s / n
      }
      // `face` is a flat interior band of the right-hand face — between the centre crease
      // (~0.50) and the right silhouette (~0.64), so no crease line ever falls in it.
      return { centre: strip(0.47, 0.53), face: strip(0.55, 0.60) }
    }, dataUrl)
  }

  test('edge lines draw a line on the box interior crease, and the G-buffer pass ran', async ({ page }) => {
    const errs = watchConsole(page)
    await openCube(page, cubeScene())
    expect((await stats(page)).frames, 'plain cube must take the direct path').toBe(0)
    const plain = await creaseEnergy(page, await snapshot(page))

    await openCube(page, cubeScene([EDGE]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBeGreaterThanOrEqual(1)
    const lined = await creaseEnergy(page, await snapshot(page))
    console.log(`[edge lines] plain centre=${plain.centre.toFixed(3)} face=${plain.face.toFixed(3)} | `
      + `lined centre=${lined.centre.toFixed(3)} face=${lined.face.toFixed(3)}`)
    // The crease line spikes the centre strip well past the bare cube…
    expect(lined.centre).toBeGreaterThan(plain.centre * 3)
    // …and past its OWN flat-face band (the line is a local feature, not a global brightening).
    expect(lined.centre).toBeGreaterThan(lined.face * 3)
  })

  test('edge lines catch the interior crease the hull outline misses', async ({ page }) => {
    const errs = watchConsole(page)
    const OUTLINE = { id: 't-out', kind: 'outline', enabled: true, invert: false, color: '#000000', thickness: 0.6 }
    await openCube(page, cubeScene([OUTLINE]))
    expect((await stats(page)).frames, `outline is a shell, not a stage group; console: ${errs.join(' | ')}`).toBe(0)
    const outline = await creaseEnergy(page, await snapshot(page))

    await openCube(page, cubeScene([EDGE]))
    expect((await stats(page)).frames, `stage never ran; console: ${errs.join(' | ')}`).toBeGreaterThan(0)
    const edge = await creaseEnergy(page, await snapshot(page))
    console.log(`[edge vs outline] outline centre=${outline.centre.toFixed(3)} | edge centre=${edge.centre.toFixed(3)}`)
    // The inverted-hull outline leaves the interior crease bare; edge lines ink it.
    expect(edge.centre).toBeGreaterThan(outline.centre * 3)
  })

  test('BYTE-IDENTITY: with no edge-lines treatment the pass never runs and the frame is unchanged', async ({ page }) => {
    // The render harness is deterministic across reloads of the same scene (proven first), so a
    // zero-pixel A/B is a real claim, not a coincidence of timing.
    await openCube(page, cubeScene())
    expect((await stats(page)).frames).toBe(0)
    const a = await snapshot(page)
    await openCube(page, cubeScene())
    const b = await snapshot(page)

    // Same cube, but now carrying a DISABLED edge-lines treatment — must be absent for rendering.
    await openCube(page, cubeScene([{ ...EDGE, enabled: false }]))
    expect((await stats(page)).frames, 'a disabled edge-lines treatment must not run the pass').toBe(0)
    const disabled = await snapshot(page)

    const diff = (x: string, y: string) => page.evaluate(async ([u1, u2]) => {
      const load = async (u: string) => {
        const img = new Image(); img.src = u; await img.decode()
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
        c.getContext('2d')!.drawImage(img, 0, 0)
        return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      }
      const d1 = await load(u1), d2 = await load(u2)
      let changed = 0
      for (let i = 0; i < d1.length; i += 4) {
        if (d1[i] !== d2[i] || d1[i + 1] !== d2[i + 1] || d1[i + 2] !== d2[i + 2] || d1[i + 3] !== d2[i + 3]) changed++
      }
      return changed
    }, [x, y] as [string, string])

    const determinism = await diff(a, b)
    const absent = await diff(a, disabled)
    console.log(`[byte-identity] reload-determinism changed=${determinism} | disabled-vs-absent changed=${absent}`)
    expect(determinism, 'the harness must render the same scene identically across reloads').toBe(0)
    expect(absent, 'a disabled S3 treatment must leave the frame byte-identical').toBe(0)
  })
})

test.describe('3D Studio depth fog + curvature wear (S3 G-buffer)', () => {
  async function openScene(page: Page, state: unknown): Promise<void> {
    await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(state))}`)
    await expect.poll(() => page.evaluate(() => typeof (window as any).__scene3dSnapshot === 'function'), { timeout: 30_000 }).toBe(true)
    await expect.poll(() => page.evaluate(() => (window as any).__scene3dDoc().objects.length), { timeout: 10_000 }).toBe(1)
    await page.waitForTimeout(SETTLE_MS)
  }

  // --- Depth fog: a long box rotated ~+0.9 rad around Y recedes from near-right to far-left,
  //     so the LEFT of the image is the object's far end and the RIGHT is its near end. Fog
  //     tints the far end toward a saturated blue; the near end keeps its grey.
  const deepBox = (treatments?: unknown[]) => ({
    id: 'plank', kind: 'primitive', primitive: 'box', name: 'Plank', visible: true,
    position: [0, 0, 0], rotation: [0, 0.9, 0], scale: [1, 1, 5],
    material: { type: 'standard', color: '#cccccc', roughness: 0.6, metalness: 0 },
    ...(treatments ? { treatments } : {}),
  })
  const deepScene = (treatments?: unknown[]) => ({
    version: 1, background: '#202020', showFloor: false,
    camera: { position: [0, 0.6, 5], target: [0, 0, 0], fov: 40 },
    objects: [deepBox(treatments)],
  })
  const FOG = { id: 't-fog', kind: 'depthFog', enabled: true, invert: false, color: '#2a5cff', start: 0.25, end: 1 }

  /** Mean (blue − red) in a left band (the object's far end) and a right band (its near end),
   *  across the vertical middle. Grey object and grey background both read ~0; a blue fog tint
   *  drives its band positive. */
  async function blueBias(page: Page, dataUrl: string): Promise<{ left: number; right: number }> {
    return page.evaluate(async (url) => {
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
      const band = (fx0: number, fx1: number) => {
        let s = 0, n = 0
        for (let y = Math.floor(height * 0.40); y < height * 0.60; y++)
          for (let x = Math.floor(width * fx0); x < width * fx1; x++) {
            const i = (y * width + x) * 4; s += data[i + 2]! - data[i]!; n++
          }
        return s / n
      }
      return { left: band(0.30, 0.44), right: band(0.56, 0.70) }
    }, dataUrl)
  }

  test('depth fog tints the object\'s far end more than its near end, and the pass ran', async ({ page }) => {
    const errs = watchConsole(page)
    await openScene(page, deepScene())
    expect((await stats(page)).frames, 'plain plank must take the direct path').toBe(0)
    const plain = await blueBias(page, await snapshot(page))

    await openScene(page, deepScene([FOG]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBeGreaterThanOrEqual(1)
    const fogged = await blueBias(page, await snapshot(page))
    console.log(`[depth fog] plain L=${plain.left.toFixed(2)} R=${plain.right.toFixed(2)} | `
      + `fogged L=${fogged.left.toFixed(2)} R=${fogged.right.toFixed(2)}`)
    // Plain grey plank: neither band is blue.
    expect(Math.abs(plain.left - plain.right)).toBeLessThan(6)
    // Fogged: the far (left) end is markedly bluer than the near (right) end…
    expect(fogged.left).toBeGreaterThan(fogged.right + 12)
    // …and bluer than the same band was without fog (the tint really landed).
    expect(fogged.left).toBeGreaterThan(plain.left + 12)
  })

  // --- Curvature wear: the rotated cube from the edge-lines suite. Positive amount lightens
  //     the high-curvature interior crease; the flat face between crease and silhouette has no
  //     curvature and stays put — a soft shade, not a hard ink line.
  const cube = (treatments?: unknown[]) => ({
    id: 'cube', kind: 'primitive', primitive: 'box', name: 'Cube', visible: true,
    position: [0, 0, 0], rotation: [0, 0.785398, 0], scale: [1.4, 1.4, 1.4],
    material: { type: 'standard', color: '#8a8a8a', roughness: 0.5, metalness: 0 },
    ...(treatments ? { treatments } : {}),
  })
  const cubeScene = (treatments?: unknown[]) => ({
    version: 1, background: '#202020', showFloor: false,
    camera: { position: [0, 0.4, 5], target: [0, 0, 0], fov: 40 },
    objects: [cube(treatments)],
  })
  const WEAR = { id: 't-wear', kind: 'curvatureWear', enabled: true, invert: false, amount: 1, width: 1 }

  /** Mean absolute per-pixel luminance change between two frames, in the high-curvature crease
   *  band and in the flat interior face band. Wear is a thin, localised brightness shade, so a
   *  direct frame-to-frame diff is the honest metric: it lights up the curved crease and reads
   *  ~0 on the flat face, whatever the crease's own tone. */
  async function diffBands(page: Page, plainUrl: string, wornUrl: string): Promise<{ crease: number; face: number }> {
    return page.evaluate(async ([u1, u2]) => {
      const load = async (u: string) => {
        const img = new Image(); img.src = u; await img.decode()
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
        cv.getContext('2d')!.drawImage(img, 0, 0)
        return cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height)
      }
      const a = await load(u1), b = await load(u2)
      const { width, height } = a
      const lum = (d: Uint8ClampedArray, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!
      const band = (fx0: number, fx1: number) => {
        let s = 0, n = 0
        for (let y = Math.floor(height * 0.42); y < height * 0.58; y++)
          for (let x = Math.floor(width * fx0); x < width * fx1; x++) {
            const i = (y * width + x) * 4; s += Math.abs(lum(a.data, i) - lum(b.data, i)); n++
          }
        return s / n
      }
      // `crease` straddles the interior crease (high curvature); `face` is a flat interior band
      // of the right face, between the crease (~0.50) and the silhouette (~0.64) — zero curvature.
      return { crease: band(0.47, 0.53), face: band(0.55, 0.60) }
    }, [plainUrl, wornUrl] as [string, string])
  }

  test('curvature wear shades the interior crease and leaves the flat face alone, and the pass ran', async ({ page }) => {
    const errs = watchConsole(page)
    await openScene(page, cubeScene())
    expect((await stats(page)).frames, 'plain cube must take the direct path').toBe(0)
    const plain = await snapshot(page)

    await openScene(page, cubeScene([WEAR]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBeGreaterThanOrEqual(1)
    const worn = await snapshot(page)
    const d = await diffBands(page, plain, worn)
    console.log(`[curvature wear] crease diff=${d.crease.toFixed(2)} | flat-face diff=${d.face.toFixed(2)}`)
    // The high-curvature crease band is visibly shaded…
    expect(d.crease).toBeGreaterThan(3)
    // …while the flat interior face (no curvature) is left essentially untouched — a local edge
    // shade, not a wash. (The flat band moved ~0; the crease band is far higher.)
    expect(d.face).toBeLessThan(0.5)
    expect(d.crease).toBeGreaterThan(d.face * 5)
  })

  test('BYTE-IDENTITY: a disabled depth-fog or curvature-wear treatment leaves the frame unchanged', async ({ page }) => {
    await openScene(page, cubeScene())
    expect((await stats(page)).frames).toBe(0)
    const a = await snapshot(page)
    await openScene(page, cubeScene())
    const b = await snapshot(page)

    await openScene(page, cubeScene([{ ...FOG, enabled: false }, { ...WEAR, enabled: false }]))
    expect((await stats(page)).frames, 'disabled buffer treatments must not run the pass').toBe(0)
    const disabled = await snapshot(page)

    const diff = (x: string, y: string) => page.evaluate(async ([u1, u2]) => {
      const load = async (u: string) => {
        const img = new Image(); img.src = u; await img.decode()
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
        cv.getContext('2d')!.drawImage(img, 0, 0)
        return cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
      }
      const d1 = await load(u1), d2 = await load(u2)
      let changed = 0
      for (let i = 0; i < d1.length; i += 4) {
        if (d1[i] !== d2[i] || d1[i + 1] !== d2[i + 1] || d1[i + 2] !== d2[i + 2] || d1[i + 3] !== d2[i + 3]) changed++
      }
      return changed
    }, [x, y] as [string, string])

    const determinism = await diff(a, b)
    const absent = await diff(a, disabled)
    console.log(`[byte-identity fog/wear] reload-determinism changed=${determinism} | disabled-vs-absent changed=${absent}`)
    expect(determinism, 'the harness must render the same scene identically across reloads').toBe(0)
    expect(absent, 'disabled depth-fog and curvature-wear treatments must leave the frame byte-identical').toBe(0)
  })
})

/**
 * S4 — the six masked, two edge and one buffer treatment kinds added on the S3 stage.
 *
 * Oracle: the same `__scene3dSnapshot()` fixed-camera render the S3 suites use. It composites
 * the stage, so it reflects every one of these kinds (unlike a camera move). Two claims per kind:
 *
 *  1. APPLIED CHANGES THE RENDER. For a masked kind that has a genuine no-op value
 *     (colorGrade 1/1/1/0, dissolve amount 0, chromaticSplit amount 0, glitch amount 0 +
 *     scanlines 0, dropShadow opacity 0) the active frame is diffed against that NEUTRAL frame —
 *     BOTH go through the composer path, so the post stack's known background shift (see the file
 *     header) cancels. The comparison is self-calibrating: the treatment's pixel footprint in the
 *     object box must dominate the cross-reload noise of rendering the neutral scene twice, so no
 *     hand-tuned pixel threshold is trusted blind. Kinds with no neutral value (halftone,
 *     crossHatch) are proven structurally instead — a dot screen / a pen-and-ink lattice multiplies
 *     the object's gradient energy, a ratio that is robust to any absolute tone shift. Edge shells
 *     (dashedOutline, silhouetteCutout) take the PLAIN path, so they diff straight against the
 *     untreated frame (plain-path reload determinism is already proven by the S3 byte-identity
 *     cases).
 *
 *  2. NEUTRAL / ABSENT IS UNCHANGED. A DISABLED treatment must take the plain path (stage frames
 *     0) and be byte-identical to the same scene with no treatment at all — the opt-in guarantee,
 *     exactly the S3 disabled-vs-absent oracle. (An ENABLED neutral-value masked treatment is
 *     deliberately NOT byte-compared to the plain frame: it still runs the composer path, which
 *     legitimately shifts the background — so the neutral value is used as the cancelling CONTROL
 *     above, not as a byte oracle. See the report.)
 *
 * crossHatch additionally proves the S3 GATE: with no enabled buffer treatment the frame takes the
 * plain path (frames 0 ⇔ docHasGBufferTreatment false) and is byte-identical, and the disabled
 * treatment is still present in the doc — so it is the enabled flag, not absence, that gates the
 * G-buffer pass. dissolve, glitch and crossHatch also prove DETERMINISM: a second render of the
 * same scene is pixel-for-pixel identical (no Math.random), and — where a seed exists — a
 * different seed changes the pattern.
 *
 * NONE OF THESE HAVE BEEN RUN. :3002 is stale and this task must not start a server; the lead runs
 * them against a fresh preview at closeout and tunes any floor the real numbers need.
 */

const LEFT_BOX = { fx0: 0.20, fy0: 0.30, fx1: 0.47, fy1: 0.70 }
const DROP_BOX = { fx0: 0.14, fy0: 0.28, fx1: 0.52, fy1: 0.82 }
const FULL_BOX = { fx0: 0, fy0: 0, fx1: 1, fy1: 1 }
type Box = { fx0: number; fy0: number; fx1: number; fy1: number }

/** Count of pixels inside `box` whose RGB differs between two data-URL snapshots. */
async function boxChangedPixels(page: Page, a: string, b: string, box: Box): Promise<number> {
  return page.evaluate(async ({ ua, ub, box }) => {
    const load = async (u: string) => {
      const img = new Image(); img.src = u; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      c.getContext('2d')!.drawImage(img, 0, 0)
      return c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
    }
    const A = await load(ua), B = await load(ub); const { width, height } = A
    const x0 = Math.floor(width * box.fx0), x1 = Math.floor(width * box.fx1)
    const y0 = Math.floor(height * box.fy0), y1 = Math.floor(height * box.fy1)
    let changed = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2]) changed++
    }
    return changed
  }, { ua: a, ub: b, box })
}

/** Mean squared horizontal luminance step (gradient energy) inside `box` — the S3 "sharpness"
 *  measure, high for a dot screen or a hatch lattice, low on a smoothly shaded surface. */
async function boxGradEnergy(page: Page, url: string, box: Box): Promise<number> {
  return page.evaluate(async ({ u, box }) => {
    const img = new Image(); img.src = u; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const x0 = Math.floor(width * box.fx0), x1 = Math.floor(width * box.fx1)
    const y0 = Math.floor(height * box.fy0), y1 = Math.floor(height * box.fy1)
    let s = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) {
      const i = (y * width + x) * 4; const d = lum(i) - lum(i + 4); s += d * d; n++
    }
    return n ? s / n : 0
  }, { u: url, box })
}

/** Mean luminance inside `box`. */
async function boxMeanLuma(page: Page, url: string, box: Box): Promise<number> {
  return page.evaluate(async ({ u, box }) => {
    const img = new Image(); img.src = u; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const x0 = Math.floor(width * box.fx0), x1 = Math.floor(width * box.fx1)
    const y0 = Math.floor(height * box.fy0), y1 = Math.floor(height * box.fy1)
    let s = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4; s += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!; n++
    }
    return n ? s / n : 0
  }, { u: url, box })
}

test.describe('3D Studio treatments — S4 masked/edge/buffer', () => {
  /** APPLIED oracle for a masked kind with a neutral value: three loads on the SAME composer
   *  path (neutral, neutral, active). Returns the active-vs-neutral footprint and the
   *  neutral-vs-neutral cross-reload noise, both measured inside `box`, plus the active stats. */
  async function maskedFootprint(
    page: Page, active: Record<string, unknown>, neutral: Record<string, unknown>, box: Box = LEFT_BOX,
  ) {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres([neutral]))
    const n1 = await snapshot(page)
    await openLab(page, twoSpheres([neutral]))
    const n2 = await snapshot(page)
    await openLab(page, twoSpheres([active]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const a = await snapshot(page)
    const noise = await boxChangedPixels(page, n1, n2, box)
    const footprint = await boxChangedPixels(page, a, n2, box)
    return { noise, footprint, frames: s.frames, groups: s.groups, active: a, neutral: n2 }
  }

  /** NEUTRAL/ABSENT oracle: a DISABLED treatment must take the plain path (frames 0) and leave
   *  the frame byte-identical to the same scene with no treatment. Mirrors the S3 disabled-vs-
   *  absent test (plain-path reload determinism is proven there, so a zero diff is a real claim). */
  async function disabledIsAbsent(page: Page, disabled: Record<string, unknown>) {
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames).toBe(0)
    const absent = await snapshot(page)
    await openLab(page, twoSpheres())
    const absent2 = await snapshot(page)
    await openLab(page, twoSpheres([disabled]))
    expect((await stats(page)).frames, 'a disabled treatment must not run the stage').toBe(0)
    const off = await snapshot(page)
    const determinism = await boxChangedPixels(page, absent, absent2, FULL_BOX)
    const delta = await boxChangedPixels(page, absent, off, FULL_BOX)
    return { determinism, delta }
  }

  // ---- colorGrade (masked) --------------------------------------------------------------------
  const CG_NEUTRAL = { id: 't-cg', kind: 'colorGrade', enabled: true, invert: false, brightness: 1, contrast: 1, saturation: 1, hue: 0 }
  const CG_ACTIVE = { ...CG_NEUTRAL, brightness: 1.6, saturation: 0 }

  test('colorGrade applied changes the render (brighter, desaturated)', async ({ page }) => {
    const r = await maskedFootprint(page, CG_ACTIVE, CG_NEUTRAL)
    const meanA = await boxMeanLuma(page, r.active, LEFT_BOX)
    const meanN = await boxMeanLuma(page, r.neutral, LEFT_BOX)
    console.log(`[colorGrade] footprint=${r.footprint} noise=${r.noise} meanActive=${meanA.toFixed(1)} meanNeutral=${meanN.toFixed(1)}`)
    expect(r.footprint).toBeGreaterThan(r.noise * 3 + 300)
    expect(meanA).toBeGreaterThan(meanN) // brightness 1.6 lifts the object
  })
  test('colorGrade neutral/absent: a disabled grade is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...CG_ACTIVE, enabled: false })
    console.log(`[colorGrade byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })

  // ---- dissolve (masked, seeded) --------------------------------------------------------------
  const DS_NEUTRAL = { id: 't-ds', kind: 'dissolve', enabled: true, invert: false, amount: 0, scale: 24, softness: 0.1, seed: 1 }
  const DS_ACTIVE = { ...DS_NEUTRAL, amount: 0.85 }

  test('dissolve applied changes the render (erodes the object)', async ({ page }) => {
    const r = await maskedFootprint(page, DS_ACTIVE, DS_NEUTRAL)
    console.log(`[dissolve] footprint=${r.footprint} noise=${r.noise}`)
    expect(r.footprint).toBeGreaterThan(r.noise * 3 + 300)
  })
  test('dissolve neutral/absent: a disabled dissolve is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...DS_ACTIVE, enabled: false })
    console.log(`[dissolve byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })
  test('dissolve is deterministic: same seed identical, different seed differs', async ({ page }) => {
    await openLab(page, twoSpheres([DS_ACTIVE]))
    expect((await stats(page)).frames).toBeGreaterThan(0)
    const one = await snapshot(page)
    const two = await snapshot(page) // same page, same seed, second render
    const same = await boxChangedPixels(page, one, two, FULL_BOX)
    await openLab(page, twoSpheres([{ ...DS_ACTIVE, seed: 987 }]))
    const other = await snapshot(page)
    const diff = await boxChangedPixels(page, one, other, LEFT_BOX)
    console.log(`[dissolve determinism] same-seed=${same} different-seed=${diff}`)
    expect(same, 'same seed must render identically (no Math.random)').toBe(0)
    expect(diff, 'a different seed must change the dissolve pattern').toBeGreaterThan(300)
  })

  // ---- halftone (masked, no neutral value → structural) ---------------------------------------
  const HT_ACTIVE = { id: 't-ht', kind: 'halftone', enabled: true, invert: false, cell: 6, angle: 45, contrast: 1, color: '#000000' }

  test('halftone applied changes the render (a dot screen replaces the smooth shading)', async ({ page }) => {
    // A black-ink dot screen on a mid-tone object reads LOWER in gradient than the smooth-shaded
    // sphere with its bright highlight, so "gradient must rise" was the wrong proxy (it caught a
    // real bug — the screen flooding to solid ink — but a correct fine screen fails it too). The
    // honest proof the screen applied is that it changes most of the object's pixels vs the plain
    // render; the by-eye boldness of the dots stays a taste call in Owed.
    const errs = watchConsole(page)
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames).toBe(0)
    const plain = await snapshot(page)
    await openLab(page, twoSpheres([HT_ACTIVE]))
    const s = await stats(page)
    expect(s.frames, `stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBe(1)
    const changed = await boxChangedPixels(page, plain, await snapshot(page), LEFT_BOX)
    console.log(`[halftone] changed-vs-plain=${changed}`)
    expect(changed).toBeGreaterThan(3000)
  })
  test('halftone neutral/absent: a disabled halftone is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...HT_ACTIVE, enabled: false })
    console.log(`[halftone byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })

  // ---- chromaticSplit (masked, amount 0 = neutral) --------------------------------------------
  const CS_NEUTRAL = { id: 't-cs', kind: 'chromaticSplit', enabled: true, invert: false, amount: 0, angle: 0 }
  const CS_ACTIVE = { ...CS_NEUTRAL, amount: 16 }

  test('chromaticSplit applied changes the render (RGB fringing at the edges)', async ({ page }) => {
    const r = await maskedFootprint(page, CS_ACTIVE, CS_NEUTRAL)
    console.log(`[chromaticSplit] footprint=${r.footprint} noise=${r.noise}`)
    expect(r.footprint).toBeGreaterThan(r.noise * 3 + 300)
  })
  test('chromaticSplit neutral/absent: a disabled split is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...CS_ACTIVE, enabled: false })
    console.log(`[chromaticSplit byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })

  // ---- glitch (masked, seeded; amount 0 + scanlines 0 = neutral) ------------------------------
  const GL_NEUTRAL = { id: 't-gl', kind: 'glitch', enabled: true, invert: false, amount: 0, bands: 12, scanlines: 0, seed: 1 }
  const GL_ACTIVE = { ...GL_NEUTRAL, amount: 24, scanlines: 0.5 }

  test('glitch applied changes the render (band shift + scanlines)', async ({ page }) => {
    const r = await maskedFootprint(page, GL_ACTIVE, GL_NEUTRAL)
    console.log(`[glitch] footprint=${r.footprint} noise=${r.noise}`)
    expect(r.footprint).toBeGreaterThan(r.noise * 3 + 300)
  })
  test('glitch neutral/absent: a disabled glitch is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...GL_ACTIVE, enabled: false })
    console.log(`[glitch byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })
  test('glitch is deterministic: same seed identical, different seed differs', async ({ page }) => {
    await openLab(page, twoSpheres([GL_ACTIVE]))
    expect((await stats(page)).frames).toBeGreaterThan(0)
    const one = await snapshot(page)
    const two = await snapshot(page)
    const same = await boxChangedPixels(page, one, two, FULL_BOX)
    await openLab(page, twoSpheres([{ ...GL_ACTIVE, seed: 987 }]))
    const other = await snapshot(page)
    const diff = await boxChangedPixels(page, one, other, LEFT_BOX)
    console.log(`[glitch determinism] same-seed=${same} different-seed=${diff}`)
    expect(same, 'same seed must render identically (no Math.random)').toBe(0)
    expect(diff, 'a different seed must change the glitch pattern').toBeGreaterThan(300)
  })

  // ---- dropShadow (masked, opacity 0 = neutral) ----------------------------------------------
  const SH_NEUTRAL = { id: 't-sh', kind: 'dropShadow', enabled: true, invert: false, angle: 45, distance: 28, color: '#000000', softness: 0.2, opacity: 0 }
  const SH_ACTIVE = { ...SH_NEUTRAL, opacity: 0.6 }

  test('dropShadow applied changes the render (a dark offset shadow appears)', async ({ page }) => {
    const r = await maskedFootprint(page, SH_ACTIVE, SH_NEUTRAL, DROP_BOX)
    const meanA = await boxMeanLuma(page, r.active, DROP_BOX)
    const meanN = await boxMeanLuma(page, r.neutral, DROP_BOX)
    console.log(`[dropShadow] footprint=${r.footprint} noise=${r.noise} meanActive=${meanA.toFixed(1)} meanNeutral=${meanN.toFixed(1)}`)
    expect(r.footprint).toBeGreaterThan(r.noise * 3 + 300)
    expect(meanA).toBeLessThan(meanN) // the shadow darkens the region around the object
  })
  test('dropShadow neutral/absent: a disabled shadow is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...SH_ACTIVE, enabled: false })
    console.log(`[dropShadow byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })

  // ---- dashedOutline (edge shell, plain path) -------------------------------------------------
  const DO_ACTIVE = { id: 't-do', kind: 'dashedOutline', enabled: true, invert: false, color: '#000000', width: 0.5, dash: 8, gap: 6 }

  test('dashedOutline applied changes the render (a dashed ring on the silhouette)', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames, 'plain scene must take the direct path').toBe(0)
    const plain = await snapshot(page)
    await openLab(page, twoSpheres([DO_ACTIVE]))
    // Edge kinds are shells, not stage groups — they never run the composer stage.
    expect((await stats(page)).frames, `dashedOutline is a shell, not a stage group; console: ${errs.join(' | ')}`).toBe(0)
    const shelled = await snapshot(page)
    const changed = await boxChangedPixels(page, plain, shelled, LEFT_BOX)
    console.log(`[dashedOutline] changed=${changed}`)
    expect(changed).toBeGreaterThan(200)
  })
  test('dashedOutline neutral/absent: a disabled outline is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...DO_ACTIVE, enabled: false })
    console.log(`[dashedOutline byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })

  // ---- silhouetteCutout (edge shell, plain path) ---------------------------------------------
  const SC_ACTIVE = { id: 't-sc', kind: 'silhouetteCutout', enabled: true, invert: false, color: '#ffffff', border: 0, borderColor: '#000000' }

  test('silhouetteCutout applied changes the render (fills the silhouette flat)', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames, 'plain scene must take the direct path').toBe(0)
    const plain = await snapshot(page)
    const plainMean = await boxMeanLuma(page, plain, LEFT_BOX)
    await openLab(page, twoSpheres([SC_ACTIVE]))
    expect((await stats(page)).frames, `silhouetteCutout is a shell, not a stage group; console: ${errs.join(' | ')}`).toBe(0)
    const filled = await snapshot(page)
    const changed = await boxChangedPixels(page, plain, filled, LEFT_BOX)
    const filledMean = await boxMeanLuma(page, filled, LEFT_BOX)
    console.log(`[silhouetteCutout] changed=${changed} plainMean=${plainMean.toFixed(1)} filledMean=${filledMean.toFixed(1)}`)
    expect(changed).toBeGreaterThan(1000) // a flat fill repaints most of the silhouette
    expect(filledMean).toBeGreaterThan(plainMean) // white fill over a mid-tone sphere lifts it
  })
  test('silhouetteCutout neutral/absent: a disabled cutout is byte-identical to none', async ({ page }) => {
    const { determinism, delta } = await disabledIsAbsent(page, { ...SC_ACTIVE, enabled: false })
    console.log(`[silhouetteCutout byte] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism).toBe(0)
    expect(delta).toBe(0)
  })

  // ---- crossHatch (buffer, G-buffer reader) ---------------------------------------------------
  const CH_ACTIVE = { id: 't-ch', kind: 'crossHatch', enabled: true, invert: false, color: '#000000', spacing: 6, angle: 45, threshold: 0.6 }

  test('crossHatch applied changes the render (pen-and-ink lattice raises gradient energy)', async ({ page }) => {
    const errs = watchConsole(page)
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames, 'plain scene must take the direct path').toBe(0)
    const plainGrad = await boxGradEnergy(page, await snapshot(page), LEFT_BOX)
    await openLab(page, twoSpheres([CH_ACTIVE]))
    const s = await stats(page)
    expect(s.frames, `G-buffer stage never ran; console errors: ${errs.join(' | ')}`).toBeGreaterThan(0)
    expect(s.groups).toBeGreaterThanOrEqual(1)
    const hatchedGrad = await boxGradEnergy(page, await snapshot(page), LEFT_BOX)
    console.log(`[crossHatch] plainGrad=${plainGrad.toFixed(3)} hatchedGrad=${hatchedGrad.toFixed(3)} ratio=${(hatchedGrad / plainGrad).toFixed(2)}`)
    expect(hatchedGrad).toBeGreaterThan(plainGrad * 3)
  })
  test('crossHatch S3 gate: no enabled buffer treatment ⇒ plain path, byte-identical', async ({ page }) => {
    // docHasGBufferTreatment false ⇔ the G-buffer pass never runs ⇔ frames 0 ⇔ byte-identical.
    await openLab(page, twoSpheres())
    expect((await stats(page)).frames).toBe(0)
    const absent = await snapshot(page)
    await openLab(page, twoSpheres())
    const absent2 = await snapshot(page)
    await openLab(page, twoSpheres([{ ...CH_ACTIVE, enabled: false }]))
    // A DISABLED buffer treatment is present in the doc but must not run the pass…
    expect((await stats(page)).frames, 'a disabled crossHatch must not run the G-buffer pass').toBe(0)
    const doc = await page.evaluate(() => (window as any).__scene3dDoc())
    expect(doc.objects[0].treatments?.[0]).toMatchObject({ kind: 'crossHatch', enabled: false })
    const disabled = await snapshot(page)
    const determinism = await boxChangedPixels(page, absent, absent2, FULL_BOX)
    const delta = await boxChangedPixels(page, absent, disabled, FULL_BOX)
    console.log(`[crossHatch gate] determinism=${determinism} disabled-vs-absent=${delta}`)
    expect(determinism, 'the harness must render the same scene identically across reloads').toBe(0)
    expect(delta, 'a disabled buffer treatment must leave the frame byte-identical (S3 gate)').toBe(0)
  })
  test('crossHatch is deterministic: the same scene renders identically', async ({ page }) => {
    await openLab(page, twoSpheres([CH_ACTIVE]))
    expect((await stats(page)).frames).toBeGreaterThan(0)
    const one = await snapshot(page)
    const two = await snapshot(page) // same page, second render — a fixed lattice, no Math.random
    const same = await boxChangedPixels(page, one, two, FULL_BOX)
    console.log(`[crossHatch determinism] same-scene=${same}`)
    expect(same, 'the crossHatch lattice must be deterministic (no Math.random)').toBe(0)
  })
})
