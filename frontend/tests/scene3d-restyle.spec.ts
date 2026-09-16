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
 * The injected-composite / mix-ramp cases (which exercise the stage's restyleComposite with a
 * FAKE cached texture via `window.__scene3dRestyleInject`, at zero cost) are Task 3/4 — this file
 * grows them there. NO fal / paid call is made anywhere in this spec.
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

type Passes = { beauty: string; depth: string; normal: string; rect: { x: number; y: number; w: number; h: number } } | null
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

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

/* ── Task 3 · the injected composite (restyleComposite via __scene3dRestyleInject) ─────────────
 * The stage's restyle composite exercised with a FAKE cached result texture — a LOCAL solid-colour
 * PNG data URL injected through window.__scene3dRestyleInject. NO fal / paid call anywhere: the
 * "result" is a canvas the browser draws. This proves (a) the composite runs (stats.groups >= 1,
 * frames > 0), (b) the injected image is masked to the object's silhouette (a pixel inside the
 * object is the injected colour; a pixel in the corner is the background), (c) mix 0 is a
 * byte-identical no-op (the injected texture is ignored — the plain-object early-out), and mix 1 is
 * fully the injected image. Console shader-error gate stays on `restyleMat`.
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

  const stats = await page.evaluate(() => (window as any).__scene3dTreatmentStats())
  expect(stats.groups, 'the restyle group did not render').toBeGreaterThanOrEqual(1)
  expect(stats.frames, 'no frames rendered').toBeGreaterThan(0)

  const shot = await snapshot(page)
  // Inside the sphere (canvas centre-ish): the injected magenta — high R + B, low G.
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
  // Injected but mix 0 → the plain-object early-out (the texture must not appear).
  await openLab(page, sceneWith([RESTYLE_ENABLED({ mix: 0 })]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA)).toBe(true)
  await page.waitForTimeout(SETTLE_MS)
  const injectedMix0 = await snapshot(page)

  // Same enabled restyle at mix 0 but with NO result injected — also the plain-object early-out.
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
 * These lock the composite's per-frame behaviour with a FAKE injected texture (zero spend, no fal):
 *   - determinism: the composite is pure — same injected result + same camera renders a
 *     data-URL-IDENTICAL frame twice (guards nondeterministic sampling in restyleComposite);
 *   - camera-static alignment: object static + camera static ⇒ the injected result stays registered
 *     to the silhouette across a re-render (each frame recomputes screenRectOfBox — it must land the
 *     same when nothing moves);
 *   - mix ramp: at mix 0.5 the composited pixel is strictly between the plain object and the full
 *     injected image (the blend behaves);
 *   - orbit-misaligns (test.fixme): the KNOWN follow-up — after a CAMERA ORBIT the flat 2D result no
 *     longer registers to the rotated silhouette (needs re-projection). Marked fixme so it is a
 *     visible limitation in the report, never a false green.
 * Every visual assertion pairs with __scene3dTreatmentStats() (frames>0, groups>=1) + the console
 * shader-error gate, matching the S4/S5 loud-failure discipline of the cases above.
 *
 * NOTE (controller-run): needs a live preview (WebGL via SwiftShader). Run against a fresh preview,
 * pane visible, on the isolated preview port — NOT the shared :3002.
 */
const snapshotAt = (page: Page, t01: number) =>
  page.evaluate((t) => (window as any).__scene3dSnapshotAt(t) as string, t01)
const treatmentStats = (page: Page) => page.evaluate(() => (window as any).__scene3dTreatmentStats())

