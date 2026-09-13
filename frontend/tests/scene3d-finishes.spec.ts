import { test, expect, type Page } from '@playwright/test'

/**
 * S5 finishes, end to end against the real WebGL path. Task 1 covers the reference finish,
 * opalescence, and the byte-identical-when-absent claim the whole slice is built on. Task 2 adds
 * foil shimmer — a diffraction-grating highlight, ADDITIVE rather than opal's `mix()` — further
 * down this file.
 *
 * Byte-identity is the load-bearing claim here: `applyFinish` never touches a material at all
 * when the finish list is empty (finishes.ts), so a sphere with zero finish treatments must
 * render a data-URL-IDENTICAL frame to one that never had the `treatments` field at all. The
 * unit suite (scene3d-finishes.unit.spec.ts) already proves this on the compiled shader SOURCE;
 * this spec proves it on the actual rendered pixels, which is the thing that matters.
 *
 * Headless Chromium draws WebGL through SwiftShader, hence the generous settle wait — see the
 * sibling specs (scene3d-vary-tint.spec.ts, scene3d-treatments.spec.ts) for the same pattern.
 */

const SETTLE_MS = 3000

const sphere = (treatments?: unknown[]) => ({
  id: 'opal-sphere', kind: 'primitive', primitive: 'sphere', name: 'Sphere', visible: true,
  position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: 'standard', color: '#9aa3af', roughness: 0.4, metalness: 0 },
  ...(treatments ? { treatments } : {}),
})
const sceneWith = (treatments?: unknown[]) => ({
  version: 1, background: '#202020', showFloor: false,
  camera: { position: [0, 1.2, 4.2], target: [0, 0.6, 0], fov: 40 },
  objects: [sphere(treatments)],
})

const OPAL = (overrides: Record<string, unknown> = {}) => ({
  id: 't-opal', kind: 'opalescence', enabled: true, invert: false,
  strength: 1, frequency: 1.5, hueShift: 0, angleMix: 0.6,
  ...overrides,
})

const FOIL = (overrides: Record<string, unknown> = {}) => ({
  id: 't-foil', kind: 'foilShimmer', enabled: true, invert: false,
  strength: 1, bands: 3, angle: 0, hueShift: 0, gloss: 0.5,
  ...overrides,
})

/** Anything that means "a program failed to build" — the same signature the vary-tint spec
 *  watches for, since a finish is one more `onBeforeCompile` chained onto the same materials. */
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

/** Count of pixels that read as a strongly-saturated hue anywhere but the flat grey/background —
 *  a plain grey standard material has essentially none; an opalescent overlay puts many on
 *  screen. Same shape as the palette census in scene3d-vary-tint.spec.ts. */
async function saturatedCount(page: Page, dataUrl: string): Promise<number> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      if (max > 0.12 && d / max > 0.28) n++
    }
    return n
  }, dataUrl)
}

test('a sphere with no treatments renders byte-identically to one with an empty finish list', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const noField = await snapshot(page)

  await openLab(page, sceneWith([]))
  const emptyList = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(emptyList).toBe(noField)
})

/** Mean relative luminance (0.2126r+0.7152g+0.0722b, sRGB-byte-normalised) over the same
 *  "hued" pixel set `saturatedCount` counts — i.e. the pixels the opalescence overlay actually
 *  painted, ignoring flat grey background/backdrop.
 *
 *  This is the assertion the S5 review's Critical fix needs: at `strength: 1` the finish's
 *  `mix()` writes the ramp sample directly into `gl_FragColor.rgb` with no further encode, so
 *  the on-screen luminance of a hued pixel is ~ the LUT byte value itself when the ramp texture
 *  is (correctly) `NoColorSpace`, or ~ `srgbToLinear(byte)` when it is (incorrectly) tagged
 *  `SRGBColorSpace` and the GPU decodes it before the mix ever runs. Analytically averaging the
 *  actual 256-entry OPAL_DEFAULT_STOPS LUT both ways (see
 *  frontend/tests/unit/scene3d-finishes.unit.spec.ts for the colour-space unit test that pins
 *  the texture tag itself) gives mean luminance ≈0.591 correct vs ≈0.414 with the bug — a ~30%
 *  relative darkening. `LUMINANCE_FLOOR` sits between the two, biased toward the correct value,
 *  so a regression of the SRGBColorSpace tag on this ramp fails this assertion. */
