import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
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

/**
 * DISTANCE AND ORDER, MEASURED IN A REAL BROWSER (Task 4).
 *
 * Tasks 1-3 wired the distance dial and the ordered stroke stack; the byte-identity test
 * above proves neither broke a single already-saved frame. Nothing until now proves the
 * NEW behaviour reaches a pixel: that `distance` moves a band the right number of pixels
 * in EITHER direction, on every side of a shape; that the list's first entry paints on
 * top; and that a hidden stroke paints nothing. A dial that stores its value without
 * reaching a pixel is this codebase's most common defect, so only pixels disprove it.
 *
 * GEOMETRY: `w`/`h` and a stroke's `width`/`distance` are ALWAYS normalized to the canvas
 * WIDTH (see `parseSeedreamLayers`'s doc and `applyStrokeMask`'s own
 * `(layer.x ?? 0.5) * W, (layer.y ?? 0.5) * H`), while `pixelAt` below reads its `y`
 * argument as a fraction of the canvas HEIGHT. Those two units only coincide when the
 * canvas is square. `openCompositor` opens a brand-new, image-less document, and a fresh
 * document's artboard defaults to a 1:1 aspect (`baseAspect` with no background image) —
 * confirmed empirically before writing any assertion below (a throwaway probe read
 * `cv.width === cv.height === 542` for exactly this seeding path). So every probe here is
 * safe to state as one plain fraction — but the arithmetic is spelled out at each one
 * regardless, so a future non-square default doesn't silently invalidate it.
 *
 * ORDER + SKIP is implemented in TWO places that must never drift apart: `paintStrokeStack`
 * (rect/ellipse/polygon/star/path) and `textStrokePasses` (text's on-edge strokes — see
 * `paintTextStrokeBands`'s own doc for why a DISTANT text stroke is a different, and
 * strictly lower, construction). Every order/hidden assertion below is therefore written
 * twice: once against a shape, once against text.
 */

/** The colour of the pixel at (x, y) in the settled stack canvas, as [r,g,b,a]. `x` is a
 *  fraction of the canvas's own WIDTH, `y` a fraction of its HEIGHT — see the geometry
 *  note above for why those coincide here. */
async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(({ x, y }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(Math.round(x * cv.width), Math.round(y * cv.height), 1, 1).data
    return [d[0]!, d[1]!, d[2]!, d[3]!]
  }, { x, y })
}

/** The colour at a literal DEVICE pixel (x, y) — used once the probe point comes from a
 *  measured run rather than from stated geometry (the two text tests below). */
async function pixelAtDevice(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(({ x, y }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(x, y, 1, 1).data
    return [d[0]!, d[1]!, d[2]!, d[3]!]
  }, { x, y })
}

test('a stroke at a distance sits that far from the edge, on every side', async ({ page }) => {
  await openCompositor(page)
  // A black square, 0.4 wide, centred. One red stroke, 0.01 wide, 0.05 out.
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: 0.05, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  // The square's right edge is at 0.5 + 0.4/2 = 0.7 (all width-normalized, no axis
  // conversion needed here). The band's centre must be at 0.7 + 0.05 = 0.75, and there
  // must be clean air between the shape and the band.
  expect(isRed(await pixelAt(page, 0.75, 0.5))).toBe(true)
  expect(isRed(await pixelAt(page, 0.72, 0.5))).toBe(false)   // the gap
  expect(isRed(await pixelAt(page, 0.79, 0.5))).toBe(false)   // beyond the band
  // Same distance on the TOP edge. The half-height and the distance are both stored in
  // WIDTH units: (0.4/2 + 0.05) * W px up from centre. `pixelAt`'s y is a fraction of
  // canvas HEIGHT, so that offset is (0.25 * W) / H in canvas-height fractions — which is
  // exactly 0.25 on the square canvas this suite runs against (W === H), and would need
  // the W/H ratio folded in on a non-square one.
  expect(isRed(await pixelAt(page, 0.5, 0.25))).toBe(true)
})

test('the distance is uniform on a NON-square shape — an offset, not a scale', async ({ page }) => {
  await openCompositor(page)
  // 0.6 wide, 0.2 tall. A scale-based fake would put the horizontal gap 3x the vertical one.
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.6, h: 0.2, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: 0.05, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  // Right edge: 0.5 + 0.6/2 = 0.8, band centre 0.8 + 0.05 = 0.85. Purely horizontal, so no
  // W/H conversion applies regardless of canvas aspect.
  expect(isRed(await pixelAt(page, 0.85, 0.5))).toBe(true)
  expect(isRed(await pixelAt(page, 0.82, 0.5))).toBe(false)
  // Bottom edge: half-height is 0.2/2 = 0.1 in WIDTH units, so (0.1 + 0.05) * W px down
  // from centre — a canvas-height fraction of (0.15 * W) / H, which is 0.15 on this
  // suite's square canvas (W === H), landing the band centre at 0.5 + 0.15 = 0.65.
  expect(isRed(await pixelAt(page, 0.5, 0.65))).toBe(true)
  expect(isRed(await pixelAt(page, 0.5, 0.62))).toBe(false)
})

test('a negative distance puts the stroke inside the shape', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: -0.05, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  // Edge 0.7 minus 0.05 = 0.65. Purely horizontal.
  expect(isRed(await pixelAt(page, 0.65, 0.5))).toBe(true)
  expect(isRed(await pixelAt(page, 0.69, 0.5))).toBe(false)
})

test('the first stroke in the list paints on top — SHAPE', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, rotation: 0, opacity: 1, visible: true,
    fill: 'none', radius: 0,
    strokes: [
      { id: 'top', paint: '#ff0000', width: 0.01, distance: 0, align: 'center' },
      { id: 'under', paint: '#0000ff', width: 0.04, distance: 0, align: 'center' },
    ],
  }]))
  await stackPixels(page)
  const p = await pixelAt(page, 0.65, 0.5)   // on the shared edge: 0.5 + 0.3/2 = 0.65
  expect(p[0]!).toBeGreaterThan(200)          // red, not blue
  expect(p[2]!).toBeLessThan(60)
})

test('a hidden stroke paints nothing — SHAPE', async ({ page }) => {
  await openCompositor(page)
  // Same shape and stroke geometry as the first distance test, but `visible: false` — if
  // the stroke painted anyway, the band would sit exactly at these two probes.
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
    fill: '#000000', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: 0.05, align: 'center', join: 'sharp', visible: false }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 200 && p[1]! < 60 && p[3]! > 200
  expect(isRed(await pixelAt(page, 0.75, 0.5))).toBe(false)
  expect(isRed(await pixelAt(page, 0.5, 0.25))).toBe(false)
})

/**
 * The text equivalents of the two SHAPE tests above. `paintTextStrokeBands`'s own doc
 * states the limitation plainly: a stroke at a distance is painted as a group BENEATH the
 * on-edge strokes and the fill, in stack order among themselves — so an order test on
 * text must compare two strokes that are BOTH on-edge (distance 0), never one of each,
 * or the "which is on top" question would really be answered by distance, not by list
 * order. Both tests below therefore use distance-0 strokes only, which is exactly the
 * code path `textStrokePasses` owns (as opposed to `paintTextStrokeBands`, which owns
 * distant strokes and is already covered by the "text stroke at a distance" test above).
 *
 * Font metrics vary by platform, so — same discipline as the "text stroke at a distance"
 * test above — the probe pixel is MEASURED from a real render, never guessed.
 */
test('the first stroke in the list paints on top — TEXT, both on the edge', async ({ page }) => {
  await openCompositor(page)
  const STROKE_W = 0.02
  // A green fill keeps the glyph body unambiguous against both the red and the blue
  // strokes probed below (low overlap with either detector on any channel).
  const layerWith = (strokes: unknown[]) => [{
    id: 'txt', kind: 'text', x: 0.5, y: 0.5, opacity: 1, rotation: 0, visible: true,
    text: 'HI', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.25,
    color: '#00ff00', align: 'center', lineHeight: 1, strokes,
  }]

  // Render the 'top' stroke ALONE first, purely to measure a real ink pixel to probe.
  const solo = await redPixels(page, layerWith([
    { id: 'top', paint: '#ff0000', width: STROKE_W, distance: 0, align: 'center', join: 'round' },
  ]))
  let probeY = -1, best = 0
  for (let y = 0; y < solo.h; y++) if (solo.rows[y]!.length > best) { best = solo.rows[y]!.length; probeY = y }
  expect(probeY, 'the solo on-edge stroke must actually draw red ink').toBeGreaterThan(-1)
  const run = firstRun(solo.rows[probeY]!)
  expect(run, 'a red run on the probe row').not.toBeNull()
  const probeX = run!.start + Math.floor(run!.len / 2)

  // Now stack a SECOND stroke of the identical width and distance UNDER it in the list.
  // Same width + same distance + `align` ignored for text (no path to straddle) means the
  // two bands land on EXACTLY the same pixels, so whichever one is drawn LAST is the only
  // colour visible at the probe — a clean read on list order with no partial-overlap
  // ambiguity.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), layerWith([
    { id: 'top', paint: '#ff0000', width: STROKE_W, distance: 0, align: 'center', join: 'round' },
    { id: 'under', paint: '#0000ff', width: STROKE_W, distance: 0, align: 'center', join: 'round' },
  ]))
  await stackPixels(page)
  const p = await pixelAtDevice(page, probeX, probeY)
  expect(p[0]!, `pixel at device (${probeX},${probeY}) should be red (list's first entry), not blue`).toBeGreaterThan(150)
  expect(p[2]!).toBeLessThan(90)
})

test('a hidden stroke paints nothing — TEXT, on the edge', async ({ page }) => {
  await openCompositor(page)
  const layers = [{
    id: 'txt', kind: 'text', x: 0.5, y: 0.5, opacity: 1, rotation: 0, visible: true,
    text: 'HI', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.25,
    color: '#00ff00', align: 'center', lineHeight: 1,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.02, distance: 0, align: 'center', join: 'round', visible: false }],
  }]
  const result = await redPixels(page, layers)
  const anyRed = result.rows.some(r => r.length > 0)
  expect(anyRed, 'a stroke with visible: false must paint no red ink anywhere').toBe(false)
})

/**
 * A STROKE MADE OF LIBRARY SHAPES (Task 6).
 *
 * Tasks 1-4 made a stroke a list and gave it a distance; Task 5 built the pure geometry for
 * the other STYLE — library marks marching along the (offset) outline, turning to follow
 * it. Nothing until now proves that geometry reaches a pixel. These tests are the proof,
 * and each is written so that the obvious wrong implementation fails it:
 *
 *  - the count test fails if the marks are not actually walked by arc length;
 *  - the follow test uses an ASYMMETRIC mark (a triangle) and reads a quantity that is
 *    OPPOSITE for the two settings, so an implementation that always rotates and one that
 *    never rotates each fail one half;
 *  - the paint test asserts the stroke's own colour AND the absence of black, because the
 *    failure this feature has already hit once is a paint that silently renders black
 *    (`isGradient` accepts only 'linear'/'radial' — see the fixture's own note above).
 */

