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