async function meanHueLuminance(page: Page, dataUrl: string): Promise<number> {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let sum = 0, n = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      if (max > 0.12 && d / max > 0.28) {
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
        n++
      }
    }
    return n > 0 ? sum / n : 0
  }, dataUrl)
}
const LUMINANCE_FLOOR = 0.5 // correct ≈0.591, sRGB-misdecoded-ramp bug ≈0.414 — see comment above

test('opalescence renders a rainbow overlay on a standard-material sphere, no shader failure', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)
  const plainSaturated = await saturatedCount(page, plain)

  await openLab(page, sceneWith([OPAL()]))
  const opalSnap = await snapshot(page)
  const opalSaturated = await saturatedCount(page, opalSnap)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  // The plain grey standard material is essentially unsaturated; the opal overlay must put a
  // large share of hued pixels on screen — the overlay actually rendered, not merely compiled.
  expect(opalSaturated, `opal render (${opalSaturated} saturated px vs plain ${plainSaturated})`)
    .toBeGreaterThan(plainSaturated + 500)
  expect(opalSnap).not.toBe(plain)

  // "More saturated pixels than plain grey" alone passes a dark/desaturated-but-hued rainbow —
  // e.g. the ramp-texture sRGB-colour-space regression this spec now guards against, which
  // darkens the overlay without removing its hue. Pin the overlay's brightness too.
  const opalLuminance = await meanHueLuminance(page, opalSnap)
  expect(opalLuminance, `opal overlay mean luminance ${opalLuminance} (floor ${LUMINANCE_FLOOR})`)
    .toBeGreaterThan(LUMINANCE_FLOOR)
})

test('a disabled opalescence treatment renders exactly like no treatment at all', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([OPAL({ enabled: false })]))
  const disabled = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(disabled).toBe(plain)
})

test('the strength dial changes the render — a live uniform, not a dead control', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([OPAL({ strength: 0 })]))
  const zero = await snapshot(page)

  await openLab(page, sceneWith([OPAL({ strength: 1 })]))
  const full = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(full).not.toBe(zero)
})

/**
 * S5 task 2, foil shimmer. Foil is ADDITIVE (writes `gl_FragColor.rgb + rainbow*env*strength`,
 * not opal's `mix()`), so it never floods the whole sphere with saturated colour the way opal
 * does — it is a narrow diffraction streak near the sun/view half-vector. `saturatedCount` (an
 * area metric tuned for opal's whole-surface recolour) would under-count a thin highlight, so
 * this suite uses the plan's prescribed metric instead: raw CHANGED-PIXELS-vs-plain (S4's lesson
 * against a gradient-energy metric, which a thin streak could also fail to move).
 */
const CHANGED_PIXEL_THRESHOLD = 10 // per-channel byte delta below this counts as "unchanged"

async function changedPixelCount(page: Page, dataUrlA: string, dataUrlB: string): Promise<number> {
  return page.evaluate(async ([urlA, urlB, threshold]) => {
    const load = async (url: string) => {
      const img = new Image(); img.src = url; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, c.width, c.height).data
    }
    const [a, b] = await Promise.all([load(urlA), load(urlB)])
    let n = 0
    for (let i = 0; i < a.length; i += 4) {
      const dr = Math.abs(a[i]! - b[i]!)
      const dg = Math.abs(a[i + 1]! - b[i + 1]!)
      const db = Math.abs(a[i + 2]! - b[i + 2]!)
      if (dr > threshold || dg > threshold || db > threshold) n++
    }
    return n
  }, [dataUrlA, dataUrlB, CHANGED_PIXEL_THRESHOLD] as const)
}

test('foil shimmer changes the render versus a plain sphere, no shader failure', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([FOIL()]))
  const foilSnap = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(foilSnap).not.toBe(plain)
  const changed = await changedPixelCount(page, plain, foilSnap)
  // A diffraction streak is narrow, not a whole-surface recolour (that is opal's job) — a few
  // hundred changed pixels is a real, visible highlight; zero would mean the injection compiled
  // but never actually painted anything (e.g. the NUM_DIR_LIGHTS guard silently zeroing it out).
  expect(changed, `foil render changed ${changed} px vs plain`).toBeGreaterThan(200)
})

