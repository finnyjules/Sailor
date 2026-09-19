import { test, expect, type Page } from '@playwright/test'

/**
 * S6 motion-driven treatments (velocity blur / ghost trails), end to end against the real WebGL
 * path. Created in Task 1 with the byte-identity gate the whole slice is built on; Tasks 2–4 add
 * the "blur along the path", "multiple silhouettes", "none when still", determinism and
 * orbit-doesn't-blur-a-static-object cases (see the S6 plan).
 *
 * Byte-identity is the load-bearing Task-1 claim: `motionTreatmentPlan(doc)` is empty unless a
 * visible host carries an ENABLED motion treatment, and an empty plan means the motion sub-loop
 * never runs (treatmentStage.ts) — so a sphere with a DISABLED velocity-blur / ghost-trails row
 * must render a data-URL-IDENTICAL frame to one with no treatments at all. The unit suite
 * (scene3d-treatments.unit.spec.ts) proves the gate on the plan; this proves it on rendered pixels.
 *
 * NOTE: run by the controller / CI against a fresh preview (pane visible — a hidden pane pauses
 * the scene3d rAF, blanking the snapshot). Do NOT start a dev server from a subagent.
 *
 * Headless Chromium draws WebGL through SwiftShader, hence the generous settle wait — see the
 * sibling specs (scene3d-finishes.spec.ts, scene3d-treatments.spec.ts) for the same pattern.
 */

const SETTLE_MS = 3000

// A gently bobbing sphere, so later tasks have real on-screen motion to smear/trail; the Task-1
// byte-identity cases below use a DISABLED row, which is gated out regardless of motion.
const sphere = (treatments?: unknown[]) => ({
  id: 'motion-sphere', kind: 'primitive', primitive: 'sphere', name: 'Sphere', visible: true,
  position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#9aa3af', roughness: 0.4, metalness: 0 },
  motion: { loop: { kind: 'bob', speed: 1, amount: 1.4 } },
  ...(treatments ? { treatments } : {}),
})
const sceneWith = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 1.2, 4.2], target: [0, 0.6, 0], fov: 40 },
  motion: { duration: 4, fps: 30, loop: true },
  objects: [sphere(treatments)],
})

const VELOCITY_BLUR = (overrides: Record<string, unknown> = {}) => ({
  id: 't-vblur', kind: 'velocityBlur', enabled: true, invert: false,
  amount: 1, shutter: 0.5, ...overrides,
})
const GHOST_TRAILS = (overrides: Record<string, unknown> = {}) => ({
  id: 't-ghost', kind: 'ghostTrails', enabled: true, invert: false,
  count: 3, spacing: 2, fade: 0.5, ...overrides,
})

/** Anything that means "a program failed to build" — same signature the sibling specs watch. */
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
/** A deterministic MOVING frame at `t01` — the S6 oracle (Task 1's `__scene3dSnapshotAt`), which
 *  runs the full sample → velocity push → render path without racing the playhead. */
const snapshotAt = (page: Page, t01: number) =>
  page.evaluate((t) => (window as any).__scene3dSnapshotAt(t) as string, t01)
const stats = (page: Page) =>
  page.evaluate(() => (window as any).__scene3dTreatmentStats() as { frames: number; groups: number })

// A sphere on a HORIZONTAL orbit loop: near t01=0 its screen motion is dominantly along X (x =
// sin(θ)·a leads, z = (1−cosθ)·a is second-order), so a velocity blur smears left↔right — the
// clean directional case the "blur along the path" assertions read.
const orbitSphere = (treatments?: unknown[]) => ({
  id: 'motion-sphere', kind: 'primitive', primitive: 'sphere', name: 'Sphere', visible: true,
  position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#c9d2de', roughness: 0.4, metalness: 0 },
  motion: { loop: { kind: 'orbit', speed: 1, amount: 1.5 } },
  ...(treatments ? { treatments } : {}),
})
const orbitScene = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 0.6, 4.6], target: [0, 0.6, 0], fov: 40 },
  motion: { duration: 4, fps: 30, loop: true },
  objects: [orbitSphere(treatments)],
})

