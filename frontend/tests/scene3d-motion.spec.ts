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