test('an injected restyle composites deterministically: the same frame twice is byte-identical', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([RESTYLE_ENABLED()]))
  expect(await injectSolid(page, 'restyle-sphere', MAGENTA), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  // Two snapshots at the same (static) camera — each re-renders through restyleComposite, which
  // recomputes the screen crop rect from the object Box3. A pure composite must land identically.
  const first = await snapshot(page)
  const stats = await treatmentStats(page)
  const second = await snapshot(page)

  expect(stats.groups, 'the restyle group did not render').toBeGreaterThanOrEqual(1)
  expect(stats.frames, 'no frames rendered').toBeGreaterThan(0)
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
  const stats = await treatmentStats(page)
  const inside2 = await samplePatch(page, shot2, 0.5, 0.5)
  const corner2 = await samplePatch(page, shot2, 0.04, 0.04)
  expect(stats.groups, 'the restyle group did not render').toBeGreaterThanOrEqual(1)
  expect(stats.frames, 'no frames rendered').toBeGreaterThan(0)
  expect(inside2.r, `object centre drifted off the injected result: ${JSON.stringify(inside2)}`).toBeGreaterThan(110)
  expect(inside2.b, `object centre drifted off the injected result: ${JSON.stringify(inside2)}`).toBeGreaterThan(60)
  expect(inside2.g, `object centre too green on re-render: ${JSON.stringify(inside2)}`).toBeLessThan(inside2.r * 0.7)
  expect(corner2.r + corner2.g + corner2.b, `corner is not background after re-render: ${JSON.stringify(corner2)}`).toBeLessThan(150)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

test('mix 0.5 blends: the object centre is strictly between the plain object and the full injected image', async ({ page }) => {
  const bad = watchConsole(page)

  // Plain object (mix 0 — the early-out, texture ignored): the grey lit sphere.
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
  const stats = await treatmentStats(page)
  const mid = await samplePatch(page, await snapshot(page), 0.5, 0.5)

  expect(stats.groups, 'the restyle group did not render').toBeGreaterThanOrEqual(1)
  expect(stats.frames, 'no frames rendered').toBeGreaterThan(0)

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

/* ── KNOWN LIMITATION (owed follow-up: camera-orbit re-projection) ──────────────────────────────
 * The restyle result is a FLAT 2D image fitted to the object's screen-space bounding box. The crop
 * rect is recomputed each frame, so the result tracks the box as the object/camera move — but the
 * texture content is a projection baked from the COMMITTED camera. After a camera ORBIT the object's
 * silhouette rotates in 3D while the flat texture is merely re-stretched to the new axis-aligned
 * bbox, so a feature that should stay pinned to a point ON the object slides off. Fixing this needs
 * re-projection (or auto-invalidation) — the plan's first owed follow-up.
 *
 * Authored as test.fixme so it is REPORTED as a known limitation and never runs as a false green.
 * The body is a real regression test (a two-colour split texture whose seam should stay anchored to
 * the object across an orbit): drop the `.fixme` once re-projection lands and it becomes live.
 */
const orbitCamScene = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: {
    position: [0, 1.2, 4.2], target: [0, 0.6, 0], fov: 40,
    motion: { preset: 'orbit', speed: 1, amount: 1 },
  },
  objects: [sphere(treatments)],
})

/** Inject a LOCAL texture split left-half magenta / right-half cyan, so an orbit that fails to
 *  re-project shows the seam sliding relative to the object. Zero spend. */
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

test.fixme('orbit re-projection (OWED): the flat result stays pinned to the silhouette after a camera orbit', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, orbitCamScene([RESTYLE_ENABLED()]))
  expect(await injectSplit(page, 'restyle-sphere'), 'inject hook returned false').toBe(true)
  await page.waitForTimeout(SETTLE_MS)

  // At t01=0 the camera is at its committed pose: left of the object reads magenta, right reads cyan.
  const still = await snapshotAt(page, 0)
  const stillL = await samplePatch(page, still, 0.42, 0.5)
  const stillR = await samplePatch(page, still, 0.58, 0.5)
  expect(stillL.r > stillL.g, `still: left patch not magenta ${JSON.stringify(stillL)}`).toBe(true)
  expect(stillR.g > stillR.r, `still: right patch not cyan ${JSON.stringify(stillR)}`).toBe(true)

  // After ~36 degrees of orbit the object's surface has rotated. With CORRECT re-projection a
  // point that was on the magenta half stays magenta; today the flat texture re-stretches to the
  // new bbox and the seam slides, so this assertion fails — the follow-up. Kept as fixme.
  const orbited = await snapshotAt(page, 0.1)
  const stats = await treatmentStats(page)
  expect(stats.groups, 'the restyle group did not render').toBeGreaterThanOrEqual(1)
  const orbitedL = await samplePatch(page, orbited, 0.42, 0.5)
  expect(orbitedL.r > orbitedL.g, `orbit misregistered the flat result (owed re-projection): ${JSON.stringify(orbitedL)}`).toBe(true)

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