test('a disabled foil-shimmer treatment renders exactly like no treatment at all', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([FOIL({ enabled: false })]))
  const disabled = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(disabled).toBe(plain)
})

test('foil shimmer with an empty finish list is byte-identical to a sphere with none at all', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const noField = await snapshot(page)

  await openLab(page, sceneWith([]))
  const emptyList = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(emptyList).toBe(noField)
})

test('foil shimmer is deterministic — the same params render the identical frame twice', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([FOIL()]))
  const first = await snapshot(page)

  await openLab(page, sceneWith([FOIL()]))
  const second = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(second).toBe(first)
})

test('the gloss dial changes the render — a live uniform, not a dead control', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([FOIL({ gloss: 0 })]))
  const soft = await snapshot(page)

  await openLab(page, sceneWith([FOIL({ gloss: 1 })]))
  const sharp = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(sharp).not.toBe(soft)
})

test('opalescence and foil shimmer stack on one object — both overlays are visible together', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([OPAL(), FOIL()]))
  const stacked = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(stacked).not.toBe(plain)
  const changed = await changedPixelCount(page, plain, stacked)
  expect(changed, `stacked render changed ${changed} px vs plain`).toBeGreaterThan(500)
})

/**
 * S5 task 3, matcap coat — the hardest of the three finishes because matcap has no injectable
 * chunk today (a whole separate THREE material CLASS), so `MATCAP_FINISH_BODY` (finishes.ts) is
 * authored fresh from three's own `meshmatcap.glsl.js` UV math rather than ported from an
 * existing MATERIAL type's `_FRAG_BODY`. Like opalescence, matcap coat `mix()`es over the whole
 * visible surface (not a narrow highlight like foil), so `changedPixelCount` against a plain
 * sphere should read a LARGE area, not merely "some pixels changed".
 */
const MATCAP = (overrides: Record<string, unknown> = {}) => ({
  id: 't-matcap', kind: 'matcapCoat', enabled: true, invert: false,
  matcap: 'chrome', strength: 1,
  ...overrides,
})

test('matcap coat changes the render versus a plain sphere, no shader failure', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([MATCAP()]))
  const matcapSnap = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(matcapSnap).not.toBe(plain)
  const changed = await changedPixelCount(page, plain, matcapSnap)
  // A full-strength matcap coat replaces the lit colour across the whole visible sphere — a
  // whole-surface change, not a thin streak, so the bar is set much higher than foil's.
  expect(changed, `matcap coat render changed ${changed} px vs plain`).toBeGreaterThan(2000)
})

test('a disabled matcap-coat treatment renders exactly like no treatment at all', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([MATCAP({ enabled: false })]))
  const disabled = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(disabled).toBe(plain)
})

test('matcap coat with an empty finish list is byte-identical to a sphere with none at all', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const noField = await snapshot(page)

  await openLab(page, sceneWith([]))
  const emptyList = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(emptyList).toBe(noField)
})

test('matcap coat is deterministic — the same params render the identical frame twice', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([MATCAP()]))
  const first = await snapshot(page)

  await openLab(page, sceneWith([MATCAP()]))
  const second = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(second).toBe(first)
})

test('the strength dial changes the render — a live uniform, not a dead control', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([MATCAP({ strength: 0 })]))
  const zero = await snapshot(page)

  await openLab(page, sceneWith([MATCAP({ strength: 1 })]))
  const full = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(full).not.toBe(zero)
})

test('changing the matcap id changes the render — a rebuild boundary, not a dead control', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith([MATCAP({ matcap: 'chrome' })]))
  const chrome = await snapshot(page)

  await openLab(page, sceneWith([MATCAP({ matcap: 'gold' })]))
  const gold = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(gold).not.toBe(chrome)
})

test('opalescence and matcap coat stack on one object — both overlays are visible together', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, sceneWith(undefined))
  const plain = await snapshot(page)

  await openLab(page, sceneWith([OPAL(), MATCAP()]))
  const stacked = await snapshot(page)

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])
  expect(stacked).not.toBe(plain)
  const changed = await changedPixelCount(page, plain, stacked)
  expect(changed, `stacked render changed ${changed} px vs plain`).toBeGreaterThan(500)
})