/** Horizontal vs vertical gradient energy over the frame's central band. A horizontal smear
 *  softens the left↔right steps (h drops) while the top↔bottom steps perpendicular to the motion
 *  stay comparatively crisp — so h drops MORE than v (the directionality the plan asserts). The
 *  uniform background contributes no gradient, so a whole-band measure is all object. */
async function axisEnergy(page: Page, dataUrl: string): Promise<{ h: number; v: number }> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    let h = 0, v = 0, n = 0
    for (let y = Math.floor(height * 0.28); y < height * 0.72; y++) {
      for (let x = Math.floor(width * 0.2); x < width * 0.8 - 1; x++) {
        const i = (y * width + x) * 4
        const dh = lum(i) - lum(i + 4)
        const dv = lum(i) - lum(i + width * 4)
        h += dh * dh; v += dv * dv; n++
      }
    }
    return { h: h / n, v: v / n }
  }, dataUrl)
}

/** The foreground's horizontal extent (min/max X, width in px) at the object's mid-height band —
 *  "foreground" = clearly brighter than the #202020 (~32) background. A left↔right smear widens
 *  this, so the silhouette reaches farther along ±path than the crisp control. */
async function hExtent(page: Page, dataUrl: string): Promise<{ minX: number; maxX: number; width: number }> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    let minX = width, maxX = -1
    for (let y = Math.floor(height * 0.44); y < height * 0.56; y++) {
      for (let x = 0; x < width; x++) {
        if (lum((y * width + x) * 4) > 60) { if (x < minX) minX = x; if (x > maxX) maxX = x }
      }
    }
    return { minX, maxX, width: maxX - minX }
  }, dataUrl)
}

/** Fraction of "foreground" pixels (clearly brighter than the #202020 ≈ 32 background) across the
 *  object's mid-height band. A fan of faded ghost copies alongside the crisp object covers more of
 *  the band than the crisp object alone, and more copies cover still more — the multi-silhouette
 *  signal, robust to SwiftShader's exact shading. */
async function fgCoverage(page: Page, dataUrl: string): Promise<number> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    const lum = (i: number) => 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    let fg = 0, n = 0
    for (let y = Math.floor(height * 0.3); y < height * 0.7; y++) {
      for (let x = 0; x < width; x++) { if (lum((y * width + x) * 4) > 45) fg++; n++ }
    }
    return fg / n
  }, dataUrl)
}

// A genuinely STILL sphere (no motion field at all) — for the ghost "none when still" case, where
// every past pose collapses onto the current one and `ghostLocalPoses` returns an empty list. (A
// bob apex will NOT do here: velocity is ~0 there, but the position a few frames back is a real,
// non-collapsed pose, so ghosts would still draw — unlike velocity blur, which reads the derivative.)
const stillSphere = (treatments?: unknown[]) => ({
  id: 'motion-sphere', kind: 'primitive', primitive: 'sphere', name: 'Sphere', visible: true,
  position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#c9d2de', roughness: 0.4, metalness: 0 },
  ...(treatments ? { treatments } : {}),
})
const stillScene = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 0.6, 4.6], target: [0, 0.6, 0], fov: 40 },
  motion: { duration: 4, fps: 30, loop: true },
  objects: [stillSphere(treatments)],
})

