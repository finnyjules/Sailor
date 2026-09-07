import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * A layer's strokes as an ordered stack — end to end.
 *
 * The load-bearing case is BYTE-IDENTITY: every stroked kind, stored in TODAY'S
 * single-stroke shape, must render the same pixels through the stack painter as it did
 * through the single `strokeAligned` call the painter used to make. That is what protects
 * every frame anyone has already saved, and no screenshot can argue with it.
 *
 * The mechanism it is guarding: `strokeStackOf` folds a legacy stroke into a ONE-entry
 * list at distance 0, and `paintStrokeBand` delegates distance 0 straight back to
 * `strokeAligned` — so the loop that replaced the single call runs exactly the statements
 * the single call ran. This test is the proof that the chain actually holds for real
 * layers, alignments, dashes, gradients and path scales, rather than only in the argument.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/multi-stroke-legacy.txt', import.meta.url))

/**
 * Fourteen layers in the LEGACY single-stroke shape, covering every stroked kind and
 * every branch the painter can take for one:
 *  - rect × centre (default, rounded) / outside / inside
 *  - ellipse × plain, and a fill-less DASHED one
 *  - polygon and star, which delegate to `drawPath`
 *  - path × scale 1 and scale 1.8 (its stroke units are local, not width-normalized)
 *  - text, whose outline comes from `strokeColor` and is drawn with `strokeText`
 *  - line, which has no interior and keeps a single stroke by design
 *  - two layers whose stroke must draw NOTHING ('none' paint, and a zero width)
 *  - a GRADIENT stroke, so `resolvePaint` is exercised through the new call path too.
 *    `type` MUST be 'linear' or 'radial' — `isGradient` in lib/compositor/paint.ts accepts
 *    only those two, and an invented discriminant ('gradient') falls through every branch,
 *    reaches `strokeStyle` as an object, coerces to an invalid value and paints DEFAULT
 *    BLACK. The fixture carried exactly that bug and the gradient branch was never run.
 */
const LEGACY_LAYERS = [
  { kind: 'rect', x: 0.2, y: 0.2, w: 0.2, h: 0.15, fill: '#3b82f6', stroke: '#ff0000', strokeWidth: 0.01, radius: 0.02 },
  { kind: 'rect', x: 0.5, y: 0.2, w: 0.2, h: 0.15, fill: '#f59e0b', stroke: '#000', strokeWidth: 0.012, strokeAlign: 'outside', radius: 0 },
  { kind: 'rect', x: 0.8, y: 0.2, w: 0.15, h: 0.15, fill: '#22c55e', stroke: '#fff', strokeWidth: 0.012, strokeAlign: 'inside', radius: 0.04 },
  { kind: 'ellipse', x: 0.2, y: 0.5, w: 0.18, h: 0.18, fill: '#ef4444', stroke: '#fff', strokeWidth: 0.008 },
  { kind: 'ellipse', x: 0.45, y: 0.5, w: 0.18, h: 0.12, fill: 'none', stroke: '#0ff', strokeWidth: 0.01, strokeDash: { dash: 0.02, gap: 0.012 } },
  { kind: 'polygon', x: 0.7, y: 0.5, w: 0.16, h: 0.16, sides: 6, fill: '#a855f7', stroke: '#fff', strokeWidth: 0.01, cornerRadius: 0 },
  { kind: 'star', x: 0.9, y: 0.5, w: 0.16, h: 0.16, points: 5, innerRatio: 0.5, fill: '#fde047', stroke: '#000', strokeWidth: 0.008, cornerRadius: 0 },
  { kind: 'path', x: 0.25, y: 0.8, d: 'M -0.1 -0.05 L 0.1 -0.05 L 0 0.08 Z', bbox: { w: 0.2, h: 0.13 }, scale: 1, fill: '#06b6d4', fillRule: 'nonzero', stroke: '#fff', strokeWidth: 0.006 },
  { kind: 'path', x: 0.5, y: 0.8, d: 'M -0.1 -0.05 L 0.1 -0.05 L 0 0.08 Z', bbox: { w: 0.2, h: 0.13 }, scale: 1.8, fill: 'none', fillRule: 'nonzero', stroke: '#f0f', strokeWidth: 0.006, strokeAlign: 'outside' },
  { kind: 'text', x: 0.78, y: 0.8, text: 'Edge', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.07, color: '#ffffff', align: 'center', lineHeight: 1.1, strokeColor: '#ff0000', strokeWidth: 0.004 },
  { kind: 'line', x: 0.5, y: 0.95, w: 0.6, stroke: '#fff', strokeWidth: 0.004, strokeDash: { dash: 0.02, gap: 0.01 } },
  { kind: 'rect', x: 0.35, y: 0.35, w: 0.2, h: 0.2, fill: '#111', stroke: 'none', strokeWidth: 0, radius: 0 },
  { kind: 'ellipse', x: 0.6, y: 0.35, w: 0.14, h: 0.14, fill: '#eee', stroke: '#333', strokeWidth: 0 },
  { kind: 'rect', x: 0.1, y: 0.65, w: 0.1, h: 0.1, fill: 'none', stroke: { type: 'linear', stops: [{ color: '#f00', offset: 0 }, { color: '#00f', offset: 1 }], angle: 45 }, strokeWidth: 0.014, radius: 0 },
]

