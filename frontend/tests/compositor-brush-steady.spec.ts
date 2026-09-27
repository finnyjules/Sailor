import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Frame brush steadying and hold to snap, painted with the real mouse: steadying calms a
 * jittery stroke, a held stroke snaps to a line / ellipse / circle (adjustable while held),
 * the spray can never snaps, one undo removes a snapped stroke, and the inspector section
 * persists its values.
 */

const SHOTS = process.env.BRUSH_SHOTS_DIR

async function stage(page: Page) {
  const b = await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox()
  expect(b).toBeTruthy()
  return b!
}
/** Press, move through `pts` (stage fractions), optionally hold still, and return a release
 *  function that can drag by (dx, dy) px before letting go. */
async function press(page: Page, pts: [number, number][], holdMs = 0, stepMs = 16) {
  const b = await stage(page)
  const at = ([fx, fy]: [number, number]) => [b.x + fx * b.width, b.y + fy * b.height] as const
  let [x, y] = at(pts[0]!)
  await page.mouse.move(x, y); await page.mouse.down()
  for (const p of pts.slice(1)) { [x, y] = at(p); await page.mouse.move(x, y); await page.waitForTimeout(stepMs) }
  if (holdMs) await page.waitForTimeout(holdMs)
  return async (dx = 0, dy = 0) => {
    if (dx || dy) { await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.waitForTimeout(120) }
    await page.mouse.up(); await page.waitForTimeout(500)
  }
}
const zigzag = (x0: number, x1: number, y: number, amp: number, n = 40): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y + (i % 2 ? amp : -amp)])
const wobblyLine = (x0: number, y0: number, x1: number, y1: number, n = 40): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n + Math.sin(i * 1.7) * 0.004])
const loop = (cx: number, cy: number, rx: number, ry: number, n = 64): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => { const a = i / n * Math.PI * 2 * 1.03; return [cx + Math.cos(a) * rx + Math.sin(i * 2.3) * 0.003, cy + Math.sin(a) * ry] })

const brushLayers = (page: Page) => page.evaluate(() =>
  ((window as any).__compositorLayers() as any[]).filter(l => l.kind === 'brush'))
const allStrokes = async (page: Page) => (await brushLayers(page)).flatMap((l: any) => l.strokes ?? [])
const xy = (s: any): { x: number; y: number }[] => { const o = []; for (let i = 0; i + 2 < s.pts.length; i += 3) o.push({ x: s.pts[i], y: s.pts[i + 1] }); return o }
/** RMS distance of a stroke's samples from its own best-fit horizontal line, over the middle 80%. */
function rmsY(s: any): number {
  const P = xy(s), a = Math.floor(P.length * 0.1), m = P.slice(a, P.length - a)
  const my = m.reduce((t, p) => t + p.y, 0) / m.length
  return Math.sqrt(m.reduce((t, p) => t + (p.y - my) ** 2, 0) / m.length)
}
function maxDevFromChord(s: any): number {
  const P = xy(s), A = P[0]!, B = P[P.length - 1]!, L = Math.hypot(B.x - A.x, B.y - A.y)
  return Math.max(...P.map(p => Math.abs((B.x - A.x) * (A.y - p.y) - (A.x - p.x) * (B.y - A.y)) / L)) / L
}
function meanRadius(s: any): number {
  const P = xy(s), cx = P.reduce((t, p) => t + p.x, 0) / P.length, cy = P.reduce((t, p) => t + p.y, 0) / P.length
  return P.reduce((t, p) => t + Math.hypot(p.x - cx, p.y - cy), 0) / P.length
}

async function openBrush(page: Page) {
  await page.setViewportSize({ width: 1280, height: 860 })
  await openCompositor(page)
  await page.keyboard.press('b')
  await expect(page.getByTestId('brush-toolbar')).toBeVisible()
  await page.getByTestId('brush-mode-paint').click()
  await page.getByTestId('brush-tip-round').click()
  await expect(page.getByTestId('brush-steady-settings')).toBeVisible()
}