/** Red-ish, green-ish, blue-ish, and "opaque and dark" — the last one is what a paint that
 *  fell through to a default black looks like. */
const CH = {
  red: (d: number[]) => d[0]! > 170 && d[1]! < 90 && d[2]! < 90 && d[3]! > 150,
  green: (d: number[]) => d[1]! > 170 && d[0]! < 90 && d[2]! < 90 && d[3]! > 150,
  blue: (d: number[]) => d[2]! > 170 && d[0]! < 90 && d[1]! < 90 && d[3]! > 150,
  black: (d: number[]) => d[0]! < 70 && d[1]! < 70 && d[2]! < 70 && d[3]! > 150,
}

/** One shapes-stroke layer: a fill-less circle carrying a single marching stroke. */
const shapesCircle = (o: {
  paint: unknown; shapeId: string; size: number; spacing: number; follow?: boolean; distance?: number
}) => [{
  id: 'e', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
  fill: 'none',
  strokes: [{
    id: 's1', paint: o.paint, width: 0.004, distance: o.distance ?? 0, style: 'shapes',
    shapes: { shapeId: o.shapeId, size: o.size, spacing: o.spacing, follow: o.follow ?? true },
  }],
}]

/**
 * THE PATH HELPERS AGREE WITH THE CANVAS PRIMITIVES.
 *
 * A shapes stroke marches along `outlinePathData`'s string, but a rect and an ellipse are
 * DRAWN by `ctx.roundRect` / `ctx.ellipse`. If the two disagree, every mark sits slightly
 * off the real edge and nothing in the app reports it — so the agreement is asserted where
 * it actually matters: on the raster. Both are filled solid on identically-sized canvases
 * and the two images compared pixel by pixel.
 */
test('roundedRectPathData and ellipsePathData rasterise exactly as roundRect and ellipse do', async ({ page }) => {
  await openCompositor(page)
  const diffs = await page.evaluate(async () => {
    const mod: any = await import(/* @vite-ignore */ '/_nuxt/lib/compositor/polygonGeometry.ts')
    const W = 400, H = 300
    const surface = () => {
      const c = document.createElement('canvas'); c.width = W; c.height = H
      const g = c.getContext('2d')!
      g.translate(W / 2, H / 2)
      g.fillStyle = '#000000'
      return g
    }
    const compare = (a: CanvasRenderingContext2D, b: CanvasRenderingContext2D) => {
      const da = a.getImageData(0, 0, W, H).data, db = b.getImageData(0, 0, W, H).data
      let over8 = 0, worst = 0
      for (let i = 3; i < da.length; i += 4) {   // alpha channel: the silhouette itself
        const d = Math.abs(da[i]! - db[i]!)
        if (d > worst) worst = d
        if (d > 8) over8++
      }
      return { over8, worst }
    }
    const out: Record<string, { over8: number; worst: number }> = {}

    // Rounded rect, four different radii — the general case, not the uniform one.
    const radii: [number, number, number, number] = [30, 8, 0, 55]
    const rw = 240, rh = 160
    const prim = surface()
    prim.beginPath(); prim.roundRect(-rw / 2, -rh / 2, rw, rh, radii); prim.fill()
    const viaPath = surface()
    viaPath.fill(new Path2D(mod.roundedRectPathData(-rw / 2, -rh / 2, rw, rh, ...radii)))
    out.roundedRect = compare(prim, viaPath)

    // Ellipse.
    const ex = 150, ey = 90
    const eprim = surface()
    eprim.beginPath(); eprim.ellipse(0, 0, ex, ey, 0, 0, Math.PI * 2); eprim.fill()
    const evia = surface()
    evia.fill(new Path2D(mod.ellipsePathData(ex, ey)))
    out.ellipse = compare(eprim, evia)

    // A CONTROL: the same rect one pixel wider must NOT compare clean, so a comparison
    // that cannot fail (both canvases blank, say) is caught here rather than believed.
    const off = surface()
    off.beginPath(); off.roundRect(-rw / 2, -rh / 2, rw + 1, rh, radii); off.fill()
    out.control = compare(prim, off)
    return out
  })
  // The control proves the comparison can see a one-pixel difference at all.
  expect(diffs.control.over8, `control: a 1px-wider rect must differ (got ${JSON.stringify(diffs.control)})`)
    .toBeGreaterThan(100)
  // Same geometry, same rasteriser, same primitive (`A` in the path data IS an elliptical
  // arc): the two silhouettes must be identical, not merely close.
  expect(diffs.roundedRect, 'rounded rect path vs ctx.roundRect').toEqual({ over8: 0, worst: 0 })
  expect(diffs.ellipse, 'ellipse path vs ctx.ellipse').toEqual({ over8: 0, worst: 0 })
})

/**
 * Count the separate blobs of `channel`-coloured ink on the stack canvas — one per MARK.
 *
 * Not a ring walk: a library mark is generally concave (a `sparkle` is four arms round a
 * hub), so a circle drawn through the marks crosses a single one two or three times.
 * Measured on a real render before this was written — the ring walk read 25 for a stroke
 * that a connected-component count showed to be exactly 10 marks of 66-76 px each, plus
 * ten 1-px antialiasing specks off the arm tips. `minArea` drops those specks; every real
 * mark here is an order of magnitude bigger.
 */
async function inkBlobs(page: Page, channel: keyof typeof CH, minArea = 20): Promise<number> {
  return page.evaluate(({ channel, minArea }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const W = cv.width, H = cv.height
    const d = cv.getContext('2d')!.getImageData(0, 0, W, H).data
    const test = ({
      red: (r: number, g: number, b: number, a: number) => r > 170 && g < 90 && b < 90 && a > 150,
      green: (r: number, g: number, b: number, a: number) => g > 170 && r < 90 && b < 90 && a > 150,
      blue: (r: number, g: number, b: number, a: number) => b > 170 && r < 90 && g < 90 && a > 150,
      black: (r: number, g: number, b: number, a: number) => r < 70 && g < 70 && b < 70 && a > 150,
    } as Record<string, (r: number, g: number, b: number, a: number) => boolean>)[channel]!
    const on = new Uint8Array(W * H)
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      if (test(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!)) on[p] = 1
    }
    const seen = new Uint8Array(W * H)
    const stack: number[] = []
    let blobs = 0
    for (let p0 = 0; p0 < W * H; p0++) {
      if (!on[p0] || seen[p0]) continue
      let area = 0
      stack.length = 0; stack.push(p0); seen[p0] = 1
      while (stack.length) {
        const q = stack.pop()!
        area++
        const x = q % W, y = (q / W) | 0
        if (x > 0 && on[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack.push(q - 1) }
        if (x < W - 1 && on[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack.push(q + 1) }
        if (y > 0 && on[q - W] && !seen[q - W]) { seen[q - W] = 1; stack.push(q - W) }
        if (y < H - 1 && on[q + W] && !seen[q + W]) { seen[q + W] = 1; stack.push(q + W) }
      }
      if (area >= minArea) blobs++
    }
    return blobs
  }, { channel, minArea })
}

test('a shapes stroke puts the expected number of marks around a circle', async ({ page }) => {
  await openCompositor(page)
  // A circle of radius 0.2 has a circumference of 2π·0.2 ≈ 1.2566 (width-normalized), so a
  // spacing of 0.12 asks for 10.47 marks. `shapePlacements` rounds a CLOSED guide to
  // round(10.47) = 10 and then spreads them evenly, so there is no seam gap.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls),
    shapesCircle({ paint: '#ff0000', shapeId: 'sparkle', size: 0.04, spacing: 0.12 }))
  await stackPixels(page)
  expect(await inkBlobs(page, 'red')).toBe(10)

  // Halving the spacing must double the marks — the claim that the walk is by ARC LENGTH,
  // not by a fixed count. round(1.2566/0.06) = 21.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls),
    shapesCircle({ paint: '#ff0000', shapeId: 'sparkle', size: 0.04, spacing: 0.06 }))
  await stackPixels(page)
  expect(await inkBlobs(page, 'red')).toBe(21)
})

/** Centroid of the red ink, in canvas-width / canvas-height fractions, plus its pixel count. */
async function redCentroid(page: Page): Promise<{ x: number; y: number; n: number; w: number }> {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const g = cv.getContext('2d')!
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    let sx = 0, sy = 0, n = 0
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4
        if (d[i]! > 170 && d[i + 1]! < 90 && d[i + 2]! < 90 && d[i + 3]! > 150) { sx += x; sy += y; n++ }
      }
    }
    return { x: n ? sx / n / cv.width : 0, y: n ? sy / n / cv.height : 0, n, w: cv.width }
  })
}

/**
 * FOLLOW ON vs FOLLOW OFF, read from a quantity that is OPPOSITE for the two.
 *
 * The mark is `triangle` — apex at the top of its ink box, flat base at the bottom — so its
 * ink centroid sits BELOW its own centre by a third of its height. On a circle:
 *
 *   follow OFF  every mark is upright, so every one of those offsets points DOWN and they
 *               sum: the ink centroid of the whole stroke sits below the circle's centre.
 *   follow ON   a mark's local up-axis rotates to the outward radial direction (rotating
 *               (0,-1) by the tangent angle θ+90° gives (cos θ, sin θ)), so each offset
 *               points INWARD along its own radius — and over evenly spaced marks those
 *               cancel: the ink centroid lands back on the circle's centre.
 *
 * Neither half can be passed by the other implementation: one that always rotates fails the
 * "sits below" claim, one that never rotates fails the "lands on centre" claim. A symmetric
 * mark would make both readings zero, which is why the shape has to be asymmetric.
 */
test('follow off leaves every mark upright; follow on turns each one to the edge', async ({ page }) => {
  await openCompositor(page)
  const SIZE = 0.08
  const cfg = { paint: '#ff0000', shapeId: 'triangle', size: SIZE, spacing: 0.12 }

  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), shapesCircle({ ...cfg, follow: true }))
  await stackPixels(page)
  const on = await redCentroid(page)

  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), shapesCircle({ ...cfg, follow: false }))
  await stackPixels(page)
  const off = await redCentroid(page)

  expect(on.n, 'the follow:true render must actually draw marks').toBeGreaterThan(500)
  expect(off.n, 'the follow:false render must actually draw marks').toBeGreaterThan(500)

  // `triangle`'s ink box is 88 × 76 in manifest units and `drawShape`'s fit scales by the
  // SMALLER ratio, so a mark is 76·size/88 tall. A triangle's centroid is a third of the
  // height up from its base, i.e. a SIXTH of the height below the box centre:
  // 76/(6·88) = 0.1439 of `size`. In canvas-HEIGHT fractions (the canvas is square here —
  // see the geometry note above) that is the same number. Measured at 0.0103 against a
  // predicted 0.0115 for size 0.08: the strict red predicate drops the antialiased edge
  // pixels, which a triangle has proportionally more of near its tip, hence the ±40% band
  // rather than an equality.
  const expected = (76 / (6 * 88)) * SIZE

  // Upright: the whole stroke's ink hangs below centre by that amount.
  expect(off.y - 0.5, `follow:false ink centroid should sit ~${expected.toFixed(4)} below centre`)
    .toBeGreaterThan(expected * 0.6)
  expect(off.y - 0.5).toBeLessThan(expected * 1.4)
  expect(Math.abs(off.x - 0.5), 'and dead centre horizontally').toBeLessThan(expected * 0.25)

  // Turned to the edge: the per-mark offsets are radial and cancel.
  expect(Math.abs(on.y - 0.5), 'follow:true offsets are radial and must cancel').toBeLessThan(expected * 0.25)
  expect(Math.abs(on.x - 0.5)).toBeLessThan(expected * 0.25)
})

