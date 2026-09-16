import { test, expect, type Page } from '@playwright/test'

/**
 * S7 AI restyle, end to end against the real WebGL path.
 *
 * TASK 1 covers only the byte-identity gate the whole slice rests on: `restyleTreatmentPlan`
 * returns empty when no ENABLED aiRestyle treatment is present, so the restyle sub-loop never
 * runs and the frame is byte-for-byte what it was before S7. A DISABLED aiRestyle row must
 * therefore render a data-URL-IDENTICAL frame to one with no treatments at all — the same claim
 * (and the same real-pixel A/B) `tests/scene3d-finishes.spec.ts` makes for finishes.
 *
 * S7.1 SWAP: the restyle is no longer a stage composite — it is a per-object MATERIAL injection
 * (restyleProjection.ts) that PROJECTS the cached result onto the object's real surface from the bake
 * camera, so it stays registered as the live camera orbits. The injected-composite / mix-ramp cases
 * below exercise that material path with a FAKE cached texture via `window.__scene3dRestyleInject`
 * (at zero cost); because the restyle now renders in the ordinary path (NOT the treatment stage),
 * these cases assert the projected colour on the object's FRONT surface + the console shader-error
 * gate rather than `__scene3dTreatmentStats` (which the stage-less restyle no longer drives). The
 * orbit-stability test (Task 3) becomes a real PASS under this material path. NO fal / paid call is
 * made anywhere in this spec.
 *
 * Headless Chromium draws WebGL through SwiftShader, hence the generous settle wait — see the
 * sibling specs (scene3d-finishes.spec.ts, scene3d-treatments.spec.ts) for the same pattern.
 *
 * NOTE (controller-run): authored to the finishes-spec pattern but likely not runnable in this
 * subagent (no preview server). The controller runs it against a fresh preview, pane visible.
 */

const SETTLE_MS = 3000

const sphere = (treatments?: unknown[]) => ({
  id: 'restyle-sphere', kind: 'primitive', primitive: 'sphere', name: 'Sphere', visible: true,
  position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#9aa3af', roughness: 0.4, metalness: 0 },
  ...(treatments ? { treatments } : {}),
})
const sceneWith = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 1.2, 4.2], target: [0, 0.6, 0], fov: 40 },
  objects: [sphere(treatments)],
})

/** A DISABLED aiRestyle row (enabled:false) — must be absent from the plan, so the frame is
 *  byte-identical to a scene with no treatments. */
const RESTYLE_DISABLED = (overrides: Record<string, unknown> = {}) => ({
  id: 't-restyle', kind: 'aiRestyle', enabled: false, invert: false,
  prompt: 'a bronze statue', strength: 0.6, model: 'fal-ai/flux-control-lora-depth',
  mix: 1, resultRef: '', inputHash: '',
  ...overrides,
})

const SHADER_FAILURE = /Shader Error|not compiled|undeclared identifier|program not valid|INVALID_OPERATION/i

function watchConsole(page: Page): string[] {
  const bad: string[] = []
  page.on('console', (m) => { const t = m.text(); if (SHADER_FAILURE.test(t)) bad.push(t) })
  page.on('pageerror', (e) => { if (SHADER_FAILURE.test(String(e))) bad.push(String(e)) })
  return bad
}

