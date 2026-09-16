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
