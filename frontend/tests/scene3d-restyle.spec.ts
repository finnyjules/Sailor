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