/**
 * THE STROKE'S OWN PAINT — the trap this feature has already sprung once.
 *
 * A `Paint` of `{ type: 'gradient', … }` is NOT a gradient: `isGradient` in
 * lib/compositor/paint.ts accepts only 'linear' and 'radial', so an invented discriminant
 * falls through every branch, reaches `fillStyle` as an object and paints DEFAULT BLACK —
 * silently, and looking plausible. So both halves below assert the colour that was asked
 * for AND that no black ink exists anywhere on the canvas.
 */
test("a shapes stroke takes the stroke's paint, not a hardcoded colour", async ({ page }) => {
  await openCompositor(page)
  const noBlack = () => page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! < 70 && d[i + 1]! < 70 && d[i + 2]! < 70 && d[i + 3]! > 150) n++
    }
    return n
  })

  // 1. A solid colour: green marks, no red, no black.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls),
    shapesCircle({ paint: '#00ff00', shapeId: 'sparkle', size: 0.04, spacing: 0.12 }))
  await stackPixels(page)
  expect(await inkBlobs(page, 'green')).toBe(10)
  expect(await inkBlobs(page, 'red', 1), 'nothing red — the paint is green').toBe(0)
  expect(await noBlack(), 'no default-black ink anywhere').toBe(0)

  // 2. A real GRADIENT (`type: 'linear'`, the tag `isGradient` actually accepts). The marks
  //    are filled as ONE path in the layer's space, so the gradient runs across the whole
  //    stroke — red marks on one side, blue on the other — rather than being squeezed into
  //    each individual mark.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), shapesCircle({
    paint: { type: 'linear', angle: 0, stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 1 }] },
    shapeId: 'sparkle', size: 0.05, spacing: 0.12,
  }))
  await stackPixels(page)
  expect(await noBlack(), 'a valid linear gradient must not fall through to black').toBe(0)
  //    Probing a fixed point would be a guess about where a mark happens to land (with 10
  //    marks starting at the top of the ring, none sits at 3 or 9 o'clock), so the reading
  //    is taken over ALL the ink: the mean x of the red-leaning pixels against the mean x
  //    of the blue-leaning ones.
  const ends = await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    let rx = 0, rn = 0, bx = 0, bn = 0
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4
        if (d[i + 3]! < 150) continue
        if (d[i]! - d[i + 2]! > 40) { rx += x; rn++ }
        else if (d[i + 2]! - d[i]! > 40) { bx += x; bn++ }
      }
    }
    return { redX: rn ? rx / rn / cv.width : -1, redN: rn, blueX: bn ? bx / bn / cv.width : -1, blueN: bn }
  })
  expect(ends.redN, 'the red end of the gradient must reach ink').toBeGreaterThan(200)
  expect(ends.blueN, 'and so must the blue end').toBeGreaterThan(200)
  //    A separation of more than half the ring's diameter (0.4) can only come from ONE
  //    gradient laid across the whole stroke; a gradient re-created inside each 0.05-wide
  //    mark would separate the two centroids by a fraction of a mark, not by this.
  expect(ends.blueX - ends.redX, 'the gradient must run across the STROKE, not inside each mark')
    .toBeGreaterThan(0.2)
})

/**
 * A POLYGON'S MARKS SIT ON THE EDGE AS DRAWN — the pixel guard for the one real defect the
 * brief's design would have shipped.
 *
 * `shapeStrokeGuide` builds its guide through `guideFromPolyline`, which RE-CENTRES its
 * input on the polyline's own bounding-box midpoint. That is a no-op for a rect, an ellipse
 * and any bbox-centred path — so every test above would pass either way — but it is NOT a
 * no-op for `polygonPathData`'s output: a pentagon of radius r spans y ∈ [-r, 0.809r], so
 * its bbox midpoint is 0.0955·r above the origin it is drawn around. `shapeStrokeGuideFit`
 * hands that midpoint back and the painter adds it in again.
 *
 * The two probes flip under the bug, which is what makes them assertions:
 *   at the apex        marks: 0.15 ± 0.02 → INK.       without the fix the mark has moved
 *                                                       down to 0.1834 ± 0.02 → no ink.
 *   0.04 below it      marks: outside the apex mark → NO ink.  without the fix 0.19 is
 *                                                       3.6 px from that mark's centre → ink.
 * This test also covers the whole polygon/star/path arm, which reaches `paintStrokeStack`
 * through `drawPath` with `widthScale: 1` and its outline already in `d`.
 */
test("a polygon's shapes stroke marches the edge as DRAWN, not its bounding-box centre", async ({ page }) => {
  await openCompositor(page)
  // r = 0.35, so the apex is at y = 0.5 − 0.35 = 0.15 and the bbox shift would be 0.0334
  // (18 px on this 542 px canvas) — far larger than either probe's own tolerance.
  // `follow: false` keeps each mark upright so its vertical extent is exactly ±size/2.
  // A perimeter of 5·2·0.35·sin 36° = 2.057 at spacing 0.2 gives 10 marks, the next one
  // half an edge away from the apex — nowhere near either probe.
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'p', kind: 'polygon', x: 0.5, y: 0.5, w: 0.7, h: 0.7, sides: 5, cornerRadius: 0,
    rotation: 0, opacity: 1, visible: true, fill: 'none',
    strokes: [{
      id: 's1', paint: '#ff0000', width: 0.004, distance: 0, style: 'shapes',
      shapes: { shapeId: 'sparkle', size: 0.04, spacing: 0.2, follow: false },
    }],
  }]))
  await stackPixels(page)
  const isRed = (p: number[]) => p[0]! > 170 && p[1]! < 90 && p[2]! < 90 && p[3]! > 150
  expect(await inkBlobs(page, 'red'), 'ten marks round the pentagon').toBe(10)
  expect(isRed(await pixelAt(page, 0.5, 0.15)), 'a mark sits ON the drawn apex').toBe(true)
  expect(isRed(await pixelAt(page, 0.5, 0.19)), 'and not 18 px below it').toBe(false)
})

/**
 * FINDING 1 (Task 6 review) — a shapes stroke with no `shapes` payload must paint NOTHING,
 * never a band.
 *
 * `style: 'shapes'` with a missing `shapes` object is exactly what an inspector writing
 * `style` and `shapes` in two separate patches (or any older writer) can produce for one
 * frame. `width` is left at a real, non-zero value on purpose — a leftover band width the
 * row still carries from before it became a shapes stroke — because the bug this guards
 * against is that leftover `width` reaching `paintStrokeBand` and painting a full band
 * around the rect once `shapes` falls through as falsy.
 */
test('a shapes stroke with no shapes payload paints nothing, not a band', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, rotation: 0, opacity: 1, visible: true,
    fill: 'none', radius: 0,
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.05, style: 'shapes' }],
  }]))
  await stackPixels(page)
  expect(await inkBlobs(page, 'red', 1), 'no red ink anywhere — no band, no marks').toBe(0)
})

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 9 — THE SAME FEATURE, DRIVEN AS A USER DRIVES IT.
//
// Everything above seeds `__compositorSetLayers` and reads pixels back. That proves the
// PAINTER, and it proved two Criticals' fixes as pure logic — but not one of those seeds
// ever passed through the toolbar, the plus menu, the tree row or the inspector, and both
// Criticals in this feature were "the stored array silently collapses to one entry", which
// is a UI-path failure by definition. These cases add the missing half: real clicks, real
// HTML5 drags, real keys, and every assertion read back off `__compositorLayers()` — the
// stored document — rather than off the thing that was just typed in.
// ═══════════════════════════════════════════════════════════════════════════════

/** The stored layers, exactly as the document holds them. */
const storedLayers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers())
/** One stored layer's stroke ids, or null when it stores no array at all. */
const storedStrokeIds = async (page: Page, layerId?: string) => {
  const ls = await storedLayers(page)
  const l = layerId ? ls.find((x: any) => x.id === layerId) : ls[0]
  return Array.isArray(l?.strokes) ? l.strokes.map((s: any) => s.id) : null
}

/** Add a rect the way a user does: the toolbar's Shapes menu. NOT `__compositorSetLayers` —
 *  a seeded layer never exercises `addLocal`, which is what selects the layer and puts a
 *  history step under everything that follows. */
async function addRectFromToolbar(page: Page): Promise<string> {
  await page.locator('[data-testid="shapes-menu-toggle"]').click()
  await page.locator('[data-testid="shapes-menu-rect"]').click()
  await expect.poll(async () => (await storedLayers(page)).length, { timeout: 10_000 }).toBeGreaterThan(0)
  const ls = await storedLayers(page)
  return ls[ls.length - 1].id
}

/** "Add outline" from the layer row's plus menu, for real: hover the row so the plus is on
 *  screen, click it, click the entry. */
async function addOutlineFromPlusMenu(page: Page) {
  const before = await page.locator('[data-testid="stroke-row"]').count()
  const plus = page.locator('[data-testid="add-effect"]').first()
  await plus.click({ force: true })
  await page.locator('[data-testid="add-stroke"]').click()
  await expect(page.locator('[data-testid="stroke-row"]')).toHaveCount(before + 1)
}

test('the tree flow: toolbar rect, three outlines from the plus menu, and they all stay', async ({ page }) => {
  await openCompositor(page)
  const rectId = await addRectFromToolbar(page)
  expect((await storedLayers(page)).find((l: any) => l.id === rectId).kind).toBe('rect')

  for (let i = 0; i < 3; i++) await addOutlineFromPlusMenu(page)
  await expect(page.locator('[data-testid="stroke-row"]')).toHaveCount(3)
  const ids = await storedStrokeIds(page, rectId)
  expect(ids, 'three distinct stored strokes, not one that kept being overwritten').toHaveLength(3)
  expect(new Set(ids).size).toBe(3)
})

/**
 * EDIT THE SECOND ROW, THEN TAKE IT BACK.
 *
 * Two claims, and the second is the one that is easy to write vacuously: an undo case that
 * never made the pixels move in the first place passes for free. So the edit is asserted to
 * CHANGE the canvas before the undo is asserted to restore it, and both comparisons are the
 * settled data-URL of the real stack canvas — byte for byte, not "looks close".
 */