test('steadying calms a jittery stroke; the inspector section persists', async ({ page }) => {
  test.setTimeout(150_000)
  await openBrush(page)
  // Defaults shown.
  await expect(page.getByTestId('brush-steady-streamline')).toHaveValue('30')
  await expect(page.getByTestId('brush-steady-settings')).toContainText('0.63 s')

  // Raw: every steadying slider at 0.
  for (const id of ['streamline', 'stabilise', 'filter']) await page.getByTestId(`brush-steady-${id}`).fill('0')
  let up = await press(page, zigzag(0.15, 0.85, 0.3, 0.006)); await up()
  // Steadied: defaults.
  await page.getByTestId('brush-steady-reset').click()
  await expect(page.getByTestId('brush-steady-streamline')).toHaveValue('30')
  up = await press(page, zigzag(0.15, 0.85, 0.6, 0.006)); await up()
  const S = await allStrokes(page)
  expect(S.length).toBe(2)
  const raw = rmsY(S[0]), steady = rmsY(S[1])
  console.log('wobble', JSON.stringify({ raw, steady }))
  expect(steady).toBeLessThan(raw * 0.5)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/steady-wobble.png` })

  // Persistence.
  await page.getByTestId('brush-steady-streamline').fill('60')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sailor.brushTips.v1') || '{}')?.steady?.streamline), { timeout: 3000 }).toBe(0.6)
})

test('held strokes snap: line, ellipse, circle, resize while held; one undo removes it', async ({ page }) => {
  test.setTimeout(180_000)
  await openBrush(page)

  // Line.
  let up = await press(page, wobblyLine(0.1, 0.2, 0.6, 0.26), 900)
  await expect(page.getByTestId('brush-snap-tag')).toHaveText('Line')
  await up()
  await expect(page.getByTestId('brush-snap-tag')).toHaveCount(0)
  let S = await allStrokes(page)
  expect(S.length).toBe(1)
  const dev = maxDevFromChord(S[0]); console.log('line dev', dev)
  expect(dev).toBeLessThan(0.005)

  // One undo removes the snapped stroke.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect.poll(async () => (await allStrokes(page)).length).toBe(0)

  // Ellipse, released as drawn.
  up = await press(page, loop(0.3, 0.55, 0.14, 0.08), 900)
  await expect(page.getByTestId('brush-snap-tag')).toHaveText('Ellipse')
  await up()
  // Same loop elsewhere: Shift makes a circle; dragging outward while held makes it bigger.
  up = await press(page, loop(0.7, 0.55, 0.14, 0.08), 900)
  await expect(page.getByTestId('brush-snap-tag')).toHaveText('Ellipse')
  await page.keyboard.down('Shift')
  await expect(page.getByTestId('brush-snap-tag')).toHaveText('Circle')
  await up(40, 0)
  await page.keyboard.up('Shift')
  S = await allStrokes(page)
  expect(S.length).toBe(2)
  const r0 = meanRadius(S[0]), r1 = meanRadius(S[1]); console.log('radii', r0, r1)
  expect(r1).toBeGreaterThan(r0 * 1.1)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/steady-snaps.png` })

  // Reload redraws identical pixels.
  await page.keyboard.press('b')
  const saved = await page.evaluate(() => (window as any).__compositorLayers())
  const reload = async () => {
    await page.evaluate(() => (window as any).__compositorSetLayers([]))
    await page.waitForTimeout(300)
    await page.evaluate((ls) => (window as any).__compositorSetLayers(JSON.parse(JSON.stringify(ls))), saved)
    return stackPixels(page)
  }
  const a = await reload()
  expect(await reload()).toBe(a)
})

test('the spray can never snaps', async ({ page }) => {
  test.setTimeout(120_000)
  await openBrush(page)
  await page.getByTestId('brush-tip-spray').click()
  const up = await press(page, wobblyLine(0.2, 0.5, 0.7, 0.52, 20), 900, 30)
  await expect(page.getByTestId('brush-snap-tag')).toHaveCount(0)
  await expect(page.getByTestId('brush-hold-ring')).toHaveCount(0)
  await up()
  await expect.poll(async () => (await allStrokes(page)).at(-1)?.tip, { timeout: 5000 }).toBe('spray')
})