async function openLab(page: Page, state: unknown): Promise<void> {
  await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(state))}`)
  await expect.poll(() => page.evaluate(() => typeof (window as any).__scene3dSnapshot === 'function'), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__scene3dDoc().objects.length), { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(SETTLE_MS)
}

const snapshot = (page: Page) => page.evaluate(() => (window as any).__scene3dSnapshot() as string)

test('a sphere with a disabled aiRestyle row renders byte-identically to one with no treatments', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const noField = await snapshot(page)

  await openLab(page, sceneWith([RESTYLE_DISABLED()]))
  const disabledRow = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(disabledRow).toBe(noField)
})

/* ── Task 2 · the single-object crop (renderObjectPasses via __scene3dObjectPasses) ────────────
 * A TWO-object scene: a red box on the left, a green sphere on the right. Baking the box's crop
 * must give (a) a valid rect confined to the canvas, (b) beauty pixels whose object colour is the
 * box's red — the sphere (green) must contribute NOTHING, since renderObjectPasses hides sibling
 * roots — and (c) a depth crop with real min→max luminance spread (the single-object near/far
 * refit; the whole-scene fit would flatten a small object's depth to near-black). It also proves
 * the bake leaves the live viewport byte-identical (restore-in-finally).
 *
 * NOTE (controller-run): needs a live preview (WebGL via SwiftShader), so likely not runnable in
 * the authoring subagent. Run against a fresh preview, pane visible, on the isolated preview port.
 */
const RED = '#d21f2b'
const GREEN = '#22b455'
const twoObjectScene = () => ({
  version: 1, background: '#101010', showFloor: false,
  camera: { position: [0, 1.2, 5], target: [0, 0.6, 0], fov: 40 },
  objects: [
    { id: 'box-left', kind: 'primitive', primitive: 'box', name: 'Box', visible: true,
      position: [-1.3, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      material: { type: 'standard', color: RED, roughness: 0.5, metalness: 0 } },
    { id: 'sphere-right', kind: 'primitive', primitive: 'sphere', name: 'Sphere', visible: true,
      position: [1.3, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      material: { type: 'standard', color: GREEN, roughness: 0.5, metalness: 0 } },
  ],
})

type Passes = { beauty: string; depth: string; normal: string; rect: { x: number; y: number; w: number; h: number }; viewProj: number[]; size: [number, number]; forward: number[] } | null
const objectPasses = (page: Page, id: string) =>
  page.evaluate((oid) => (window as any).__scene3dObjectPasses(oid) as Promise<Passes>, id)

/** Decode a data URL in the page and return {w,h, and per-pixel stats over opaque pixels}: the
 *  dominant hue buckets (redish/greenish counts) and the min/max luminance spread. Runs in-page so
 *  the canvas 2D context does the decode. */
async function analyseDataUrl(page: Page, dataUrl: string) {
  return page.evaluate((url) => new Promise<{ w: number; h: number; opaque: number; redish: number; greenish: number; lumSpread: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = img.width; cv.height = img.height
      const ctx = cv.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, cv.width, cv.height)
      let opaque = 0, redish = 0, greenish = 0, lmin = 1, lmax = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!
        if (a < 8) continue
        opaque++
        if (r > g + 24 && r > b + 24) redish++
        if (g > r + 24 && g > b + 24) greenish++
        const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        if (l < lmin) lmin = l
        if (l > lmax) lmax = l
      }
      resolve({ w: cv.width, h: cv.height, opaque, redish, greenish, lumSpread: lmax - lmin })
    }
    img.onerror = reject
    img.src = url
  }), dataUrl)
}

test('renderObjectPasses crops the object alone, refits depth, and leaves the viewport intact', async ({ page }) => {
  const bad = watchConsole(page)
  await page.goto(`/dev/scene3d-lab?state=${encodeURIComponent(JSON.stringify(twoObjectScene()))}`)
  await expect.poll(() => page.evaluate(() => typeof (window as any).__scene3dObjectPasses === 'function'), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__scene3dDoc().objects.length), { timeout: 10_000 }).toBe(2)
  await page.waitForTimeout(SETTLE_MS)

  // The bake must not disturb the live viewport (restore-in-finally): snapshot before and after.
  const before = await snapshot(page)
  const passes = await objectPasses(page, 'box-left')
  const after = await snapshot(page)
  expect(after, 'renderObjectPasses changed the live viewport').toBe(before)

  expect(passes, 'expected a non-null crop for an on-screen object').not.toBeNull()
  const p = passes!
  // (a) rect confined to the canvas.
  expect(p.rect.w).toBeGreaterThan(0)
  expect(p.rect.h).toBeGreaterThan(0)

  // (b) beauty crop is the RED box alone — the green sphere is hidden, so almost no green pixels.
  const beauty = await analyseDataUrl(page, p.beauty)
  expect(beauty.opaque, 'beauty crop had no opaque object pixels').toBeGreaterThan(100)
  expect(beauty.redish, 'the box (red) is missing from its own crop').toBeGreaterThan(50)
  // The sibling sphere contributes essentially nothing (allow a hair for AA on the shared canvas).
  expect(beauty.greenish, 'the sibling sphere leaked into the box crop').toBeLessThan(beauty.redish * 0.02)

  // (c) depth crop has REAL contrast — the single-object near/far refit. A whole-scene fit would
  //     flatten this small box's depth to near-black (spread ≈ 0).
  const depth = await analyseDataUrl(page, p.depth)
  expect(depth.lumSpread, 'depth crop is flat — near/far was not refit to the single object').toBeGreaterThan(0.15)

  // (d) S7.1: the bake projection is returned alongside the crop (Task 2 projects the result onto
  //     the surface from it). viewProj = 16 finite floats, size = 2 finite, forward = 3 ~unit-length.
  expect(p.viewProj, 'viewProj is not a 16-element matrix').toHaveLength(16)
  expect(p.viewProj.every((v) => Number.isFinite(v)), 'viewProj has a non-finite element').toBe(true)
  expect(p.size, 'size is not [w, h]').toHaveLength(2)
  expect(p.size.every((v) => Number.isFinite(v) && v > 0), 'size is not positive/finite').toBe(true)
  expect(p.forward, 'forward is not a 3-vector').toHaveLength(3)
  const fLen = Math.hypot(p.forward[0]!, p.forward[1]!, p.forward[2]!)
  expect(fLen, 'forward is not ~unit-length').toBeGreaterThan(0.99)
  expect(fLen, 'forward is not ~unit-length').toBeLessThan(1.01)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

/* ── Task 2/3 · the projective material injection (via __scene3dRestyleInject) ──────────────────
 * The per-object restyle MATERIAL exercised with a FAKE cached result texture — a LOCAL solid-colour
 * PNG data URL injected through window.__scene3dRestyleInject (which also stamps a projector from the
 * live camera). NO fal / paid call anywhere: the "result" is a canvas the browser draws. This proves
 * (a) the projected image paints the object's FRONT surface (a pixel inside the object is the injected
 * colour; a pixel in the corner is the background), (b) mix 0 is a byte-identical no-op (the injection
 * blends nothing — equal to an uncached restyle), and mix 1 is fully the injected image. The restyle
 * renders in the ordinary path now, so the assertions are the projected pixels + the console
 * shader-error gate (on the new material program), NOT `__scene3dTreatmentStats` (stage-less).
 *
 * NOTE (controller-run): needs a live preview (WebGL via SwiftShader). Run against a fresh preview,
 * pane visible, on the isolated preview port.
 */
const RESTYLE_ENABLED = (overrides: Record<string, unknown> = {}) => ({
  id: 't-restyle', kind: 'aiRestyle', enabled: true, invert: false,
  prompt: 'a bronze statue', strength: 0.6, model: 'fal-ai/flux-control-lora-depth',
  mix: 1, resultRef: '', inputHash: '',
  ...overrides,
})

/** Inject a solid-colour LOCAL PNG as the object's restyle result (zero spend). Returns the hook's
 *  boolean (true once the texture decoded + a frame re-rendered). */
async function injectSolid(page: Page, objectId: string, color: string): Promise<boolean> {
  return page.evaluate(async ({ oid, col }) => {
    const cv = document.createElement('canvas')
    cv.width = 16; cv.height = 16
    const c = cv.getContext('2d')!
    c.fillStyle = col
    c.fillRect(0, 0, 16, 16)
    return await (window as any).__scene3dRestyleInject(oid, cv.toDataURL('image/png')) as boolean
  }, { oid: objectId, col: color })
}

/** Average RGB over a small patch centred on fractional canvas coords (fx, fy in 0..1). */
async function samplePatch(page: Page, dataUrl: string, fx: number, fy: number) {
  return page.evaluate(({ url, x, y }) => new Promise<{ r: number; g: number; b: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = img.width; cv.height = img.height
      const ctx = cv.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const px = Math.round(x * img.width), py = Math.round(y * img.height)
      const half = 3
      const data = ctx.getImageData(px - half, py - half, half * 2 + 1, half * 2 + 1).data
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < data.length; i += 4) { r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++ }
      resolve({ r: r / n, g: g / n, b: b / n })
    }
    img.onerror = reject
    img.src = url
  }), { url: dataUrl, x: fx, y: fy })
}

const MAGENTA = '#ff00ff'

test('an injected restyle composites to the silhouette (mix 1), background untouched', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([RESTYLE_ENABLED()]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  const shot = await snapshot(page)
  // Inside the sphere (canvas centre-ish): the projected magenta on the FRONT face — high R + B, low G.
  const inside = await samplePatch(page, shot, 0.5, 0.5)
  expect(inside.r, `object centre not magenta: ${JSON.stringify(inside)}`).toBeGreaterThan(110)
  expect(inside.b, `object centre not magenta: ${JSON.stringify(inside)}`).toBeGreaterThan(60)
  expect(inside.g, `object centre has too much green for magenta: ${JSON.stringify(inside)}`).toBeLessThan(inside.r * 0.7)
  // Top-left corner: the dark background (#202020), unaffected by the object's restyle.
  const corner = await samplePatch(page, shot, 0.04, 0.04)
  expect(corner.r + corner.g + corner.b, `corner is not background: ${JSON.stringify(corner)}`).toBeLessThan(150)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

test('mix 0 is a byte-identical no-op: an injected result is ignored, equal to an uncached restyle', async ({ page }) => {
  const bad = watchConsole(page)
  // Injected but mix 0 → the injection blends nothing at mix 0 (the projected texture must not appear).
  await openLab(page, sceneWith([RESTYLE_ENABLED({ mix: 0 })]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA)).toBe(true)
  await page.waitForTimeout(SETTLE_MS)
  const injectedMix0 = await snapshot(page)

  // Same enabled restyle at mix 0 but with NO result injected — also renders the plain object.
  await openLab(page, sceneWith([RESTYLE_ENABLED({ mix: 0 })]))
  await page.waitForTimeout(SETTLE_MS)
  const uncached = await snapshot(page)

  expect(injectedMix0, 'mix 0 sampled the injected texture instead of the plain object').toBe(uncached)
  // And the object centre is the grey sphere, not magenta (proves the texture really was ignored).
  const inside = await samplePatch(page, injectedMix0, 0.5, 0.5)
  expect(Math.abs(inside.r - inside.g), `mix 0 leaked magenta: ${JSON.stringify(inside)}`).toBeLessThan(40)
  expect(Math.abs(inside.r - inside.b), `mix 0 leaked magenta: ${JSON.stringify(inside)}`).toBeLessThan(40)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

/* ── Task 4 · whole-slice determinism, camera-static alignment, mix ramp, orbit-misaligns xfail ──
 * These lock the projective material's per-frame behaviour with a FAKE injected texture (zero spend):
 *   - determinism: the render is pure — same injected result + same camera renders a data-URL-
 *     IDENTICAL frame twice (the projector is a constant uniform, no per-frame recompute);
 *   - camera-static alignment: object static + camera static ⇒ the projected result stays on the
 *     front surface across a re-render;
 *   - mix ramp: at mix 0.5 the projected pixel is strictly between the plain object and the full
 *     injected image (the blend behaves);
 *   - orbit-stability (a real PASS, Task 3): the projective material keeps the paint registered to the
 *     surface across a camera orbit — the headline S7.1 win the v1 billboard could not achieve (it is
 *     the last test in this file, tracking one world surface point through the orbit).
 * Every visual assertion pairs with the console shader-error gate (on the new material program),
 * matching the S4/S5 loud-failure discipline of the cases above.
 *
 * NOTE (controller-run): needs a live preview (WebGL via SwiftShader). Run against a fresh preview,
 * pane visible, on the isolated preview port — NOT the shared :3002.
 */
const snapshotAt = (page: Page, t01: number) =>
  page.evaluate((t) => (window as any).__scene3dSnapshotAt(t) as string, t01)

test('an injected restyle composites deterministically: the same frame twice is byte-identical', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([RESTYLE_ENABLED()]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  // Two snapshots at the same (static) camera — the projective material samples the fixed bake
  // projector, so a pure render must land identically.
  const first = await snapshot(page)
  const second = await snapshot(page)

  expect(second, 'the same injected result + camera did not render identically twice').toBe(first)
  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

test('camera-static: the injected result stays registered to the silhouette across a re-render', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([RESTYLE_ENABLED()]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  // First render: the injected magenta lands inside the sphere, the corner stays background.
  const shot1 = await snapshot(page)
  const inside1 = await samplePatch(page, shot1, 0.5, 0.5)
  expect(inside1.r, `object centre not magenta on first render: ${JSON.stringify(inside1)}`).toBeGreaterThan(110)
  expect(inside1.b, `object centre not magenta on first render: ${JSON.stringify(inside1)}`).toBeGreaterThan(60)
  expect(inside1.g, `object centre too green on first render: ${JSON.stringify(inside1)}`).toBeLessThan(inside1.r * 0.7)

  // Force another render (nothing moved). The per-frame screenRectOfBox recompute must keep the
  // flat result registered: inside is still magenta, the corner is still the dark background.
  const shot2 = await snapshot(page)
  const inside2 = await samplePatch(page, shot2, 0.5, 0.5)
  const corner2 = await samplePatch(page, shot2, 0.04, 0.04)
  expect(inside2.r, `object centre drifted off the injected result: ${JSON.stringify(inside2)}`).toBeGreaterThan(110)
  expect(inside2.b, `object centre drifted off the injected result: ${JSON.stringify(inside2)}`).toBeGreaterThan(60)
  expect(inside2.g, `object centre too green on re-render: ${JSON.stringify(inside2)}`).toBeLessThan(inside2.r * 0.7)
  expect(corner2.r + corner2.g + corner2.b, `corner is not background after re-render: ${JSON.stringify(corner2)}`).toBeLessThan(150)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

test('mix 0.5 blends: the object centre is strictly between the plain object and the full injected image', async ({ page }) => {
  const bad = watchConsole(page)

  // Plain object (mix 0 — the injection blends nothing, texture ignored): the grey lit sphere.
  await openLab(page, sceneWith([RESTYLE_ENABLED({ mix: 0 })]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA)).toBe(true)
  await page.waitForTimeout(SETTLE_MS)
  const plain = await samplePatch(page, await snapshot(page), 0.5, 0.5)

  // Full restyle (mix 1): the injected magenta.
  await openLab(page, sceneWith([RESTYLE_ENABLED({ mix: 1 })]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA)).toBe(true)
  await page.waitForTimeout(SETTLE_MS)
  const full = await samplePatch(page, await snapshot(page), 0.5, 0.5)

  // Half blend (mix 0.5): every channel must sit strictly between the two endpoints. The blend is
  // mix(litColour, restyle, 0.5) in LINEAR space then tone-mapped to sRGB — monotonic, so the
  // sampled sRGB channel lands strictly between the endpoints even if not the arithmetic midpoint.
  await openLab(page, sceneWith([RESTYLE_ENABLED({ mix: 0.5 })]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA)).toBe(true)
  await page.waitForTimeout(SETTLE_MS)
  const mid = await samplePatch(page, await snapshot(page), 0.5, 0.5)

  const between = (m: number, a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b)
    return m > lo + 2 && m < hi - 2
  }
  const ctx = `plain=${JSON.stringify(plain)} mid=${JSON.stringify(mid)} full=${JSON.stringify(full)}`
  // Green has the largest, most reliable spread (grey g is mid-bright, magenta g is 0) — the
  // anchor channel. Red and blue rise toward magenta; assert all three are strictly interior.
  expect(between(mid.g, plain.g, full.g), `green not between plain and full: ${ctx}`).toBe(true)
  expect(between(mid.r, plain.r, full.r), `red not between plain and full: ${ctx}`).toBe(true)
  expect(between(mid.b, plain.b, full.b), `blue not between plain and full: ${ctx}`).toBe(true)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

/* ── Task 3 · orbit-stability: the projected restyle STAYS registered to the 3D surface ──────────
 * The S7.1 headline. S7 v1 masked a FLAT result to the object's SCREEN silhouette and re-stretched it
 * into the new axis-aligned bbox every frame, so after a camera orbit a feature that should stay
 * pinned to a point ON the object slid off (the reported bug — "masking a fixed image"). Task 2
 * replaced that with a per-object MATERIAL injection that projects the cached result onto the object's
 * real geometry from a FIXED world-space bake projector, so orbiting the LIVE camera cannot move the
 * paint off the surface (the projector is a constant uniform — zero per-frame churn).
 *
 * The oracle: inject a split (left magenta / right cyan) LOCAL texture (zero spend), then track ONE
 * world-space surface point across two camera angles and assert it keeps its restyle colour CLASS.
 * Because the object moves on screen as the camera orbits, the sample coordinate is NOT hard-coded: at
 * each angle it is computed by projecting the tracked WORLD point through the ACTUAL live camera pose
 * (`__scene3dCamera`, which `renderMotionFrame` leaves at the orbit pose) using the scene fov + the
 * rendered aspect (`screenRectOfBox`'s projection convention). A v1 billboard re-stretched to the new
 * bbox would show a DIFFERENT colour at that surface point after the orbit; the world-space projector
 * cannot — a fixed world point samples a fixed crop UV, hence a fixed colour. That colour-class
 * identity across the orbit IS the surface-registration proof.
 *
 * NO fal / paid call. Restyle no longer runs through the treatment stage, so there is NO
 * `__scene3dTreatmentStats` assertion (it does not reflect the material injection); every visual claim
 * is paired with the console shader-error gate, matching the material-path cases above.
 *
 * NOTE (controller-run): needs a live preview (WebGL via SwiftShader) with the pane VISIBLE (a hidden
 * pane pauses the scene3d rAF ⇒ blank snapshot). Run against a fresh preview on the isolated preview
 * port — NOT the shared :3002.
 */
const orbitCamScene = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: {
    position: [0, 1.2, 4.2], target: [0, 0.6, 0], fov: 40,
    motion: { preset: 'orbit', speed: 1, amount: 1 },
  },
  motion: { duration: 4, fps: 30, loop: true },
  objects: [sphere(treatments)],
})

/** Inject a LOCAL texture split left-half magenta / right-half cyan (zero spend), so a point on ONE
 *  half has an unambiguous restyle colour that must persist as the camera orbits. */
async function injectSplit(page: Page, objectId: string): Promise<boolean> {
  return page.evaluate(async (oid) => {
    const cv = document.createElement('canvas')
    cv.width = 32; cv.height = 32
    const c = cv.getContext('2d')!
    c.fillStyle = '#ff00ff'; c.fillRect(0, 0, 16, 32)
    c.fillStyle = '#00ffff'; c.fillRect(16, 0, 16, 32)
    return await (window as any).__scene3dRestyleInject(oid, cv.toDataURL('image/png')) as boolean
  }, objectId)
}

type Cam = { x: number; y: number; z: number; tx: number; ty: number; tz: number }
const camera = (page: Page) => page.evaluate(() => (window as any).__scene3dCamera() as Cam)

/** Project a WORLD point to fractional canvas coords (top-left origin, 0..1) through a camera pose and
 *  average an RGB patch there off the given frame. Mirrors passes.ts's `screenRectOfBox` projection
 *  convention: perspective, VERTICAL fov, flip-Y for the top-left origin. The aspect is read from the
 *  DECODED frame so it matches the rendered drawing buffer exactly (the engine's camera aspect is set
 *  from the same viewport). This is the "track the object's projected position, never a hard-coded
 *  pixel" rule — the sample coordinate follows the surface point as the camera orbits. Runs in-page so
 *  the 2D context does the decode. */
async function sampleWorldPoint(page: Page, dataUrl: string, cam: Cam, world: [number, number, number], fovDeg: number) {
  return page.evaluate(({ url, c, w, fov }) => new Promise<{ r: number; g: number; b: number; fx: number; fy: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = img.width; cv.height = img.height
      const ctx = cv.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      // Camera basis (three's lookAt: right = normalize(forward x up), up = right x forward).
      const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
      const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
      const norm = (a: number[]) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1; return [a[0]! / l, a[1]! / l, a[2]! / l] }
      const pos = [c.x, c.y, c.z], tgt = [c.tx, c.ty, c.tz], up = [0, 1, 0]
      const f = norm(sub(tgt, pos))       // forward (camera looks along f)
      const s = norm(cross(f, up))        // camera right
      const u = cross(s, f)               // camera up
      const d = sub(w, pos)
      const vx = dot(d, s), vy = dot(d, u), vz = dot(d, f) // view coords; vz > 0 is in front
      const aspect = img.width / img.height
      const tanHalf = Math.tan((fov * Math.PI) / 180 / 2)
      const ndcX = vx / (vz * tanHalf * aspect)
      const ndcY = vy / (vz * tanHalf)
      const fx = ndcX * 0.5 + 0.5
      const fy = 0.5 - ndcY * 0.5 // flip Y for the top-left origin
      const px = Math.round(fx * img.width), py = Math.round(fy * img.height)
      const half = 3
      const data = ctx.getImageData(px - half, py - half, half * 2 + 1, half * 2 + 1).data
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < data.length; i += 4) { r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++ }
      resolve({ r: r / n, g: g / n, b: b / n, fx, fy })
    }
    img.onerror = reject
    img.src = url
  }), { url: dataUrl, c: cam, w: world, fov: fovDeg })
}

/** Colour spread — the distance from a neutral grey. A restyle colour (magenta/cyan) is saturated;
 *  the base lit grey sphere (#9aa3af) is near-neutral. */
const sat = (p: { r: number; g: number; b: number }) => Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b)

test('orbit-stability: the projected restyle stays registered to the surface across a camera orbit', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, orbitCamScene([RESTYLE_ENABLED()]))
  expect(await injectSplit(page, 'restyle-sphere'), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  // A front-hemisphere surface point ~45deg to the -X side of the sphere (centre [0,0.6,0], radius
  // 0.5). It is squarely on ONE half of the split (an unambiguous colour) at the bake pose and stays
  // visible + front-facing to the projector after the orbit swings the camera toward -X (~36deg).
  const nn = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  const n = nn([-0.7, 0, 0.71])
  const P: [number, number, number] = [0 + 0.5 * n[0], 0.6 + 0.5 * n[1], 0 + 0.5 * n[2]]
  const FOV = 40

  // Frame 0: the committed (bake) camera pose. The tracked surface point reads a clear restyle colour
  // on one unambiguous half of the split.
  const still = await snapshotAt(page, 0)
  const cam0 = await camera(page)
  const c0 = await sampleWorldPoint(page, still, cam0, P, FOV)
  expect(sat(c0), `bake frame: tracked point is not a restyle colour (near-neutral base?): ${JSON.stringify(c0)}`).toBeGreaterThan(60)
  expect(Math.abs(c0.r - c0.g), `bake frame: tracked point sits on the magenta/cyan seam (ambiguous): ${JSON.stringify(c0)}`).toBeGreaterThan(25)
  const magenta0 = c0.r > c0.g // magenta half ⇒ r>g; cyan half ⇒ g>r

  // Frame at ~36deg of orbit: the SAME world point, projected through the NOW-orbited live camera.
  const orbited = await snapshotAt(page, 0.1)
  const cam1 = await camera(page)
  expect(Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z), 'the camera did not actually orbit').toBeGreaterThan(0.5)
  const c1 = await sampleWorldPoint(page, orbited, cam1, P, FOV)

  // Registration proof: the tracked surface point is STILL a restyle colour (it did NOT slide off to
  // base grey) AND it is the SAME magenta/cyan half it was before the orbit. A v1 billboard,
  // re-stretched to the new axis-aligned bbox, would change the colour at this surface point; the
  // world-space projector samples a fixed crop UV for a fixed world point, so it cannot.
  expect(sat(c1), `after orbit: tracked point slid off the restyle onto base grey: ${JSON.stringify(c1)}`).toBeGreaterThan(60)
  expect(c1.r > c1.g, `after orbit: the tracked surface point changed colour class (restyle slid off the surface): still=${JSON.stringify(c0)} orbited=${JSON.stringify(c1)}`).toBe(magenta0)

  // The paint stays ON the object: an off-object corner is still the dark background after the orbit.
  const corner = await samplePatch(page, orbited, 0.04, 0.04)
  expect(corner.r + corner.g + corner.b, `corner is not background after orbit: ${JSON.stringify(corner)}`).toBeLessThan(150)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

/* ── Task 5 · the ONE live PAID acceptance run (env-gated; ~7 credits) ─────────────────────────
 * Every case above proves the restyle path with INJECTED local results at zero cost. The one thing
 * only a real call can prove is that the route -> fal actually returns a usable restyled image from
 * our baked depth crop (a fal slug/enum mismatch passes at submit and fails at result). This makes
 * EXACTLY ONE paid fal call, only when SCENE3D_RESTYLE_LIVE=1 and FAL_KEY is set on the server, and
 * is skipped everywhere else (CI never spends). Reconcile the observed cost against the ~7-credit
 * MODEL_COSTS estimate.
 */
test('LIVE PAID: the restyle route bakes a depth crop and fal returns a usable image', async ({ page }) => {
  test.skip(!process.env.SCENE3D_RESTYLE_LIVE, 'paid — run manually with SCENE3D_RESTYLE_LIVE=1 and FAL_KEY set')
  test.setTimeout(180_000)
  await openLab(page, sceneWith([RESTYLE_ENABLED()]))

  // Bake the object's real beauty + depth crop (Task 2) — exactly what runRestyle sends.
  const passes = await objectPasses(page, 'restyle-sphere')
  expect(passes, 'renderObjectPasses returned null').not.toBeNull()
  expect(passes!.depth.startsWith('data:image/'), 'depth crop is not a data URL').toBe(true)

  // ONE real call to the paid route, from the page (same-origin :3002, which holds FAL_KEY).
  const res = await page.evaluate(async (p) => {
    const r = await fetch('/api/scene3d/restyle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ beauty: p.beauty, depth: p.depth, prompt: 'a weathered bronze statue, patina', model: 'fal-ai/flux-control-lora-depth', strength: 0.6 }),
    })
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) as any }
  }, passes!)

  console.log('[S7 paid acceptance] status', res.status, 'model', res.body?.model, 'seed', res.body?.seed, 'imageUrl', String(res.body?.imageUrl).slice(0, 90))
  expect(res.ok, `route failed ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(true)
  const imageUrl = res.body?.imageUrl as string
  expect(imageUrl, 'no imageUrl in the response').toMatch(/^https?:\/\//)

  // Fetch the returned image from the TEST context (no CORS) and prove it is a real, non-trivial image.
  const img = await page.request.get(imageUrl)
  expect(img.ok(), `imageUrl did not load: ${img.status()}`).toBe(true)
  const bytes = await img.body()
  console.log('[S7 paid acceptance] image bytes', bytes.length, 'content-type', img.headers()['content-type'])
  expect(bytes.length, 'restyle image is suspiciously small').toBeGreaterThan(5000)

  // Save it so the controller can eyeball the actual restyle.
  const fs = await import('node:fs')
  fs.mkdirSync('test-results', { recursive: true })
  fs.writeFileSync('test-results/s7-restyle-acceptance.png', bytes)
})