test('editing the second outline moves pixels, and one undo puts them back exactly', async ({ page }) => {
  await openCompositor(page)
  const rectId = await addRectFromToolbar(page)
  for (let i = 0; i < 3; i++) await addOutlineFromPlusMenu(page)

  const before = await stackPixels(page)
  expect(before).toBeTruthy()
  const idsBefore = await storedStrokeIds(page, rectId)

  // The SECOND row — the one a `stack[0]`-reading inspector would silently edit instead.
  await page.locator('[data-testid="stroke-row"]').nth(1).click()
  await expect(page.locator('[data-testid="stroke-inspector"]')).toBeVisible()
  await page.locator('[data-stroke-distance]').fill('40')

  await expect.poll(async () => {
    const ls = await storedLayers(page)
    return ls.find((l: any) => l.id === rectId).strokes[1].distance
  }, { timeout: 10_000 }).toBeGreaterThan(0)
  // …and ONLY the second: the other two must still be on the edge.
  const after = await storedLayers(page)
  const st = after.find((l: any) => l.id === rectId).strokes
  expect(st.map((s: any) => s.distance ?? 0).map((d: number) => d > 0)).toEqual([false, true, false])
  expect(st.map((s: any) => s.id)).toEqual(idsBefore)

  const moved = await stackPixels(page)
  expect(moved, 'the edit reached the canvas — without this the undo half is vacuous').not.toBe(before)

  await page.keyboard.press('Meta+z')
  await expect.poll(async () => {
    const ls = await storedLayers(page)
    return ls.find((l: any) => l.id === rectId)?.strokes?.[1]?.distance ?? 0
  }, { timeout: 10_000 }).toBe(0)
  expect(await stackPixels(page), 'one undo restores the frame byte for byte').toBe(before)
})

/**
 * REORDER BY A REAL HTML5 DRAG.
 *
 * `locator.dragTo` drives the mouse through CDP, so Chromium's own drag machinery raises
 * `dragstart` / `dragover` / `drop` — the row's handlers, the modal's `strokeDragFrom`
 * state and `reorderStroke`'s read-`to`-before-splice all run for real. A
 * `dispatchEvent('drop')` would prove none of that, which is the lesson the pen hand-off
 * left behind.
 */
test('dragging the third outline onto the first reorders the stored array', async ({ page }) => {
  await openCompositor(page)
  const rectId = await addRectFromToolbar(page)
  for (let i = 0; i < 3; i++) await addOutlineFromPlusMenu(page)
  const [a, b, c] = (await storedStrokeIds(page, rectId))!

  const rows = page.locator('[data-testid="stroke-row"]')
  await rows.nth(2).dragTo(rows.nth(0))
  await expect.poll(() => storedStrokeIds(page, rectId), { timeout: 10_000 }).toEqual([c, a, b])

  // …and BACK, forwards. Both directions on purpose: `reorderStroke` reads its destination
  // index before the splice, and a version that reads it after is correct for every
  // backward drag and silently one short for every forward one — so a backward-only case
  // passes with the bug in place. (It did: this half was added after the mutation run.)
  await rows.nth(0).dragTo(rows.nth(2))
  await expect.poll(() => storedStrokeIds(page, rectId), { timeout: 10_000 }).toEqual([a, b, c])
})

/**
 * BACKSPACE ON A STROKE ROW.
 *
 * A stroke row is a pseudo-child of its layer, exactly like an effect row — and the modal's
 * Delete/Backspace handler falls through to `deleteLocal(selectedLocalId)` for anything it
 * does not claim first. The layer must survive.
 */
test('Backspace on a selected outline removes THAT OUTLINE, never the layer', async ({ page }) => {
  await openCompositor(page)
  const rectId = await addRectFromToolbar(page)
  for (let i = 0; i < 2; i++) await addOutlineFromPlusMenu(page)
  const [a, b] = (await storedStrokeIds(page, rectId))!

  await page.locator('[data-testid="stroke-row"]').nth(1).click()
  await expect(page.locator('[data-testid="stroke-inspector"]')).toBeVisible()
  await page.keyboard.press('Backspace')

  await expect.poll(async () => (await storedLayers(page)).map((l: any) => l.id), { timeout: 10_000 })
    .toEqual([rectId])
  expect(await storedStrokeIds(page, rectId), 'the selected outline went, the other stayed').toEqual([a])
  expect(b).toBeTruthy()
})

/** The row is reachable and operable from the keyboard alone — `tabindex="0"` plus the
 *  Enter handler, asserted by WALKING the tab order rather than calling `.focus()`. */
test('Tab reaches a stroke row and Enter selects it', async ({ page }) => {
  await openCompositor(page)
  await addRectFromToolbar(page)
  await addOutlineFromPlusMenu(page)
  // Start from the disclosure chevron on the layer row — the focusable immediately before
  // the stroke rows in document order.
  await page.locator('[data-testid="layer-fx-toggle"]').first().focus()
  await page.locator('[data-testid="stroke-row"]').first().click()
  await page.locator('[data-testid="stroke-breadcrumb"] button').click()   // drop the selection
  await expect(page.locator('[data-testid="stroke-inspector"]')).toHaveCount(0)
  await page.locator('[data-testid="layer-fx-toggle"]').first().focus()

  let hops = 0
  for (; hops < 20; hops++) {
    await page.keyboard.press('Tab')
    const onRow = await page.evaluate(() =>
      !!(document.activeElement as HTMLElement | null)?.matches('[data-testid="stroke-row"]'))
    if (onRow) break
  }
  expect(hops, 'a stroke row is in the tab order').toBeLessThan(20)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="stroke-inspector"]')).toBeVisible()
})

/**
 * STEP 2 — REACH THROUGH A CORNER PIN.
 *
 * A corner-pinned layer is drawn into its OWN offscreen canvas, sized from `localLayerBox`
 * — which is the shape's plain w×h and knows nothing about strokes. A stroke pushed out by
 * a `distance` lands entirely beyond that box, so without `cornerPinPadPx` growing the
 * offscreen (and the quad it warps into) the band is 100% clipped and simply is not there.
 *
 * The layer is stroke-only (`fill: 'none'`), so every red pixel on the canvas IS the band:
 * the count going to zero is not a subtle shift, it is the whole outline disappearing. The
 * second assertion is the one that says "reach", not merely "present": the band's right
 * extent must sit past the shape's own edge at x = 0.65.
 */
async function redBounds(page: Page): Promise<{ count: number; maxX: number; minX: number }> {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const W = cv.width, H = cv.height
    const d = cv.getContext('2d')!.getImageData(0, 0, W, H).data
    let count = 0, maxX = -1, minX = W
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (d[i]! > 170 && d[i + 1]! < 90 && d[i + 2]! < 90 && d[i + 3]! > 150) {
        count++; if (x > maxX) maxX = x; if (x < minX) minX = x
      }
    }
    return { count, maxX: maxX / W, minX: minX / W }
  })
}

test('a distant stroke survives a corner pin — the offscreen grows to its reach', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'cp', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, radius: 0,
    rotation: 0, opacity: 1, visible: true, fill: 'none',
    // Only the top-left corner is pulled, so the right-hand side of the quad is unwarped
    // and the band's outer edge lands where the geometry says it should.
    cornerPin: { tl: { x: 0.06, y: 0.06 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } },
    strokes: [{ id: 's1', paint: '#ff0000', width: 0.01, distance: 0.12, align: 'center', join: 'sharp' }],
  }]))
  await stackPixels(page)
  const b = await redBounds(page)
  // The band's centre line is 0.15 + 0.12 = 0.27 from the shape centre; its outer edge is
  // 0.275. Clipped to the unpadded box it would be gone entirely (count 0).
  expect(b.count, 'the whole band is on the canvas, not clipped away').toBeGreaterThan(400)
  expect(b.maxX, "the band's OUTER edge reaches past the shape's own edge at 0.65").toBeGreaterThan(0.74)
})

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3 — THE NO-MIGRATE PROMISE, LIVE.
//
// The whole design rests on one claim: opening a saved frame CHANGES NOTHING, and the new
// shape appears only on the first edit, with the legacy fields cleared in that same step.
// Every unit test asserts the pure functions that would implement that. None of them can
// see whether merely mounting the modal, expanding the disclosure and selecting the row
// leaves the document alone — which is the half a user actually does first.
// ═══════════════════════════════════════════════════════════════════════════════

/** A rect that stores its one stroke in TODAY'S shape. Stroke-only, so its ink is countable. */
const legacyRect = (id: string) => ({
  id, kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, radius: 0,
  rotation: 0, opacity: 1, visible: true, fill: 'none',
  stroke: '#ff0000', strokeWidth: 0.02,
})

/** Seed a legacy layer and open its disclosure — READS only, no edit. */
async function openLegacyRect(page: Page, id = 'lg') {
  await page.evaluate(l => (window as any).__compositorSetLayers([l]), legacyRect(id))
  await page.locator('[data-testid="layer-fx-toggle"]').first().click()
  await expect(page.locator('[data-testid="stroke-row"]')).toHaveCount(1)
}

/** The inspector shows sizes in true output px. Recover that scale from a stroke whose
 *  stored width is known, rather than hardcoding a frame size this suite does not own. */
async function panelOutWidth(page: Page, storedWidth: number): Promise<number> {
  const px = Number(await page.locator('[data-stroke-width]').inputValue())
  expect(px).toBeGreaterThan(0)
  return px / storedWidth
}

test('opening a legacy-stroked layer changes NOTHING; the first edit swaps the shape in one step', async ({ page }) => {
  await openCompositor(page)
  await openLegacyRect(page)

  // (a) Reading it — mounting, expanding, selecting — must not write.
  await page.locator('[data-testid="stroke-row"]').first().click()
  await expect(page.locator('[data-testid="stroke-inspector"]')).toBeVisible()
  const onOpen = (await storedLayers(page))[0]
  expect(onOpen.strokes, 'no `strokes` array is stored until an edit is made').toBeUndefined()
  expect(onOpen.stroke).toBe('#ff0000')
  expect(onOpen.strokeWidth).toBe(0.02)

  // (b) …and the row it read through is labelled with that stroke's own width, in the same
  //     px the inspector's Width field shows.
  const W = await panelOutWidth(page, 0.02)
  await expect(page.locator('[data-testid="stroke-row"]').first())
    .toHaveText(new RegExp(`^${Math.round(0.02 * W)} px$`))

  const legacyPixels = await stackPixels(page)

  // (c) ONE edit, ONE step: the list appears, the legacy pair is cleared in the same patch,
  //     and the synthesised reading-time id never reaches storage.
  await page.locator('[data-stroke-distance]').fill(String(Math.round(0.1 * W)))
  await expect.poll(async () => (await storedLayers(page))[0].strokes?.length, { timeout: 10_000 }).toBe(1)
  const after = (await storedLayers(page))[0]
  expect(after.stroke, 'the legacy paint is cleared in the SAME patch').toBeUndefined()
  expect(after.strokeWidth).toBeUndefined()
  expect(after.strokes[0].id).not.toBe('legacy')
  expect(after.strokes[0].width).toBe(0.02)
  expect(after.strokes[0].distance).toBeGreaterThan(0)

  // (d) "One step" is a claim about history, so spend one undo on it.
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await storedLayers(page))[0].strokes, { timeout: 10_000 }).toBeUndefined()
  expect((await storedLayers(page))[0].stroke).toBe('#ff0000')
  expect(await stackPixels(page), 'and the frame is back to the pixels it opened with').toBe(legacyPixels)
})

