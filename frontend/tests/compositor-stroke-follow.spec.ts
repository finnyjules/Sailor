import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * A stroke whose fill FOLLOWS THE LINE — proven on pixels.
 *
 * Geometry is width-normalized (as in compositor-multi-stroke.spec.ts): an ellipse w = h = 0.4
 * centred at (0.5, 0.5) is a circle of radius 0.2·canvasWidth in device pixels. Every probe is
 * taken in DEVICE pixels from that, so a non-square canvas cannot skew it.
 */

const ring = (stroke: Record<string, unknown>) => [{
  id: 'e', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, rotation: 0, opacity: 1, visible: true,
  fill: 'none', strokes: [{ id: 's1', width: 0.06, distance: 0, align: 'center', join: 'sharp', ...stroke }],
}]

/** RGBA at `n` points round a circle of radius `rNorm` (width-normalized) about the centre. */
async function around(page: Page, rNorm: number, n: number): Promise<number[][]> {
  return page.evaluate(({ rNorm, n }) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const g = cv.getContext('2d')!
    const cx = cv.width / 2, cy = cv.height / 2, r = rNorm * cv.width
    const out: number[][] = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      const d = g.getImageData(Math.round(cx + r * Math.cos(t)), Math.round(cy + r * Math.sin(t)), 1, 1).data
      out.push([d[0]!, d[1]!, d[2]!, d[3]!])
    }
    return out
  }, { rNorm, n })
}
async function render(page: Page, layers: unknown[]): Promise<string> {
  await page.evaluate((ls) => (window as any).__compositorSetLayers(ls), layers)
  return stackPixels(page)
}
const dark = (p: number[]) => p[3]! > 200 && p[0]! < 100
const light = (p: number[]) => p[3]! > 200 && p[0]! > 155

const STRIPES = { type: 'stripes', a: '#ffffff', b: '#000000', textColor: '#fff', angle: 0, density: 8 }
const OMBRE = { type: 'ombre', a: '#ffffff', b: '#000000', textColor: '#fff', angle: 0, density: 8 }

test.beforeEach(async ({ page }) => { await openCompositor(page) })

test('follow off, or absent, paints the very same pixels', async ({ page }) => {
  const absent = await render(page, ring({ paint: STRIPES }))
  const off = await render(page, ring({ paint: STRIPES, follow: false }))
  expect(off).toBe(absent)
})

test('a flat colour ignores follow: same pixels either way', async ({ page }) => {
  const still = await render(page, ring({ paint: '#ff0000' }))
  const follow = await render(page, ring({ paint: '#ff0000', follow: true }))
  expect(follow).toBe(still)
})

test('followed stripes are RADIAL: inner and outer edge agree at every angle', async ({ page }) => {
  // Stripes at angle 0 are bars ACROSS the strip, so bent round a ring they become spokes: the
  // same colour at the band's inner and outer edge. Laid over the frame they are vertical bars,
  // and inner/outer disagree wherever a bar edge crosses the band.
  const agree = async (stroke: Record<string, unknown>) => {
    await render(page, ring(stroke))
    const inner = await around(page, 0.2 - 0.02, 720)
    const outer = await around(page, 0.2 + 0.02, 720)
    let same = 0, both = 0
    for (let i = 0; i < 720; i++) {
      const a = inner[i]!, b = outer[i]!
      if (a[3]! < 200 || b[3]! < 200) continue
      both++
      if ((a[0]! > 127) === (b[0]! > 127)) same++
    }
    return { share: same / Math.max(1, both), both }
  }
  const follow = await agree({ paint: STRIPES, follow: true })
  const still = await agree({ paint: STRIPES })
  expect(follow.both, 'both edges inked').toBeGreaterThan(600)
  expect(follow.share, `followed: inner/outer agree ${follow.share}`).toBeGreaterThan(0.9)
  expect(still.share, `stays put: inner/outer agree ${still.share}`).toBeLessThan(follow.share - 0.1)
})

test('followed stripes close round the loop: an even number of colour runs', async ({ page }) => {
  await render(page, ring({ paint: STRIPES, follow: true }))
  const mid = await around(page, 0.2, 1440)
  const cls = mid.filter(p => p[3]! > 200).map(p => (p[0]! > 127 ? 1 : 0))
  let runs = 0
  for (let i = 0; i < cls.length; i++) if (cls[i] !== cls[(i + 1) % cls.length]) runs++
  expect(runs).toBeGreaterThan(8)
  expect(runs % 2, `runs=${runs}`).toBe(0)
})

