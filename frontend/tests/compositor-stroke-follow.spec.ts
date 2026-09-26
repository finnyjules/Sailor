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

// Two closed subpaths (outer square ±0.2, inner square ±0.1, evenodd): a square with a square
// HOLE. The shape's material lies between the rings, so the inner ring's "outside" is INTO the hole.
const HOLED_D = 'M -0.2 -0.2 L 0.2 -0.2 L 0.2 0.2 L -0.2 0.2 Z M -0.1 -0.1 L 0.1 -0.1 L 0.1 0.1 L -0.1 0.1 Z'
const holed = (stroke: Record<string, unknown>) => [{
  id: 'p', kind: 'path', x: 0.5, y: 0.5, rotation: 0, opacity: 1, visible: true, scale: 1,
  d: HOLED_D, bbox: { w: 0.4, h: 0.4 }, fill: 'none', fillRule: 'evenodd',
  strokes: [{ id: 's1', width: 0.02, distance: 0, align: 'center', join: 'round', ...stroke }],
}]
/** Pixels matching `kind` counted by Chebyshev distance from the centre (a fraction of the
 *  canvas width): within 0.03 of the hole ring (0.1) or of the outer ring (0.2). */
async function byRing(page: Page, kind: 'red'): Promise<{ inner: number; outer: number }> {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    const cx = cv.width / 2, cy = cv.height / 2
    let inner = 0, outer = 0
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4
      if (!(d[i]! > 150 && d[i + 1]! < 90 && d[i + 3]! > 200)) continue
      const r = Math.max(Math.abs(x + 0.5 - cx), Math.abs(y + 0.5 - cy)) / cv.width
      if (Math.abs(r - 0.1) < 0.03) inner++
      else if (Math.abs(r - 0.2) < 0.03) outer++
    }
    return { inner, outer }
  })
}

test('a COMPOUND path bends every ring, on the side the SHAPE says — centre, inside, outside, distance', async ({ page }) => {
  // The band mask covers BOTH rings and decides inside/outside against the whole shape. A hole
  // ring bent only along the longest ring — or offset by its OWN winding, which for a hole points
  // the wrong way — leaves the hole ring's band (almost) empty.
  test.setTimeout(150_000)   // four cases, two renders each
  const red = { type: 'stripes', a: '#ff0000', b: '#e00000', textColor: '#fff', angle: 0, density: 8 }
  const cases: [string, Record<string, unknown>][] = [
    ['centre', { align: 'center' }],
    ['inside', { align: 'inside' }],
    ['outside', { align: 'outside' }],
    ['distance 0.02', { align: 'center', distance: 0.02 }],
  ]
  for (const [name, s] of cases) {
    await render(page, holed({ paint: red, ...s }))
    const still = await byRing(page, 'red')
    await render(page, holed({ paint: red, ...s, follow: true }))
    const follow = await byRing(page, 'red')
    expect(still.inner, `${name}: control inks the hole ring`).toBeGreaterThan(500)
    expect(follow.inner / still.inner, `${name}: hole ring followed ${follow.inner} vs still ${still.inner}`).toBeGreaterThan(0.85)
    expect(follow.outer / still.outer, `${name}: outer ring followed ${follow.outer} vs still ${still.outer}`).toBeGreaterThan(0.85)
  }
})

test('a followed ombre on a holed shape starts on the MATERIAL side of the hole ring too', async ({ page }) => {
  // Across fade: colour A on the side inside the shape's material, B away from it. For the hole
  // ring the material is OUTSIDE the ring (r > 0.1), the hole inside it.
  await render(page, holed({ paint: OMBRE, follow: true, width: 0.04 }))
  const shares = await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    const cx = cv.width / 2, cy = cv.height / 2
    const side = { material: [0, 0], hole: [0, 0] }
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4
      if (d[i + 3]! < 200) continue
      const r = Math.max(Math.abs(x + 0.5 - cx), Math.abs(y + 0.5 - cy)) / cv.width
      const k = r > 0.112 && r < 0.118 ? 'material' : r > 0.082 && r < 0.088 ? 'hole' : null
      if (!k) continue
      side[k][1]++
      if (d[i]! < 100) side[k][0]++
    }
    return { material: side.material[0] / Math.max(1, side.material[1]), hole: side.hole[0] / Math.max(1, side.hole[1]), n: side.material[1] + side.hole[1] }
  })
  expect(shares.n).toBeGreaterThan(500)
  expect(shares.material, `material side dark (B) share ${shares.material}`).toBeLessThan(0.3)
  expect(shares.hole, `hole side dark (B) share ${shares.hole}`).toBeGreaterThan(0.7)
})