/**
 * THE TWO CRITICALS, THROUGH THE REAL UI.
 *
 * Task 7's: making one entry inkless dropped the WHOLE array down the legacy branch.
 * Task 8's: adding a stroke to a legacy layer stored the synthesised `id: 'legacy'`, so the
 * next edit's `layerStoresStrokeStack` said "no list" and wrote the legacy pair back over
 * the array — deleting the addition.
 *
 * Both are fixed, both are unit-covered, and neither had ever been walked: legacy layer →
 * plus-menu → edit the FIRST row. The render half is asserted with the rows' own eye
 * buttons rather than a colour probe: hiding a stroke must move pixels, which is the only
 * colour-agnostic way to say "this entry is actually being painted".
 */
test('legacy layer + a second outline + editing the first: both survive and both paint', async ({ page }) => {
  await openCompositor(page)
  await openLegacyRect(page, 'crit')
  await page.locator('[data-testid="stroke-row"]').first().click()
  const W = await panelOutWidth(page, 0.02)

  // Add through the plus menu. The fresh stroke is appended and auto-selected.
  await addOutlineFromPlusMenu(page)
  const ids = (await storedStrokeIds(page, 'crit'))!
  expect(ids, 'the addition did NOT collapse the array to one entry').toHaveLength(2)
  expect(ids).not.toContain('legacy')
  const stored = (await storedLayers(page))[0]
  expect(stored.stroke, 'and the legacy fields went with the same patch').toBeUndefined()
  expect(stored.strokeWidth).toBeUndefined()

  // Push the new one out so the two bands do not sit on top of each other.
  await page.locator('[data-stroke-distance]').fill(String(Math.round(0.1 * W)))
  await expect.poll(async () => (await storedLayers(page))[0].strokes[1].distance, { timeout: 10_000 })
    .toBeGreaterThan(0)

  // Now edit the FIRST row — the one that used to be the legacy stroke. This is the exact
  // sequence that used to write the legacy pair back and delete the second entry.
  await page.locator('[data-testid="stroke-row"]').first().click()
  await page.locator('[data-stroke-width]').fill(String(Math.round(0.035 * W)))
  await expect.poll(async () => (await storedLayers(page))[0].strokes[0].width, { timeout: 10_000 })
    .toBeGreaterThan(0.02)

  const survivors = (await storedLayers(page))[0]
  expect(survivors.strokes.map((s: any) => s.id), 'BOTH strokes are still there, in order').toEqual(ids)
  expect(survivors.stroke).toBeUndefined()
  await expect(page.locator('[data-testid="stroke-row"]')).toHaveCount(2)

  // …and both are being painted. Hiding one must change the canvas; showing it must put it
  // back exactly.
  const both = await stackPixels(page)
  for (const n of [0, 1]) {
    const row = page.locator('[data-testid="stroke-row"]').nth(n)
    await row.getByRole('button', { name: 'Hide outline' }).click()
    expect(await stackPixels(page), `outline ${n + 1} is on the canvas`).not.toBe(both)
    await row.getByRole('button', { name: 'Show outline' }).click()
    expect(await stackPixels(page)).toBe(both)
  }
})

/**
 * TASK 7'S CRITICAL, THROUGH THE REAL UI — one inkless entry must not take the array with it.
 *
 * The Colour row is `<FillControl allow-none>`, so "Remove" is one click away and produces a
 * perfectly legal stroke that simply paints nothing. `storedStrokeEntries` used to decide
 * an array was trustworthy by its INK as well as its shape, so that one click dropped the
 * WHOLE array down the legacy branch: every row vanished from the tree, the inspector
 * closed, the painter drew no outline at all, and the next "Add outline" wrote over the
 * survivors. Unit-fixed and unit-covered — never once clicked.
 */
test('removing ONE outline colour leaves the other outlines alone', async ({ page }) => {
  await openCompositor(page)
  const rectId = await addRectFromToolbar(page)
  for (let i = 0; i < 3; i++) await addOutlineFromPlusMenu(page)
  const ids = (await storedStrokeIds(page, rectId))!
  expect(ids).toHaveLength(3)

  // Give the three different distances so the survivors are individually visible.
  const rows = page.locator('[data-testid="stroke-row"]')
  await rows.nth(0).click()
  const W = await panelOutWidth(page, 0.005)
  for (const [i, d] of [[1, 0.06], [2, 0.12]] as const) {
    await rows.nth(i).click()
    await page.locator('[data-stroke-distance]').fill(String(Math.round(d * W)))
  }
  await stackPixels(page)

  // Now take the colour off the MIDDLE one.
  await rows.nth(1).click()
  await page.locator('[data-testid="stroke-inspector"] button[title="Remove"]').click()

  await expect.poll(() => storedStrokeIds(page, rectId), { timeout: 10_000 }).toEqual(ids)
  await expect(rows, 'all three rows are still in the tree').toHaveCount(3)
  await expect(page.locator('[data-testid="stroke-inspector"]'), 'and the inspector stays open').toBeVisible()
  const st = (await storedLayers(page))[0].strokes
  expect(st[1].paint, 'the middle stroke really is inkless now').toMatch(/^(none|)$/)
  expect(st[0].paint).not.toMatch(/^(none|)$/)
  expect(st[2].paint).not.toMatch(/^(none|)$/)
  // …and the two that kept their colour are still on the canvas: hiding one must move pixels.
  const both = await stackPixels(page)
  for (const n of [0, 2]) {
    await rows.nth(n).getByRole('button', { name: 'Hide outline' }).click()
    expect(await stackPixels(page), `outline ${n + 1} still paints`).not.toBe(both)
    await rows.nth(n).getByRole('button', { name: 'Show outline' }).click()
  }
})

/**
 * THE THIRD SILENT COLLAPSE — found by this pass, in a control the feature never touched.
 *
 * The LAYER inspector (the panel you get with no stroke row selected) still carries the
 * pre-stack "Stroke" section, and it writes the LEGACY pair straight onto the layer. On a
 * layer that stores a stack that is not an edit, it is a takeover: `strokeStackOf` treats a
 * live legacy field as the trustworthy one and ignores the whole array. One click on that
 * section's Add took a rect from three outlines to one — three rows gone from the tree, three
 * bands gone from the canvas — with the array still sitting untouched in the document, one
 * stroke-row edit away from being overwritten for good.
 *
 * The section is only meaningful for a layer with no stored stack (where it is still the
 * front door for a first outline and reads through exactly as before), so that is where it
 * now lives.
 */
test('the layer panel cannot clobber a stored stack with the legacy stroke fields', async ({ page }) => {
  await openCompositor(page)
  const rectId = await addRectFromToolbar(page)

  // Before any outline exists the legacy section is the front door and must still be there.
  await page.locator('[data-testid="layer-thumb"]').first().click()
  await expect(page.locator('[data-testid="legacy-stroke-section"]')).toBeVisible()

  for (let i = 0; i < 3; i++) await addOutlineFromPlusMenu(page)
  const ids = (await storedStrokeIds(page, rectId))!
  expect(ids).toHaveLength(3)
  const three = await stackPixels(page)

  // Now the layer stores a stack, and the section that would overwrite it is gone.
  await page.locator('[data-testid="layer-thumb"]').first().click()
  await expect(page.locator('[data-testid="stroke-inspector"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="legacy-stroke-section"]'),
    'the pre-stack Stroke section is not offered on a layer that stores a stack').toHaveCount(0)

  // Nothing the layer panel still offers may put a live legacy stroke on the layer either.
  for (const b of await page.locator('.inspector-body button[title="Add a fill"]').all()) await b.click()
  const l = (await storedLayers(page))[0]
  expect(l.stroke ?? 'none', 'no legacy stroke paint was written').toMatch(/^(none|)$/)
  await expect(page.locator('[data-testid="stroke-row"]'), 'all three outlines are still in the tree').toHaveCount(3)
  expect(await storedStrokeIds(page, rectId)).toEqual(ids)
  expect(await stackPixels(page), 'and still on the canvas').toBe(three)
})

// ═══════════════════════════════════════════════════════════════════════════════
// WOBBLE — A WAVY OR ZIGZAG OUTLINE, MEASURED IN A REAL BROWSER (Task 4 of the
// wavy/zigzag feature; spec docs/superpowers/specs/2026-09-07-frame-stroke-wobble-design.md).
//
// THE FIXTURE IS A RECTANGLE, AND THAT IS THE WHOLE POINT. The flattener only emits a point
// where a curve needs one, so a rect's outline arrives as its FOUR corners and its edge as
// two points — you cannot put a wave in the middle of a two-point edge. A wobble applied
// without resampling first looks perfectly correct on a circle (hundreds of flatten points
// already) and does NOTHING on every rect, polygon and star. A test written with a circle
// would therefore pass over a completely broken feature. Every case below uses a rect.
//
// GEOMETRY, derived once and reused (every number is recomputed from `cv.width`/`cv.height`
// at run time — the values quoted are what this suite's 542x542 canvas makes of them):
//
//   * A rect layer's outline is `roundedRectPathData(-w/2, -h/2, w, h, 0,0,0,0)`, i.e.
//     `M -w/2 -h/2 L w/2 -h/2 L w/2 h/2 L -w/2 h/2 Z`. So arc length s = 0 sits at the
//     TOP-LEFT corner and runs CLOCKWISE: the top edge first, then right, bottom, left.
//     On the top edge, s is simply `x - leftEdge`.
//   * That winding has a positive shoelace, so `offsetPolyline`'s `sign` is +1 and a
//     POSITIVE displacement is OUTWARD — which on the top edge means UP (smaller y).
//   * On a straight run the angle bisector IS the edge normal and the miter `scale` is
//     exactly 1 (the two segment normals are identical, so `cos` = 1), so the displacement
//     is purely VERTICAL and the profile is exactly
//         y(x) = topEdge - (distance + amount * f((x - leftEdge) / lambda)) * W
//     with `f` = `sin` for a wave and the 0 -> 1 -> 0 -> -1 triangle for a zigzag.
//   * CLOSED-CYCLE SNAP: perimeter = 2*(w+h)*W = 1.6*W for a 0.4 x 0.4 rect. With
//     `wobbleLength` 0.1 that is `round(1.6 / 0.1)` = 16 cycles and an effective wavelength
//     of 1.6*W/16 = 0.1*W — the snap is a no-op here ON PURPOSE, so the requested
//     wavelength IS the painted one and no probe below has to model the snap as well.
//   * RESAMPLE STEP = `min(lambdaEff/16, perimeter/segCount)` = min(0.00625, 0.4)*W, so the
//     rect's four points become 256 (well under `WOBBLE_MAX_POINTS` = 4000).
//
// PROBE SPAN: s in [0.05, 0.35] of the top edge — EXACTLY THREE whole cycles at lambda 0.1,
// and 0.05*542 = 27 px clear of either corner, so no miter join is inside any reading.
// Within it the extremes are fixed by the arithmetic, not chosen:
//     peaks (max outward)  s = 0.025 + k*0.1  ->  0.125, 0.225, 0.325
//     troughs (max inward) s = 0.075 + k*0.1  ->  0.075, 0.175, 0.275
//
// RED-FIRST for every wobble case here was `offsetPolyline`'s amplitude forced to 0 — see
// the task report for the quoted output.
// ═══════════════════════════════════════════════════════════════════════════════

