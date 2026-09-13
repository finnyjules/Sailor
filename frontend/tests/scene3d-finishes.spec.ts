import { test, expect, type Page } from '@playwright/test'

/**
 * S5 finishes, end to end against the real WebGL path. Task 1 covers the reference finish,
 * opalescence, and the byte-identical-when-absent claim the whole slice is built on.
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