// A STATIC object (no `motion` field ⇒ zero world motion) under a scene whose CAMERA orbits it
// (`camera.motion.preset = 'orbit'`, parsed by config.ts's parseCameraMotion / evaluateCameraMotion
// → a per-t01 yaw of the camera about the target). This is the fixture for Decision 4 — object-only
// velocity: velocity is sampled at t/t−dt for the OBJECT and projected through the SAME camera-at-t
// viewProj, so a moving camera contributes no screen velocity to a motionless object. `orbit` speed
// 1 sweeps a full turn over the clip, so at the chosen t01 the camera has visibly moved (the frame
// is a genuine moving-camera instant) yet the static object must stay crisp / unsmeared.
const orbitCamStatic = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: {
    position: [0, 0.6, 4.6], target: [0, 0.6, 0], fov: 40,
    motion: { preset: 'orbit', speed: 1, amount: 1 },
  },
  motion: { duration: 4, fps: 30, loop: true },
  objects: [stillSphere(treatments)],
})

// CONTROLLER / CI: run live against a fresh preview with the pane VISIBLE (a hidden pane pauses the
// scene3d rAF ⇒ blank snapshot). Authored in Task 3; NOT run by the implementing subagent.
test('ghost trails: a moving object shows multiple faded silhouettes, more with a higher count', async ({ page }) => {
  const bad = watchConsole(page)
  const T = 0.05 // early in the orbit: the trail fans dominantly along X

  // Crisp control: the same moving sphere with NO treatment (single silhouette, no ghosts).
  await openLab(page, orbitScene(undefined))
  const crisp = await snapshotAt(page, T)
  const crispCov = await fgCoverage(page, crisp)
  const crispX = await hExtent(page, crisp)

  await openLab(page, orbitScene([GHOST_TRAILS({ count: 3, spacing: 3, fade: 0.6 })]))
  const few = await snapshotAt(page, T)
  const fewStats = await stats(page)
  const fewCov = await fgCoverage(page, few)
  const fewX = await hExtent(page, few)

  await openLab(page, orbitScene([GHOST_TRAILS({ count: 6, spacing: 3, fade: 0.6 })]))
  const many = await snapshotAt(page, T)
  const manyCov = await fgCoverage(page, many)

  // The stage actually ran on this object (the S4/S5 loud-failure guard).
  expect(fewStats.frames, 'the treatment stage rendered a frame').toBeGreaterThan(0)
  expect(fewStats.groups, 'the ghost-trails group was treated').toBeGreaterThanOrEqual(1)
  // Ghosts add faded copies ⇒ more of the band is covered than the lone crisp object …
  expect(few, 'the trail changes the frame vs the untreated object').not.toBe(crisp)
  expect(fewCov, 'the ghost fan covers more than the crisp object alone').toBeGreaterThan(crispCov)
  // … and the silhouette reaches farther along the path than the crisp control.
  expect(fewX.width, 'the trail extends the silhouette along the path').toBeGreaterThanOrEqual(crispX.width)
  // MORE copies ⇒ still more coverage (the count dial does something visible).
  expect(manyCov, 'a higher count paints more faded copies').toBeGreaterThan(fewCov)
  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

// CONTROLLER / CI: run live (pane visible). Authored in Task 3; NOT run by the subagent.
// NOTE the byte-identity here is count-3-still == count-1-still — BOTH route through the motion
// stage and hard-collapse to a single crisp composite (the "none when still" no-op). It is NOT
// compared to a NO-treatment object: that one skips the stage entirely (a different render path);
// the absent-vs-present byte-identity is the separate Task-1 disabled-row gate above.
test('ghost trails: none when still — count 3 at rest is byte-identical to count 1 at rest', async ({ page }) => {
  const bad = watchConsole(page)
  const T = 0.4 // any t01: a motionless object has no past poses to draw at any time

  // count 3 on a still object: every past pose collapses onto the current one ⇒ empty ⇒ one crisp draw.
  await openLab(page, stillScene([GHOST_TRAILS({ count: 3, spacing: 2, fade: 0.5 })]))
  const stillGhost = await snapshotAt(page, T)

  // count 1 at rest: also collapses to a single crisp composite through the same stage path.
  await openLab(page, stillScene([GHOST_TRAILS({ count: 1, spacing: 2, fade: 0.5 })]))
  const countOne = await snapshotAt(page, T)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(stillGhost, 'a still object draws no ghosts, matching count 1 at rest').toBe(countOne)
})

test('velocity blur smears a moving object along its screen path (and differs from amount 0)', async ({ page }) => {
  const bad = watchConsole(page)
  const T = 0.05 // early in the orbit: on-screen motion is dominantly horizontal

  await openLab(page, orbitScene([VELOCITY_BLUR({ amount: 2, shutter: 0.5 })]))
  const blurred = await snapshotAt(page, T)
  const blurStats = await stats(page)
  const blurE = await axisEnergy(page, blurred)
  const blurX = await hExtent(page, blurred)

  await openLab(page, orbitScene([VELOCITY_BLUR({ amount: 0, shutter: 0.5 })]))
  const control = await snapshotAt(page, T)
  const ctrlE = await axisEnergy(page, control)
  const ctrlX = await hExtent(page, control)

  // The stage actually ran on this object (the S4/S5 loud-failure guard — not a silent plain fall-back).
  expect(blurStats.frames, 'the treatment stage rendered a frame').toBeGreaterThan(0)
  expect(blurStats.groups, 'the motion group was treated').toBeGreaterThanOrEqual(1)
  // A real, visible change vs amount 0 at the same moving instant.
  expect(blurred, 'the smear changes the frame vs amount 0').not.toBe(control)
  // DIRECTIONAL: horizontal energy drops (the smear axis) …
  expect(blurE.h, 'horizontal sharpness drops along the smear axis').toBeLessThan(ctrlE.h)
  // … and drops MORE than the perpendicular (vertical) energy — the streak runs along the path.
  expect(blurE.h / ctrlE.h, 'horizontal softens more than vertical').toBeLessThan(blurE.v / ctrlE.v)
  // The silhouette reaches farther left↔right than the crisp control (the smear past the edge).
  expect(blurX.width, 'the smeared silhouette is wider along the path').toBeGreaterThanOrEqual(ctrlX.width)
  expect(blurX.maxX, 'the streak extends past the crisp right edge').toBeGreaterThanOrEqual(ctrlX.maxX)
  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
})

test('velocity blur is a no-op when the object is momentarily still (byte-identical to amount 0)', async ({ page }) => {
  const bad = watchConsole(page)
  // The Task-1 sphere bobs vertically; t01=0.25 is its apex, where the per-frame displacement is
  // sub-pixel (< 1 device px) — the Decision-9 hard no-op, which must match amount 0 exactly.
  const APEX = 0.25

  await openLab(page, sceneWith([VELOCITY_BLUR({ amount: 2, shutter: 0.5 })]))
  const still = await snapshotAt(page, APEX)

  await openLab(page, sceneWith([VELOCITY_BLUR({ amount: 0, shutter: 0.5 })]))
  const amountZero = await snapshotAt(page, APEX)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(still, 'a sub-pixel smear renders identically to amount 0').toBe(amountZero)
})

test('a sphere with a disabled velocity-blur row renders byte-identically to one with no treatments', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([VELOCITY_BLUR({ enabled: false })]))
  const disabled = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(disabled).toBe(plain)
})