/** The stack canvas's own device dimensions. Nothing below assumes it is square: `w`/`h`
 *  and every stroke number are normalized to WIDTH, while a y coordinate is a device row,
 *  so the two are converted explicitly at each use. */
async function canvasDims(page: Page): Promise<{ W: number; H: number }> {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    return { W: cv.width, H: cv.height }
  })
}

/**
 * The band running along the shape's TOP edge, as one y per device COLUMN: the mean row of
 * the red ink in that column above `yLimit`. A vertical slice through a stroked band is
 * centred on the band's centre LINE whatever the band's slope, so the mean is the
 * centreline — which is the quantity `offsetPolyline` actually computes.
 *
 * `yLimit` is the shape's own top edge, so the left- and right-edge bands (and anything
 * inside the shape) cannot leak into a reading; the column range keeps the corners out.
 */
async function topEdgeBandProfile(page: Page, x0: number, x1: number, yLimit: number): Promise<(number | null)[]> {
  return page.evaluate(({ x0, x1, yLimit }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const W = cv.width, H = cv.height
    const d = cv.getContext('2d')!.getImageData(0, 0, W, H).data
    const lim = Math.max(0, Math.min(H, Math.ceil(yLimit)))
    const ys: (number | null)[] = []
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) {
      let sy = 0, n = 0
      for (let y = 0; y < lim; y++) {
        const i = (y * W + x) * 4
        if (d[i]! > 170 && d[i + 1]! < 90 && d[i + 2]! < 90 && d[i + 3]! > 150) { sy += y; n++ }
      }
      ys.push(n ? sy / n : null)
    }
    return ys
  }, { x0, x1, yLimit })
}

/** Every blob of red ink as a centroid plus its area — `inkBlobs` above, but keeping WHERE
 *  each blob is. A symmetric library mark (`circle`) puts its ink centroid exactly on the
 *  point the placement maths chose, so a centroid IS a mark position. */
async function redBlobCentroids(page: Page, minArea = 20): Promise<{ x: number; y: number; n: number }[]> {
  return page.evaluate(({ minArea }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const W = cv.width, H = cv.height
    const d = cv.getContext('2d')!.getImageData(0, 0, W, H).data
    const on = new Uint8Array(W * H)
    for (let p = 0, i = 0; p < W * H; p++, i += 4) {
      if (d[i]! > 170 && d[i + 1]! < 90 && d[i + 2]! < 90 && d[i + 3]! > 150) on[p] = 1
    }
    const seen = new Uint8Array(W * H)
    const st: number[] = []
    const out: { x: number; y: number; n: number }[] = []
    for (let p0 = 0; p0 < W * H; p0++) {
      if (!on[p0] || seen[p0]) continue
      let sx = 0, sy = 0, n = 0
      st.length = 0; st.push(p0); seen[p0] = 1
      while (st.length) {
        const q = st.pop()!
        const x = q % W, y = (q / W) | 0
        sx += x; sy += y; n++
        if (x > 0 && on[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; st.push(q - 1) }
        if (x < W - 1 && on[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; st.push(q + 1) }
        if (y > 0 && on[q - W] && !seen[q - W]) { seen[q - W] = 1; st.push(q - W) }
        if (y < H - 1 && on[q + W] && !seen[q + W]) { seen[q + W] = 1; st.push(q + W) }
      }
      if (n >= minArea) out.push({ x: sx / n, y: sy / n, n })
    }
    return out
  }, { minArea })
}

/** A 0.4 x 0.4 fill-less rect carrying exactly one stroke — so every red pixel on the
 *  canvas IS that stroke, and radius 0 keeps the outline the four-point rect the resampling
 *  trap is about. */
const wobbleRect = (stroke: Record<string, unknown>) => [{
  id: 'wr', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, radius: 0,
  rotation: 0, opacity: 1, visible: true, fill: 'none',
  strokes: [{ id: 's1', paint: '#ff0000', ...stroke }],
}]

/** The four dials, shared by the wave and the zigzag cases so the two are compared on
 *  identical geometry and differ only in `f`. */
const WOB = { width: 0.006, distance: 0.06, amount: 0.04, length: 0.1 } as const

/** The rect's geometry in device pixels, plus the probe span, all derived from the canvas. */
function wobbleGeometry(W: number, H: number) {
  const leftEdge = (0.5 - 0.4 / 2) * W            // 0.3 * W = 162.6 px
  const topEdge = 0.5 * H - (0.4 / 2) * W         // 0.5*H - 0.2*W = 162.6 px on a square canvas
  return {
    leftEdge, topEdge,
    ampPx: WOB.amount * W,                        // 21.68 px
    distPx: WOB.distance * W,                     // 32.52 px
    // Three whole cycles, 0.05*W = 27 px clear of both corners.
    x0: leftEdge + 0.05 * W,
    x1: leftEdge + 0.35 * W,
    /** The device column at arc length `s` (width-normalized) along the top edge. */
    colAt: (s: number) => Math.round(leftEdge + s * W) - Math.round(leftEdge + 0.05 * W),
  }
}

test('a WAVY band on a rect leaves the straight line by the amount, at the wavelength asked for', async ({ page }) => {
  await openCompositor(page)
  const { W, H } = await canvasDims(page)
  const g = wobbleGeometry(W, H)

  // (a) The SAME stroke with no wobble fields at all — the line the wobble is measured
  //     against, measured rather than assumed.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls),
    wobbleRect({ width: WOB.width, distance: WOB.distance, align: 'center', join: 'round' }))
  await stackPixels(page)
  const straight = (await topEdgeBandProfile(page, g.x0, g.x1, g.topEdge)).filter(v => v !== null) as number[]
  expect(straight.length, 'the straight band must actually ink every column of the span')
    .toBe(Math.round(g.x1) - Math.round(g.x0))
  const straightY = straight.reduce((a, b) => a + b, 0) / straight.length
  expect(Math.max(...straight) - Math.min(...straight), 'a straight band is FLAT along the top edge')
    .toBeLessThan(1.5)
  expect(straightY, `and sits ${g.distPx.toFixed(1)} px above the edge at y=${g.topEdge.toFixed(1)}`)
    .toBeCloseTo(g.topEdge - g.distPx, 0)

  // (b) Now the wave. Same everything, plus the three dials.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), wobbleRect({
    width: WOB.width, distance: WOB.distance, align: 'center', join: 'round',
    wobble: 'wave', wobbleAmount: WOB.amount, wobbleLength: WOB.length, wobblePhase: 0,
  }))
  await stackPixels(page)
  const wavy = await topEdgeBandProfile(page, g.x0, g.x1, g.topEdge)
  expect(wavy.filter(v => v === null).length, 'the wavy band inks every column too — nothing is missing')
    .toBe(0)
  // Outward is UP, so a positive deviation is the straight line's y minus the wavy one's.
  const dev = wavy.map(y => straightY - y!)

  // (c) At every computed PEAK the line is a full `amount` further out, and at every
  //     computed TROUGH a full `amount` further in. Six probe points, none of them chosen:
  //     s = 0.025 + k*0.1 and s = 0.075 + k*0.1 are where sin is +1 and -1.
  for (const s of [0.125, 0.225, 0.325]) {
    expect(dev[g.colAt(s)]! / g.ampPx, `peak at s=${s} reaches +amount`).toBeGreaterThan(0.85)
    expect(dev[g.colAt(s)]! / g.ampPx).toBeLessThan(1.15)
  }
  for (const s of [0.075, 0.175, 0.275]) {
    expect(dev[g.colAt(s)]! / g.ampPx, `trough at s=${s} reaches -amount`).toBeLessThan(-0.85)
    expect(dev[g.colAt(s)]! / g.ampPx).toBeGreaterThan(-1.15)
  }
  // …so the peak-to-trough swing is twice the amount, which is what the dial promises.
  expect((Math.max(...dev) - Math.min(...dev)) / g.ampPx, 'peak to trough is 2 x amount')
    .toBeGreaterThan(1.8)
  expect((Math.max(...dev) - Math.min(...dev)) / g.ampPx).toBeLessThan(2.2)

  // (d) THE FREQUENCY, counted rather than sampled: walk the span and count how many times
  //     the line crosses the straight one, with a half-amplitude hysteresis so a noisy
  //     zero-crossing cannot be counted twice. Three whole cycles starting at a descending
  //     zero give trough, peak, trough, peak, trough, peak — SIX extremes, FIVE crossings.
  //     A wobble at the wrong wavelength, or one whose closed-cycle snap moved it, lands on
  //     a different integer here.
  let flips = 0, side = 0
  for (const v of dev) {
    const s = v > g.ampPx / 2 ? 1 : v < -g.ampPx / 2 ? -1 : 0
    if (s && s !== side) { if (side) flips++; side = s }
  }
  expect(flips, 'exactly three cycles of the requested 0.1 wavelength across the probe span').toBe(5)
})