test('every legacy stroked layer renders identically through the stack painter', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate((ls) => (window as any).__compositorSetLayers(
    ls.map((l, i) => ({ ...l, id: `l${i}`, opacity: 1, rotation: 0, visible: true }))), LEGACY_LAYERS)
  const after = await stackPixels(page)
  expect(after).toBeTruthy()

  // The BASELINE is committed alongside this test, captured once by running it against the
  // PRE-STACK painter (`git show 81b71e4ec:frontend/app/composables/useCompositorLayers.ts`).
  // Regenerating it is a deliberate act, never a fix for a red run: a red run here means
  // the refactor moved a pixel in someone's saved frame, and that is the finding.
  if (!existsSync(FIXTURE)) {
    mkdirSync(dirname(FIXTURE), { recursive: true })
    writeFileSync(FIXTURE, `${after}\n`, 'utf8')
    throw new Error(`Baseline written to ${FIXTURE}. Re-run to compare against it.`)
  }
  const baseline = readFileSync(FIXTURE, 'utf8').trim()
  expect(after).toBe(baseline)
})

/**
 * TEXT AT A DISTANCE (Task 3b).
 *
 * Task 3 gave text multiple strokes but left every one of them on the glyph edge, because
 * the band painter dilated a PATH and a Frame text layer has none. Task 3b made the two
 * ink primitives injectable, so text dilates with `fillText` + `strokeText(2r)` instead.
 *
 * Nothing here is eyeballed. The same layer is rendered twice — once with the stroke on
 * the edge, once with it pushed out — and every probe point is DERIVED from the pixels of
 * those two renders:
 *
 *   outerNear  the leftmost red pixel on the probe row with distance 0   (= edge − w/2)
 *   outerFar   the same, with the distance applied                       (= edge − d − w/2)
 *   wPx        the width of the far band's red run — the stroke's own width in device px,
 *              measured where nothing overlaps it (the near stroke's inner half is painted
 *              over by the glyph's fill, so its run is NOT a clean width to calibrate on)
 *
 * `distance` is set to exactly 4× `width`, so `outerNear − outerFar` must come out at 4·wPx.
 */
const TEXT_STROKE_WIDTH = 0.01
const TEXT_STROKE_DISTANCE = 0.04     // 4 × the width, which is what the assertions use

const textWithStroke = (distance: number) => [{
  id: 'txt', kind: 'text', x: 0.5, y: 0.5, opacity: 1, rotation: 0, visible: true,
  text: 'HI', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.25,
  color: '#0000ff', align: 'center', lineHeight: 1,
  strokes: [{ id: 's1', paint: '#ff0000', width: TEXT_STROKE_WIDTH, distance, align: 'center', join: 'round' }],
}]

