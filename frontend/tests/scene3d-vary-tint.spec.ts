import { test, expect, type Page } from '@playwright/test'

/**
 * Cloner Vary, end to end against the real WebGL path.
 *
 * The bug this exists for compiled perfectly as SOURCE TEXT and not at all as a SHADER:
 * `applyVaryTint` injected a mix reading `uVaryStrength` and never declared the uniform, so
 * every tinted object failed `VALIDATE_STATUS` and disappeared. The unit suite was green —
 * it asserts the ORDER of chunks in the resolved source, and nothing there ever compiled.
 * So this spec asserts two things nothing static can: the console carries no shader error,
 * and the palette colours are actually ON SCREEN.
 *
 * Headless Chromium draws WebGL through SwiftShader, hence the settle wait.
 */

const SETTLE_MS = 3000

/** Six boxes in a row, cycling a four-colour palette: red, orange, green, blue, red, orange. */
const cloneSet = (varyColor: 0 | 1) => ({
  version: 1,
  background: '#202020',
  showFloor: false,
  camera: { position: [2.5, 1.4, 8], target: [2.5, 0.6, 0], fov: 45 },
  objects: [{
    id: 'vary-box', kind: 'primitive', primitive: 'box', name: 'Box', visible: true,
    position: [0, 0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    params: { width: 0.7, height: 0.7, depth: 0.7 },
    modifiers: { cloneCount: 6, cloneMode: 0, cloneOffsetX: 1.0, varyColor, varyColorStrength: 1 },
    varyPalette: ['#e03131', '#f59f00', '#2f9e44', '#1971c2'],
    material: { type: 'standard', color: '#9aa3af', roughness: 0.45, metalness: 0 },
  }],
})

/** Anything that means "a program failed to build" — three logs shader errors through
 *  console.error, and the useProgram spam that follows is the same failure. */
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

/** Count saturated pixels per palette hue bucket, plus how much of the frame is
 *  anything other than the flat background (i.e. did the object render at all). */
async function paletteCensus(page: Page, dataUrl: string) {
  return page.evaluate(async (url) => {
    const img = new Image(); img.src = url; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const out = { red: 0, orange: 0, green: 0, blue: 0, saturated: 0, lit: 0, total: data.length / 4 }
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
      if (max > 0.18) out.lit++
      if (max < 0.12 || d / max < 0.28) continue      // background or near-grey
      out.saturated++
      let h = 0
      if (max === r) h = 60 * (((g - b) / d) % 6)
      else if (max === g) h = 60 * ((b - r) / d + 2)
      else h = 60 * ((r - g) / d + 4)
      if (h < 0) h += 360
      if (h < 22 || h >= 340) out.red++
      else if (h < 55) out.orange++
      else if (h >= 85 && h < 175) out.green++
      else if (h >= 185 && h < 265) out.blue++
    }
    return out
  }, dataUrl)
}

const snapshot = (page: Page) => page.evaluate(() => (window as any).__scene3dSnapshot() as string)

test('a tinted clone set compiles and renders all four palette colours', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, cloneSet(1))

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])

  const census = await paletteCensus(page, await snapshot(page))
  // The object is on screen at all — a failed program renders nothing, and the whole
  // point of the Critical is that "no error" and "something drawn" are separate claims.
  expect(census.lit, 'nothing was drawn').toBeGreaterThan(census.total * 0.01)
  // …in four distinct palette hues, not one flat tint.
  for (const hue of ['red', 'orange', 'green', 'blue'] as const) {
    expect(census[hue], `${hue} missing from the render (census: ${JSON.stringify(census)})`).toBeGreaterThan(200)
  }
})

test('an UNTINTED clone set is unaffected: clean console, the material own grey', async ({ page }) => {
  const bad = watchConsole(page)
  await openLab(page, cloneSet(0))

  expect(bad, `shader failures on the console:\n${bad.join('\n')}`).toEqual([])

  const census = await paletteCensus(page, await snapshot(page))
  expect(census.lit, 'nothing was drawn').toBeGreaterThan(census.total * 0.01)
  // #9aa3af is a desaturated grey: essentially no strongly-hued pixels anywhere.
  expect(census.saturated, `unexpected colour in an untinted render: ${JSON.stringify(census)}`)
    .toBeLessThan(census.total * 0.005)
})