test('a ZIGZAG reads as straight runs and points — a shape no sine can make', async ({ page }) => {
  await openCompositor(page)
  const { W, H } = await canvasDims(page)
  const g = wobbleGeometry(W, H)

  // Both shapes are measured through the SAME code on the SAME geometry, so the wave is
  // this test's positive control: if the readings below could not tell a sine from a
  // triangle they would come out equal, and the assertions would have nothing to say.
  const read = async (shape: 'wave' | 'zigzag') => {
    await page.evaluate((ls) => (window as any).__compositorSetLayers(ls),
      wobbleRect({ width: WOB.width, distance: WOB.distance, align: 'center', join: 'round' }))
    await stackPixels(page)
    const flat = (await topEdgeBandProfile(page, g.x0, g.x1, g.topEdge)).filter(v => v !== null) as number[]
    const baseY = flat.reduce((a, b) => a + b, 0) / flat.length

    await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), wobbleRect({
      width: WOB.width, distance: WOB.distance, align: 'center', join: 'round',
      wobble: shape, wobbleAmount: WOB.amount, wobbleLength: WOB.length, wobblePhase: 0,
    }))
    await stackPixels(page)
    const prof = await topEdgeBandProfile(page, g.x0, g.x1, g.topEdge)
    expect(prof.filter(v => v === null).length, `${shape}: every column inked`).toBe(0)
    const dev = prof.map(y => (baseY - y!) / g.ampPx)

    // 1. MEAN |deviation| over exactly three whole cycles. Fixed by the shape alone:
    //    a sine's is 2/pi = 0.6366 of its amplitude, a triangle's is exactly 0.5.
    const meanAbs = dev.reduce((a, b) => a + Math.abs(b), 0) / dev.length
    // 2. RMS over the same span: 1/sqrt(2) = 0.7071 for a sine, 1/sqrt(3) = 0.5774 for a
    //    triangle. A second, independent moment of the same profile.
    const rms = Math.sqrt(dev.reduce((a, b) => a + b * b, 0) / dev.length)
    // 3. THE EIGHTH-PHASE PROBE — the sharpest of the three, and a single number a sine
    //    cannot produce. Halfway (in arc length) between a zero crossing and the next
    //    extreme, a triangle is at exactly HALF its amplitude, because its run is straight;
    //    a sine is at sin(pi/4) = 0.7071, because it is not. The span starts at s = 0.05,
    //    which is a zero crossing, so those points are s = 0.05 + (k/4 + 1/8) * lambda —
    //    twelve of them across three cycles, averaged to kill per-column noise.
    const eighths: number[] = []
    for (let k = 0; k < 12; k++) {
      const v = dev[g.colAt(0.05 + (k * 0.25 + 0.125) * WOB.length)]
      if (typeof v === 'number') eighths.push(Math.abs(v))
    }
    expect(eighths.length, 'all twelve eighth-phase probes are inside the span').toBe(12)
    const eighthMean = eighths.reduce((a, b) => a + b, 0) / eighths.length
    return { meanAbs, rms, eighthMean, peak: Math.max(...dev), trough: Math.min(...dev) }
  }

  const wave = await read('wave')
  const zig = await read('zigzag')

  // Both reach the same amplitude — so every difference below is SHAPE, not size.
  for (const [name, m] of [['wave', wave], ['zigzag', zig]] as const) {
    expect(m.peak, `${name} reaches +amount`).toBeGreaterThan(0.85)
    expect(m.trough, `${name} reaches -amount`).toBeLessThan(-0.85)
  }

  // The wave measures as a sine on all three readings…
  expect(wave.meanAbs, 'wave mean|dev| is a sine 2/pi = 0.6366').toBeGreaterThan(0.58)
  expect(wave.meanAbs).toBeLessThan(0.70)
  expect(wave.rms, 'wave RMS is a sine 1/sqrt(2) = 0.7071').toBeGreaterThan(0.64)
  expect(wave.rms).toBeLessThan(0.77)
  expect(wave.eighthMean, 'wave at the eighth phase is sin(pi/4) = 0.7071').toBeGreaterThan(0.63)
  expect(wave.eighthMean).toBeLessThan(0.78)

  // …and the zigzag measures as a triangle on all three, OUTSIDE every sine band above.
  expect(zig.meanAbs, 'zigzag mean|dev| is a triangle 0.5, not a sine 0.6366').toBeGreaterThan(0.44)
  expect(zig.meanAbs).toBeLessThan(0.56)
  expect(zig.rms, 'zigzag RMS is a triangle 1/sqrt(3) = 0.5774, not a sine 0.7071').toBeGreaterThan(0.52)
  expect(zig.rms).toBeLessThan(0.63)
  expect(zig.eighthMean, 'zigzag at the eighth phase is exactly 0.5 — a straight run').toBeGreaterThan(0.43)
  expect(zig.eighthMean).toBeLessThan(0.58)

  // And the separations, so a render that somehow satisfied both bands at once cannot pass.
  expect(wave.meanAbs - zig.meanAbs, 'the two shapes are told apart, not merely bounded')
    .toBeGreaterThan(0.08)
  expect(wave.eighthMean - zig.eighthMean).toBeGreaterThan(0.10)
})

/**
 * WOBBLE OFF RENDERS EXACTLY WHAT NO WOBBLE FIELDS RENDER.
 *
 * A wobbled band is built by a different function from a straight one (`paintWobbledBand`
 * strokes a displaced `Path2D`; `paintStrokeBand` differences two raster dilations), so
 * "off" has to mean the straight construction runs — not a wobbled one with a zero
 * amplitude, which would move a band's ink by the flattening error alone.
 *
 * The four spellings below are the ones `resolveWobble` calls off, and the FIRST is the one
 * the inspector actually writes: `setStrokeWobble('off')` returns `{ wobble: undefined }`
 * and deliberately leaves `wobbleAmount` / `wobbleLength` / `wobblePhase` behind, so a
 * stroke that has ever been wavy carries live-looking numbers for ever after.
 *
 * The comparison is the settled data-URL of the real stack canvas — byte for byte. The last
 * assertion is the one that stops the test being vacuous: a LIVE wobble on the same stroke
 * must NOT match, or every comparison above would be comparing two blank canvases.
 */
test('a wobble that is off renders byte-identically to a stroke with no wobble fields', async ({ page }) => {
  await openCompositor(page)
  const base = { width: WOB.width, distance: WOB.distance, align: 'center', join: 'round' }

  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), wobbleRect(base))
  const noFields = await stackPixels(page)
  expect(noFields).toBeTruthy()

  const offSpellings: [string, Record<string, unknown>][] = [
    ['the Off row: `wobble` cleared, the three numbers left behind',
      { wobbleAmount: WOB.amount, wobbleLength: WOB.length, wobblePhase: 90 }],
    ['a shape name that is not one of STROKE_WOBBLES',
      { wobble: 'none', wobbleAmount: WOB.amount, wobbleLength: WOB.length }],
    ['a non-positive wavelength',
      { wobble: 'wave', wobbleAmount: WOB.amount, wobbleLength: 0 }],
    ['an amount that is not a number',
      { wobble: 'wave', wobbleAmount: null, wobbleLength: WOB.length }],
    // FINDING 2 (final review). AMOUNT 0. The case this list did not have: `wobbleAmount`
    // was `null` above, which `resolveWobble` refused for being the wrong TYPE — while a
    // perfectly ordinary 0, the value the Amount scrub field reaches with one drag, was
    // accepted as live. `offsetPolyline` displaces nothing without a positive amount, so the
    // band came out visually straight while being BUILT by `paintWobbledBand` instead of the
    // dilation pair: an ellipse facets, the join and cap change, and a dash appears at a
    // distance where the straight route drops it. Reader and maths now agree.
    ['an amount of exactly 0 — a live-looking spelling of a still line',
      { wobble: 'wave', wobbleAmount: 0, wobbleLength: WOB.length }],
    ['a negative amount, which offsetPolyline does not read as a phase flip',
      { wobble: 'zigzag', wobbleAmount: -WOB.amount, wobbleLength: WOB.length }],
  ]
  for (const [why, fields] of offSpellings) {
    await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), wobbleRect({ ...base, ...fields }))
    expect(await stackPixels(page), why).toBe(noFields)
  }

  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), wobbleRect({
    ...base, wobble: 'wave', wobbleAmount: WOB.amount, wobbleLength: WOB.length,
  }))
  expect(await stackPixels(page), 'CONTROL: a live wobble must move pixels, or every comparison above is vacuous')
    .not.toBe(noFields)
})

/**
 * STEP 2 — REACH: A WOBBLED STROKE INSIDE A CORNER PIN IS NOT CLIPPED.
 *
 * Modelled on 'a distant stroke survives a corner pin' above: a corner-pinned layer is
 * drawn into its OWN offscreen, sized from `localLayerBox` plus `cornerPinPadPx`, and
 * `localLayerBox` is the shape's plain w x h and knows nothing about strokes. A wave
 * reaches `amount` further out than the straight band it rides on, so without the amplitude
 * term in `strokeStackReachPx` the outer half of every crest is simply cut off — a slightly
 * wrong shape, never an error. This is the third consumer in this feature family to need a
 * new term, which is why it gets a pixel test and not only a unit one.
 *
 * ARITHMETIC (all width-normalized; the shape is 0.3 x 0.3 centred, so its right edge is at
 * 0.5 + 0.15 = 0.65):
 *   straight band's outer edge   0.65 + distance 0.02 + width/2 0.005     = 0.675
 *   wobbled band's outer edge    0.675 + amount 0.10                      = 0.775
 * The pad without the amplitude term is 0.025 — a fortieth of what the crest needs — so the
 * crests land outside the offscreen entirely. The probe at 0.74 is past the straight band's
 * own 0.675 by more than a band width, so only a real, unclipped crest can reach it.
 *
 * Perimeter 1.2 with `wobbleLength` 0.06 snaps to round(1.2/0.06) = 20 cycles, i.e. exactly
 * the wavelength asked for; the right edge is s in [0.3, 0.6], five whole cycles, so five
 * crests sit on the side being probed. Only the top-left corner is pulled, so the right-hand
 * side of the quad is unwarped and the geometry above is the geometry drawn.
 */
test('a WOBBLED stroke survives a corner pin — the offscreen grows by the amplitude too', async ({ page }) => {
  await openCompositor(page)
  await page.evaluate(() => (window as any).__compositorSetLayers([{
    id: 'cpw', kind: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, radius: 0,
    rotation: 0, opacity: 1, visible: true, fill: 'none',
    cornerPin: { tl: { x: 0.06, y: 0.06 }, tr: { x: 0, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } },
    strokes: [{
      id: 's1', paint: '#ff0000', width: 0.01, distance: 0.02, align: 'center', join: 'round',
      wobble: 'wave', wobbleAmount: 0.1, wobbleLength: 0.06, wobblePhase: 0,
    }],
  }]))
  await stackPixels(page)
  const b = await redBounds(page)
  expect(b.count, 'the whole wobbled outline is on the canvas, not clipped away').toBeGreaterThan(4000)
  expect(b.maxX, "a crest reaches 0.775 — well past the straight band's own outer edge at 0.675")
    .toBeGreaterThan(0.74)
  // …and symmetrically on the left, which the corner pin's pulled corner does not touch
  // horizontally at the vertical mid-height where the crests are.
  expect(b.minX, 'and a crest reaches out on the left too').toBeLessThan(0.26)
})