test('followed ombre fades inner edge → outer edge at EVERY angle', async ({ page }) => {
  await render(page, ring({ paint: OMBRE, follow: true }))
  const inner = await around(page, 0.2 - 0.025, 720)
  const outer = await around(page, 0.2 + 0.025, 720)
  // Four quadrants, each on its own: laid over the frame, an angle-0 ombre would be light on the
  // LEFT and dark on the RIGHT whatever the radius.
  for (let q = 0; q < 4; q++) {
    const slice = (xs: number[][]) => xs.slice(q * 180, (q + 1) * 180).filter(p => p[3]! > 200)
    const darkShare = (xs: number[][]) => slice(xs).filter(dark).length / Math.max(1, slice(xs).length)
    expect(darkShare(inner), `quadrant ${q} inner`).toBeLessThan(0.3)
    expect(darkShare(outer), `quadrant ${q} outer`).toBeGreaterThan(0.7)
  }
})

test('followed ombre is still GRAIN, not a smooth blend', async ({ page }) => {
  await render(page, ring({ paint: OMBRE, follow: true }))
  const mid = await around(page, 0.2, 720)
  const inked = mid.filter(p => p[3]! > 200)
  const grey = inked.filter(p => p[0]! > 60 && p[0]! < 195).length
  expect(inked.length).toBeGreaterThan(600)
  expect(grey / inked.length, 'pixels are A or B, not mid-greys').toBeLessThan(0.1)
  expect(inked.filter(light).length).toBeGreaterThan(100)
  expect(inked.filter(dark).length).toBeGreaterThan(100)
})

test('ombre along the line: repeats set how many times it thickens round the loop', async ({ page }) => {
  await render(page, ring({ paint: OMBRE, follow: true, fade: 'along', fadeRepeats: 3 }))
  const mid = await around(page, 0.2, 720)
  // Smooth the grain: dark share in 24 windows of 15°. Then count the times the share RISES
  // through one half, going round once — one per repeat, wherever round the loop the strip
  // happens to start (a peak count would depend on that phase).
  const share = Array.from({ length: 24 }, (_, w) => {
    const xs = mid.slice(w * 30, (w + 1) * 30).filter(p => p[3]! > 200)
    return xs.filter(dark).length / Math.max(1, xs.length)
  })
  let rises = 0
  for (let i = 0; i < 24; i++) if (share[i]! < 0.5 && share[(i + 1) % 24]! >= 0.5) rises++
  expect(rises, `window shares ${share.map(s => s.toFixed(2)).join(' ')}`).toBe(3)
})

test('a followed stroke on a RECT, a STAR and a WOBBLED band inks its whole band', async ({ page }) => {
  // Coverage, not looks: the followed band must ink at least ~as much as the same band stays put.
  const red = { type: 'stripes', a: '#ff0000', b: '#e00000', textColor: '#fff', angle: 0, density: 8 }
  const count = async (layers: unknown[]) => {
    await render(page, layers)
    return page.evaluate(() => {
      const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 150 && d[i + 1]! < 90 && d[i + 3]! > 200) n++
      return n
    })
  }
  const base = { rotation: 0, opacity: 1, visible: true, fill: 'none' }
  const cases: [string, (s: Record<string, unknown>) => unknown[]][] = [
    ['rect', (s) => [{ id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.3, radius: 0, ...base, strokes: [{ id: 's1', width: 0.03, ...s }] }]],
    ['star', (s) => [{ id: 't', kind: 'star', x: 0.5, y: 0.5, w: 0.4, h: 0.4, points: 5, innerRatio: 0.5, cornerRadius: 0, ...base, strokes: [{ id: 's1', width: 0.02, ...s }] }]],
    ['wobble', (s) => [{ id: 'w', kind: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, ...base, strokes: [{ id: 's1', width: 0.03, wobble: 'wave', wobbleAmount: 0.01, wobbleLength: 0.08, ...s }] }]],
  ]
  for (const [name, make] of cases) {
    const still = await count(make({ paint: red }))
    const follow = await count(make({ paint: red, follow: true }))
    expect(still, `${name}: control inks`).toBeGreaterThan(500)
    expect(follow / still, `${name}: followed ${follow} vs still ${still}`).toBeGreaterThan(0.85)
    expect(follow / still, `${name}: followed ${follow} vs still ${still}`).toBeLessThan(1.15)
  }
})