/** Red pixels of the settled stack canvas, as an x-list per row. */
async function redPixels(page: import('@playwright/test').Page, layers: unknown[]) {
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), layers)
  await stackPixels(page)   // settles: polls until two reads in a row match
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const g = cv.getContext('2d')!
    const w = cv.width, h = cv.height
    const d = g.getImageData(0, 0, w, h).data
    const rows: number[][] = []
    for (let y = 0; y < h; y++) {
      const xs: number[] = []
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (d[i]! > 150 && d[i + 1]! < 90 && d[i + 2]! < 90 && d[i + 3]! > 200) xs.push(x)
      }
      rows.push(xs)
    }
    return { w, h, rows }
  })
}

/** The first contiguous run of red on a row, tolerating single-pixel antialiasing gaps. */
function firstRun(xs: number[]): { start: number; len: number } | null {
  if (!xs.length) return null
  let end = xs[0]!
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! - end > 2) break
    end = xs[i]!
  }
  return { start: xs[0]!, len: end - xs[0]! + 1 }
}

test('a text stroke at a distance puts ink that far from the glyphs, with clean space between', async ({ page }) => {
  await openCompositor(page)

  const near = await redPixels(page, textWithStroke(0))
  const far = await redPixels(page, textWithStroke(TEXT_STROKE_DISTANCE))

  // The probe ROW is the one carrying the most on-edge outline — computed, not chosen.
  let probeY = -1, best = 0
  for (let y = 0; y < near.h; y++) if (near.rows[y]!.length > best) { best = near.rows[y]!.length; probeY = y }
  expect(probeY, 'the on-edge render must actually draw a red outline').toBeGreaterThan(-1)

  const nearRun = firstRun(near.rows[probeY]!)
  const farRun = firstRun(far.rows[probeY]!)
  expect(nearRun, 'on-edge outline on the probe row').not.toBeNull()
  expect(farRun, 'distant band on the probe row').not.toBeNull()

  const outerNear = nearRun!.start
  const outerFar = farRun!.start
  const wPx = farRun!.len                       // the band's own width, in device px
  expect(wPx).toBeGreaterThan(2)                // enough pixels for the probes below to mean anything

  // 1. The band moved out by EXACTLY the distance. `distance` is normalized to the canvas
  //    width, so its device-pixel value is `distance × cv.width` — no guessing, and no
  //    dependence on the antialiased edges of the run (which is why `wPx`, useful for
  //    sizing the probe windows below, is NOT what this claim is measured against).
  const moved = outerNear - outerFar
  const expectedPx = TEXT_STROKE_DISTANCE * far.w
  expect(moved, `band should sit ${expectedPx}px further out (measured band w=${wPx}px, canvas ${far.w}px)`)
    .toBeGreaterThan(expectedPx - 2)
  expect(moved).toBeLessThan(expectedPx + 2)

  const hasRedNear = (x: number, half: number) => near.rows[probeY]!.some(v => Math.abs(v - x) <= half)
  const hasRedFar = (x: number, half: number) => far.rows[probeY]!.some(v => Math.abs(v - x) <= half)

  // 2. Ink where the near render has none: the middle of the distant band.
  const probe = Math.round(outerFar + wPx / 2)
  const halo = Math.max(1, Math.floor(wPx / 4))
  expect(hasRedFar(probe, halo), `distant band at x=${probe}`).toBe(true)
  expect(hasRedNear(probe, halo), `nothing there when the stroke is on the edge`).toBe(false)

  // 3. …and the converse, so a render that simply lost its outline cannot pass: the near
  //    render inks the glyph edge, where the distant one has moved away from.
  const onEdge = Math.round(outerNear + wPx / 2)
  expect(hasRedNear(onEdge, halo), `on-edge outline at x=${onEdge}`).toBe(true)
  expect(hasRedFar(onEdge, halo), 'the band must not still be sitting on the edge').toBe(false)

  // 4. Clean space BETWEEN the band and the glyph — midway between the band's inner edge
  //    and where the on-edge outline was.
  const gap = Math.round((outerFar + wPx + outerNear) / 2)
  expect(hasRedFar(gap, halo), `clear space at x=${gap}, between the band and the glyph`).toBe(false)
})