/**
 * MARCHING SHAPES ON A WOBBLED LINE. Was `test.fail`; the plumbing landed, so it is a plain
 * test now.
 *
 * ── THE FINDING (Task 4), AND THE FIX ──
 * The spec says marching shapes get the wobble "free": "`shapeStrokeGuideFit` already does
 * flatten -> offset -> guide. It gains the wobble arguments and passes them to
 * `offsetPolyline`. Nothing in `paintShapeStroke` changes." Task 1 duly widened
 * `shapeStrokeGuideFit(d, distance, tolerance?, wobble?)` — but `paintShapeStroke` does not
 * call it. `shapeStrokeMarkMatrices` does, and that function's options object had NO wobble
 * field and called `shapeStrokeGuideFit(o.pathData, o.distance, o.tolerance)` positionally
 * with three arguments. It is the ONLY seam both consumers use — the canvas painter
 * (useCompositorLayers.ts) and the SVG writer (useVectorSvg.ts) — so a marching-shapes
 * stroke wobbled nowhere, on screen or in an exported file.
 *
 * Measured, not inferred: with `wobbleAmount` 0.04 (21.7 px) the marks came out at
 * y = 129.63, 129.62, 129.57, 129.70 … against an unwobbled 129.58, 129.57, 129.56, 129.55 —
 * the SAME ink, to a twentieth of a pixel — and the blob count was 82 either way, though a
 * wobbled guide is longer and at a fixed spacing must carry more marks.
 *
 * The Wobble rows ARE offered on a shapes stroke (`strokeInspector.ts` gates them on the
 * layer having an outline, not on the style), and `strokeStackReachPx`'s shapes arm already
 * padded the corner-pin quad by the amplitude — so the dial stored its value, the raster grew
 * for it, and nothing moved. A dead control plus a wrong box.
 *
 * `shapeStrokeMarkMatrices` now takes a `wobble` option and both call sites fill it from
 * `wobbleSpecOf` — the same function the band route uses, at each consumer's own unit
 * (`widthScale` on canvas, 1 in the SVG writer, where a path's numbers are already `d`'s).
 * The assertions below are the CORRECT behaviour and were written before the fix; do not
 * relax them to today's pixels.
 *
 * ARITHMETIC. Same rect, `wobbleLength` 0.2: perimeter 1.6 snaps to round(1.6/0.2) = 8
 * cycles, so the effective wavelength is exactly 0.2 and the top edge (s in [0, 0.4]) holds
 * two whole cycles — peaks at s = 0.05, 0.25 and troughs at s = 0.15, 0.35, all inside the
 * probe span. A `circle` mark is symmetric, so its ink centroid IS the point the placement
 * maths chose, and on a straight edge the displacement is purely vertical — so a mark whose
 * centroid is at device x sits at exactly
 *     y = topEdge - (0.06 + 0.04 * sin(2*pi*(x - leftEdge)/(0.2*W))) * W
 * `size` 0.018 (9.8 px) under `spacing` 0.025 (13.6 px) keeps every mark a separate blob.
 */
const SHAPE_WOB = { distance: 0.06, amount: 0.04, length: 0.2, size: 0.018, spacing: 0.025 } as const

const shapesWobbleRect = (wobbled: boolean) => wobbleRect({
  width: 0.004, distance: SHAPE_WOB.distance, style: 'shapes',
  shapes: { shapeId: 'circle', size: SHAPE_WOB.size, spacing: SHAPE_WOB.spacing, follow: false },
  ...(wobbled
    ? { wobble: 'wave', wobbleAmount: SHAPE_WOB.amount, wobbleLength: SHAPE_WOB.length, wobblePhase: 0 }
    : {}),
})

test('marching shapes ride the wobbled line, sitting off the straight one by the amount', async ({ page }) => {
  await openCompositor(page)
  const { W, H } = await canvasDims(page)
  const g = wobbleGeometry(W, H)
  const inSpan = (b: { x: number; y: number }) =>
    b.x > g.leftEdge + 0.04 * W && b.x < g.leftEdge + 0.36 * W && b.y < g.topEdge

  // (a) The straight control: every mark on one horizontal line, `distance` above the edge.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), shapesWobbleRect(false))
  await stackPixels(page)
  const flat = (await redBlobCentroids(page)).filter(inSpan)
  expect(flat.length, 'the straight shapes stroke puts marks along the top edge').toBeGreaterThan(8)
  const flatYs = flat.map(b => b.y)
  expect(Math.max(...flatYs) - Math.min(...flatYs), 'unwobbled, they are all on one line').toBeLessThan(2)
  // The measured centroid of a `circle` mark sits a fraction of a pixel off its geometric
  // centre (the strict red predicate drops the antialiased rim); that offset is the same for
  // every mark, so it is measured here and carried into the wobbled comparison below.
  const biasPx = flatYs.reduce((a, b) => a + b, 0) / flatYs.length - (g.topEdge - SHAPE_WOB.distance * W)
  expect(Math.abs(biasPx), 'and within a pixel of `distance` above the edge').toBeLessThan(1.5)

  // (b) The same stroke, wobbled. Every mark must land on the sine that the band traces —
  //     not merely "somewhere off the line", which a random displacement would satisfy too.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), shapesWobbleRect(true))
  await stackPixels(page)
  const wob = (await redBlobCentroids(page)).filter(inSpan)
  expect(wob.length, 'the wobbled stroke still puts marks along the top edge').toBeGreaterThan(8)

  const errs = wob.map((b) => {
    const s = (b.x - g.leftEdge) / W
    const predicted = g.topEdge
      - (SHAPE_WOB.distance + SHAPE_WOB.amount * Math.sin((2 * Math.PI * s) / SHAPE_WOB.length)) * W
    return b.y - (predicted + biasPx)
  })
  expect(Math.max(...errs.map(Math.abs)), 'every mark sits on the wobbled guide, to within 3 px')
    .toBeLessThan(3)

  // …and the spread proves the marks really moved by the AMOUNT, so a guide that happened to
  // fit the sine while barely deviating cannot pass.
  const ys = wob.map(b => b.y)
  expect(Math.max(...ys) - Math.min(...ys), 'top to bottom, the marks span nearly 2 x amount')
    .toBeGreaterThan(1.6 * SHAPE_WOB.amount * W)
})

/**
 * A TRANSFORM-DEPENDENT PAINT ON A BAND AT A DISTANCE.
 *
 * A stroke's paint is resolved by `resolvePaint`, which builds a `CanvasGradient` or a
 * `CanvasPattern` CENTRED ON THE ORIGIN in the caller's own drawing units. Canvas2D
 * resolves both of those objects in the transform current at FILL time, not at creation
 * time — so the fill that pushes the paint through the band's mask has to run under the
 * SAME transform the paint was built against. A colour STRING is transform-independent,
 * which is exactly why only these two paints can show the defect and every solid-colour
 * stroke in this file renders correctly either way.
 *
 * The two tests below are the pixel proof, one per paint kind:
 *  - a GRADIENT must still be a ramp around the ring (the reported second symptom was a
 *    band of near-flat colour);
 *  - a `Fill` (the fill picker's Ombre, which resolves to a `CanvasPattern`) must ink the
 *    ring as fully as the same stroke painted a flat colour (the reported symptom was a
 *    small patch near the canvas corner — the pattern tile dropped at the DEVICE origin).
 *
 * Both use `distance !== 0`, which is the only branch of `paintStrokeBand` that leaves
 * the shape transform to lay its colour down; a distance-0 stroke delegates to
 * `strokeAligned`, which strokes under the shape transform and was never affected.
 */

/** A rect layer, 0.4 x 0.4 and centred, whose ONLY ink is one band stroke. */
const bandOnlyRect = (paint: unknown, width: number, distance: number) => [{
  id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
  fill: 'none', radius: 0,
  strokes: [{ id: 's1', paint, width, distance, align: 'center', join: 'sharp' }],
}]

test('a GRADIENT stroke at a distance ramps around the band, ends on opposite sides', async ({ page }) => {
  await openCompositor(page)
  // Geometry, all width-normalized (see this file's geometry note):
  //   the rect spans 0.5 ± 0.4/2, so its left edge is at 0.3 and its right edge at 0.7;
  //   the band's CENTRELINE is `distance` beyond each of those — 0.25 and 0.75.
  // Both probes sit on the horizontal centre row, so no W/H conversion applies to either.
  const D = 0.05
  const leftBand = 0.5 - 0.4 / 2 - D          // 0.25
  const rightBand = 0.5 + 0.4 / 2 + D         // 0.75
  // angle 0 is the left-to-right axis (`gradientUnitAxis`), so offset 0 is the box's LEFT
  // edge and offset 1 its RIGHT. The band lies outside the box on both sides, where a real
  // CanvasGradient pads with its end stops — so the left probe must be the offset-0 colour
  // and the right probe the offset-1 colour, which is the strongest form of "the ramp runs
  // around the band" this geometry can state.
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), bandOnlyRect(
    { type: 'linear', angle: 0, stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 1 }] },
    0.03, D,
  ))
  await stackPixels(page)

  const left = await pixelAt(page, leftBand, 0.5)
  const right = await pixelAt(page, rightBand, 0.5)
  // The band is painted at all — otherwise "not blue" below would pass on empty pixels.
  expect(left[3], `band inked at x=${leftBand}`).toBeGreaterThan(200)
  expect(right[3], `band inked at x=${rightBand}`).toBeGreaterThan(200)
  expect(left[0]! - left[2]!, `left side of the band is the ramp's RED end (got rgba ${left})`)
    .toBeGreaterThan(100)
  expect(right[2]! - right[0]!, `right side of the band is the ramp's BLUE end (got rgba ${right})`)
    .toBeGreaterThan(100)
})

test('a Fill (Ombre) stroke at a distance inks the whole band, like a flat colour does', async ({ page }) => {
  await openCompositor(page)
  // A `Fill` resolves to a box-sized `no-repeat` pattern tile (`resolveFill`, spread 'box'),
  // so its paint exists only INSIDE the layer's paint box — the rect's own 0.4 x 0.4. A
  // NEGATIVE distance keeps the whole band inside that box, which is what makes the flat
  // colour a fair control: the two renders differ in the paint's MECHANISM (a string versus
  // a CanvasPattern) and in nothing else. (Reaching past the box is a separate, documented
  // `PaintSpread` question that this stroke path does not ask.)
  //   band centreline: 0.4/2 - 0.06 = 0.14 from the shape's centre, i.e. 0.06 inside the
  //   edge, and its half-width 0.015 keeps it clear of both the edge and the box's middle.
  const W = 0.03, D = -0.06
  // Both colours of the ombre are REDS, so every dithered pixel of it answers the same
  // `redPixels` predicate the flat-colour control does and the two counts are comparable
  // pixel for pixel.
  const ombre = { type: 'ombre', a: '#ff0000', b: '#e00000', textColor: '#ffffff', angle: 0, density: 8 }

  const solid = await redPixels(page, bandOnlyRect('#ff0000', W, D))
  const filled = await redPixels(page, bandOnlyRect(ombre, W, D))
  const count = (r: { rows: number[][] }) => r.rows.reduce((n, xs) => n + xs.length, 0)
  const solidN = count(solid), fillN = count(filled)

  expect(solidN, 'the flat-colour control inks a real band').toBeGreaterThan(500)
  // A ratio, not a count: the ring's absolute pixel area depends on the canvas size and on
  // how the antialiased rim answers the predicate, and both are identical between the two
  // renders. Anything below 0.9 means the pattern failed to reach part of the ring.
  expect(fillN / solidN, `Ombre band inked ${fillN}px vs the flat control's ${solidN}px`)
    .toBeGreaterThan(0.9)
})