test('a sphere with a disabled ghost-trails row renders byte-identically to one with no treatments', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([GHOST_TRAILS({ enabled: false })]))
  const disabled = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(disabled).toBe(plain)
})

// CONTROLLER / CI: run live (pane visible). Authored in Task 4; NOT run by the subagent.
// Decision 4 — the load-bearing correctness property of object-only velocity (both motion samples
// projected through the camera-at-t viewProj): an ORBITING CAMERA must not smear a STATIC object.
// The object carries no `motion` field, so `sceneScreenVelocities` finds pNow == pPrev and stores
// no velocity for it (velocityBlurComposite then takes the v=null crisp branch, independent of
// `amount`) — even though the camera has demonstrably moved by this t01. So amount 2 must be
// byte-identical to amount 0. This is NOT the "still object, still camera" apex case above: here the
// CAMERA is moving, which a screen-true velocity (a documented follow-up) WOULD smear — this case
// pins the v1 object-only choice. The velocityBlur row is enabled, so the motion stage still runs
// (groups >= 1, frames > 0) — the guard that a silent plain fall-back can't pass this by drawing
// the same crisp frame for a different reason.
test('velocity blur: an orbiting camera does not smear a static object (byte-identical to amount 0)', async ({ page }) => {
  const bad = watchConsole(page)
  const T = 0.1 // orbit speed 1 ⇒ ~36° of camera yaw by here: a genuine moving-camera instant

  await openLab(page, orbitCamStatic([VELOCITY_BLUR({ amount: 2, shutter: 0.5 })]))
  const moving = await snapshotAt(page, T)
  const movingStats = await stats(page)

  await openLab(page, orbitCamStatic([VELOCITY_BLUR({ amount: 0, shutter: 0.5 })]))
  const amountZero = await snapshotAt(page, T)

  // The stage actually ran on this object (S4/S5 loud-failure guard — not a silent plain fall-back).
  expect(movingStats.frames, 'the treatment stage rendered a frame').toBeGreaterThan(0)
  expect(movingStats.groups, 'the velocity-blur group was treated').toBeGreaterThanOrEqual(1)
  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  // Object-only velocity: the moving camera adds no screen velocity to the motionless object, so the
  // amount-2 frame is identical to amount 0 — the camera does not smear a static object.
  expect(moving, 'a moving camera does not smear a static object').toBe(amountZero)
})

