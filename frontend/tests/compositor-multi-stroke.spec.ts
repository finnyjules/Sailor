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
