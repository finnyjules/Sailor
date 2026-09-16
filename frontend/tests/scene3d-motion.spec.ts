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