// CONTROLLER / CI: run live (pane visible). Authored in Task 4; NOT run by the subagent.
// Determinism: the motion sampling (evaluateObjectMotion at t / t−dt, ghostLocalPoses at t−k·spacing)
// is pure and re-derived from doc + t01 every call, so the SAME t01 must render an IDENTICAL frame
// twice on the same page — no seeded/temporal drift, nothing that depends on frame history or wall
// clock. Two __scene3dSnapshotAt(T) calls on one load; assert the data-URLs are equal. Guards the
// export/bake path's reproducibility (a stuttering rAF must not change the smear).
test('velocity blur: the same moving frame renders identically twice (deterministic sampling)', async ({ page }) => {
  const bad = watchConsole(page)
  const T = 0.05

  await openLab(page, orbitScene([VELOCITY_BLUR({ amount: 2, shutter: 0.5 })]))
  const first = await snapshotAt(page, T)
  const firstStats = await stats(page)
  const second = await snapshotAt(page, T)

  expect(firstStats.frames, 'the treatment stage rendered a frame').toBeGreaterThan(0)
  expect(firstStats.groups, 'the motion group was treated').toBeGreaterThanOrEqual(1)
  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(second, 'the same t01 smears identically twice').toBe(first)
})

// CONTROLLER / CI: run live (pane visible). Authored in Task 4; NOT run by the subagent.
// The ghost-trails twin of the determinism case above: N past poses at a fixed t01 are re-derived
// identically each call, so the fanned frame is byte-identical twice.
test('ghost trails: the same moving frame renders identically twice (deterministic sampling)', async ({ page }) => {
  const bad = watchConsole(page)
  const T = 0.05

  await openLab(page, orbitScene([GHOST_TRAILS({ count: 4, spacing: 3, fade: 0.6 })]))
  const first = await snapshotAt(page, T)
  const firstStats = await stats(page)
  const second = await snapshotAt(page, T)

  expect(firstStats.frames, 'the treatment stage rendered a frame').toBeGreaterThan(0)
  expect(firstStats.groups, 'the ghost-trails group was treated').toBeGreaterThanOrEqual(1)
  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(second, 'the same t01 fans ghosts identically twice').toBe(first)
})