test('followed ombre grain rides the layer: moved by whole pixels, the dots move with it', async ({ page }) => {
  // Hashed in layer-local coordinates, a shift of 7 device px moves every dot 7 px. Hashed on
  // the screen, the dots would stay put while the fade slid under them: in the grainy middle of
  // the band barely more than half the pixels would still match.
  const w = await page.evaluate(() => (document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement).width)
  const dx = 7 / w
  const ombreRing = (x: number) => [{ ...ring({ paint: OMBRE, follow: true })[0], x }]
  const px = async (x: number) => {
    await render(page, ombreRing(x))
    return page.evaluate(() => {
      const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
      return Array.from(cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data)
    })
  }
  const a = await px(0.5)
  const b = await px(0.5 + dx)
  const h = a.length / 4 / w
  let same = 0, n = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 7; x++) {
    const r = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / w
    if (Math.abs(r - 0.2) > 0.01) continue          // the grainy middle of the band
    const i = (y * w + x) * 4, j = (y * w + x + 7) * 4
    if (a[i + 3]! < 250 || b[j + 3]! < 250) continue
    n++
    if (Math.abs(a[i]! - b[j]!) < 40) same++
  }
  expect(n).toBeGreaterThan(2000)
  expect(same / n, `dots that moved with the layer: ${same}/${n}`).toBeGreaterThan(0.97)
})

test('at a DISTANCE (3× width) every outer corner of a rect and a star is fully inked', async ({ page }) => {
  // The band's corner at a distance is an ARC round the shape's own corner (the mask is a
  // round-join dilation). A centreline MITRED out past that arc leaves the corner with no bent
  // paint under it — at 4× width a hole straight through the band. Measured CORNER-LOCALLY: a
  // whole-canvas ratio hides a corner behind four long straight runs.
  test.setTimeout(120_000)
  const red = { type: 'stripes', a: '#ff0000', b: '#e00000', textColor: '#fff', angle: 0, density: 8 }
  const base = { rotation: 0, opacity: 1, visible: true, fill: 'none' }
  const W = 0.02, D = 3 * W
  const stroke = (s: Record<string, unknown>) => [{ id: 's1', width: W, distance: D, align: 'center', join: 'round', ...s }]
  // Each corner is named by the direction it points: the band's outermost red pixel along that
  // direction is the tip of the corner's outer arc; the window sits half a width back inside it,
  // on the band's centreline.
  const star = Array.from({ length: 5 }, (_, k) => { const t = -Math.PI / 2 + (k * 2 * Math.PI) / 5; return [Math.cos(t), Math.sin(t)] as [number, number] })
  const cases: [string, (s: Record<string, unknown>) => unknown[], [number, number][]][] = [
    ['rect', (s) => [{ id: 'r', kind: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.3, radius: 0, ...base, strokes: stroke(s) }],
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => [x! / Math.SQRT2, y! / Math.SQRT2] as [number, number])],
    ['star', (s) => [{ id: 't', kind: 'star', x: 0.5, y: 0.5, w: 0.3, h: 0.3, points: 5, innerRatio: 0.5, cornerRadius: 0, ...base, strokes: stroke(s) }], star],
  ]
  const corners = (dirs: [number, number][], at: { cx: number; cy: number; half: number }[] | null) =>
    page.evaluate(({ dirs, at, W }) => {
      const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
      const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
      const isRed = (x: number, y: number) => { const i = (y * cv.width + x) * 4; return d[i]! > 150 && d[i + 1]! < 90 && d[i + 3]! > 200 }
      const wins = at ?? dirs.map(([ux, uy]) => {
        let best = -Infinity, bx = 0, by = 0
        for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
          if (!isRed(x, y)) continue
          const p = (x - cv.width / 2) * ux + (y - cv.height / 2) * uy
          if (p > best) { best = p; bx = x; by = y }
        }
        const back = (W / 2) * cv.width
        return { cx: bx - ux * back, cy: by - uy * back, half: Math.max(2, Math.floor(0.3 * W * cv.width)) }
      })
      const counts = wins.map(w => {
        let n = 0
        for (let y = Math.round(w.cy - w.half); y <= Math.round(w.cy + w.half); y++)
          for (let x = Math.round(w.cx - w.half); x <= Math.round(w.cx + w.half); x++) if (isRed(x, y)) n++
        return n
      })
      return { wins, counts }
    }, { dirs, at, W })
  const short: string[] = []
  for (const [name, make, dirs] of cases) {
    await render(page, make({ paint: red }))
    const still = await corners(dirs, null)
    await render(page, make({ paint: red, follow: true }))
    const follow = await corners(dirs, still.wins)
    still.counts.forEach((n, k) => {
      expect(n, `${name} corner ${k}: control inks its window`).toBeGreaterThan(20)
      if (follow.counts[k]! / n < 0.9) short.push(`${name} corner ${k}: followed ${follow.counts[k]} vs still ${n}`)
    })
  }
  expect(short, 'corners the followed band leaves short of ink').toEqual([])
  // For the eye: the same two at 3× width, in stripes that show which way the paint runs.
  const look = { type: 'stripes', a: '#ff3b30', b: '#1d3bff', textColor: '#fff', angle: 0, density: 8 }
  await render(page, [
    { ...cases[0]![1]({ paint: look, follow: true })[0] as object, x: 0.28, w: 0.22, h: 0.16 },
    { ...cases[1]![1]({ paint: look, follow: true })[0] as object, x: 0.72, w: 0.24, h: 0.24 },
  ])
  await page.locator('[data-testid="compositor-stack-canvas"]').screenshot({
    path: '/private/tmp/claude-501/-Users-julien-Documents-GitHub-Sailor/32b5e250-c307-4162-b15a-4e4f8547b0f7/scratchpad/follow-distance-corners.png',
  })
})
