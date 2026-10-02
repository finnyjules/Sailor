import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { openBlankWorkflow, waitForBackend, stackPixels } from './_helpers'
import { renderExported } from './_frameEmbedHelpers'

/**
 * Frame light layers, stage 1 — the real editor. A Frame with a coloured background, a text layer
 * and a shape; lights added from the toolbar or seeded through the editor's own `commit`, dots
 * dragged with the real mouse, switches flipped with real clicks. Every claim is a pixel read of
 * the stack canvas (through a copy, see _helpers `stackPixels`), with the numbers printed.
 *
 * Lights make no network calls, so nothing is mocked. Run against the running :3002.
 */
test.describe.configure({ timeout: 240_000 })

/** Where the screenshots worth looking at go: test-results by default, LIGHT_SHOTS to keep them. */
const SHOTS = process.env.LIGHT_SHOTS ?? 'test-results/frame-light-layers-shots'

const BG = '#56657a'
const TEXT = { id: 'word', kind: 'text', x: 0.5, y: 0.38, rotation: 0, opacity: 1, text: 'LIGHT', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.16, color: '#f4f1ea', align: 'center', lineHeight: 1.2, strokeColor: '#000000', strokeWidth: 0 }
const SHAPE = { id: 'shape', kind: 'rect', x: 0.5, y: 0.72, w: 0.4, h: 0.16, rotation: 0, opacity: 1, fill: '#e0b040', stroke: '', strokeWidth: 0, radius: 0 }
const BASE = [SHAPE, TEXT]   // bottom → top

const LIGHT_DEFAULTS = {
  lamp: { type: 'lamp', height: 0.55, color: '#ffb36b', brightness: 1.6, reach: 1.0, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 },
  spot: { type: 'spot', height: 0.8, color: '#fff1d6', brightness: 2.2, reach: 1.4, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 },
  sun: { type: 'sun', height: 0.4, color: '#fff3e2', brightness: 1.2, reach: 1.0, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 },
} as const
const light = (id: string, type: keyof typeof LIGHT_DEFAULTS, x: number, y: number, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'light', x, y, rotation: 0, opacity: 1, light: { ...LIGHT_DEFAULTS[type], ...over } })

// ── Setup ─────────────────────────────────────────────────────────────────────────────────────
/** A blank project with ONE Frame (W×H, coloured background), its editor open. */
async function openFrame(page: Page, W = 1000, H = 1000, bg = BG) {
  await openBlankWorkflow(page)
  await waitForBackend(page)
  await page.evaluate(([w, h, b]) => window.dispatchEvent(new CustomEvent('sailor:addNode', {
    detail: { nodeType: 'Compositor', widgetOverrides: { width: w, height: h }, propertyOverrides: { sailor_localBg: b } },
  })), [W, H, bg] as const)
  await openEditor(page)
}
async function openEditor(page: Page, opts: { grid?: boolean } = {}) {
  const node = page.locator('.vue-flow__node').first()
  await node.waitFor({ state: 'attached', timeout: 60_000 })
  const nodeId = await node.getAttribute('data-id')
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: id } })), nodeId)
  await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => typeof (window as any).__compositorSetLayers === 'function'), { timeout: 10_000 }).toBe(true)
  if (!opts.grid) await gridOff(page)
}
/** Hide the Frame's layout grid (⇧G) so its guide lines stay out of the screenshots. */
async function gridOff(page: Page) {
  const overlay = page.getByTestId('compositor-grid-overlay')
  if (!(await overlay.count())) return
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.keyboard.press('Shift+G')
  await expect(overlay).toHaveCount(0)
}
async function setLayers(page: Page, layers: unknown[]) {
  await page.evaluate((ls) => (window as any).__compositorSetLayers(JSON.parse(JSON.stringify(ls))), layers)
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length), { timeout: 10_000 }).toBe(layers.length)
}
const layers = (page: Page) => page.evaluate(() => (window as any).__compositorLayers() as any[])
const lightRuns = (page: Page) => page.evaluate(() => (window as any).__lightingRuns?.() ?? -1)
const mapStamps = (page: Page) => page.evaluate(() => (window as any).__lightingMapStamps?.() ?? -1)

/** Set a StudioSlider row by typed entry (the first match: Darkness shows in one card at a time). */
async function setRow(page: Page, testid: string, value: number) {
  const row = page.getByTestId(testid).first()
  await row.locator('[data-row-value]').click()
  const input = row.locator('input')
  await input.fill(String(value))
  await input.press('Enter')
}

// ── Pixels ────────────────────────────────────────────────────────────────────────────────────
/** Settle the stack canvas (two equal reads), then keep a copy of its pixels in the page as `name`. */
async function snap(page: Page, name: string): Promise<string> {
  const url = await stackPixels(page)
  await page.evaluate(([n, u]) => new Promise<void>((res) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0)
      const w = window as any; w.__snaps ??= {}
      w.__snaps[n!] = { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data }
      res()
    }
    img.src = u!
  }), [name, url])
  return url
}
/** Keep any PNG/data URL as a snapshot, resampled to the size of snapshot `like`. */
async function snapUrl(page: Page, name: string, url: string, like: string) {
  await page.evaluate(([n, u, l]) => new Promise<void>((res) => {
    const w = window as any
    const ref = w.__snaps[l!]
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = ref.w; c.height = ref.h
      const g = c.getContext('2d', { willReadFrequently: true })!
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, ref.w, ref.h)
      w.__snaps[n!] = { w: ref.w, h: ref.h, d: g.getImageData(0, 0, ref.w, ref.h).data }
      res()
    }
    img.src = u!
  }), [name, url, like])
}
type Box = [number, number, number, number]   // x0, y0, x1, y1 as fractions of the canvas
/** Mean luminance (0..255) of a region of a snapshot. */
const mean = (page: Page, name: string, b: Box) => page.evaluate(([n, b]) => {
  const s = (window as any).__snaps[n as string]
  const [x0, y0, x1, y1] = (b as number[]).map((v, i) => Math.round(v * (i % 2 ? s.h : s.w)))
  let sum = 0, k = 0
  for (let y = y0!; y < y1!; y++) for (let x = x0!; x < x1!; x++) {
    const i = (y * s.w + x) * 4
    sum += 0.299 * s.d[i] + 0.587 * s.d[i + 1] + 0.114 * s.d[i + 2]; k++
  }
  return Math.round((sum / k) * 100) / 100
}, [name, b] as const)
const halves = async (page: Page, name: string) => ({
  left: await mean(page, name, [0, 0, 0.5, 1]), right: await mean(page, name, [0.5, 0, 1, 1]),
})
/** Per-cell mean luminance over a g×g grid: the "same picture" comparison across resolutions. */
const gridMeans = (page: Page, name: string, g = 6) => page.evaluate(([n, g]) => {
  const s = (window as any).__snaps[n as string]
  const out: number[] = []
  for (let cy = 0; cy < (g as number); cy++) for (let cx = 0; cx < (g as number); cx++) {
    const x0 = Math.round(cx * s.w / (g as number)), x1 = Math.round((cx + 1) * s.w / (g as number))
    const y0 = Math.round(cy * s.h / (g as number)), y1 = Math.round((cy + 1) * s.h / (g as number))
    let sum = 0, k = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * s.w + x) * 4; sum += 0.299 * s.d[i] + 0.587 * s.d[i + 1] + 0.114 * s.d[i + 2]; k++
    }
    out.push(sum / k)
  }
  return out
}, [name, g] as const)
const maxCellDiff = (a: number[], b: number[]) => Math.round(Math.max(...a.map((v, i) => Math.abs(v - b[i]!))) * 100) / 100

/** The text's pixel box in a snapshot: pixels close to the text colour (#f4f1ea). */
const textBox = (page: Page, name: string) => page.evaluate((n) => {
  const s = (window as any).__snaps[n]
  let x0 = s.w, y0 = s.h, x1 = -1, y1 = -1
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const i = (y * s.w + x) * 4
    if (s.d[i] > 225 && s.d[i + 1] > 222 && s.d[i + 2] > 215) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  }
  return { x0, y0, x1, y1, w: s.w, h: s.h }
}, name)

// ── Mouse ─────────────────────────────────────────────────────────────────────────────────────
async function canvasRect(page: Page) {
  return (await page.getByTestId('compositor-stack-canvas').boundingBox())!
}
/** Drag a light's dot (real mouse) to a Frame fraction. */
async function dragDotTo(page: Page, dot: ReturnType<Page['locator']>, fx: number, fy: number, steps = 14) {
  const b = (await dot.boundingBox())!
  const r = await canvasRect(page)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(r.x + fx * r.width, r.y + fy * r.height, { steps })
  await page.mouse.up()
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Frame light layers (stage 1) — real editor', () => {
  test('no light is byte-identical; a lamp from the toolbar shows its dot, a top row and the row switches', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    const runs0 = await lightRuns(page)
    const stamps0 = await mapStamps(page)
    const unlit = await snap(page, 'unlit')
    // No light: the lighting pass never ran and no map was stamped.
    expect(runs0).toBe(0)
    expect(stamps0).toBe(0)
    await expect(page.getByTestId('row-casts-shadow')).toHaveCount(0)
    await expect(page.getByTestId('row-lit')).toHaveCount(0)
    await expect(page.getByTestId('light-dot')).toHaveCount(0)

    // 2. Add a lamp from the toolbar.
    await page.getByTestId('add-light').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    const ls = await layers(page)
    expect(ls.map(l => l.kind)).toEqual(['rect', 'text', 'light'])   // the light is the TOP layer
    const lampId = ls[2].id
    await expect(page.getByTestId('light-dot')).toHaveAttribute('data-light-id', lampId)
    // The light's row is the first row of the layer list.
    await expect(page.getByTestId('light-row-swatch')).toHaveCount(1)
    const rowsTop = await page.evaluate(() => {
      const sw = document.querySelector('[data-testid="light-row-swatch"]')!.getBoundingClientRect().top
      const others = [...document.querySelectorAll('[data-testid="row-lit"]')].map(e => e.getBoundingClientRect().top)
      return { sw, others }
    })
    expect(rowsTop.others.length).toBe(2)
    for (const t of rowsTop.others) expect(rowsTop.sw).toBeLessThan(t)
    // The row switches appear on the two other rows, both on.
    await expect(page.getByTestId('row-casts-shadow')).toHaveCount(2)
    await expect(page.getByTestId('row-lit')).toHaveCount(2)
    for (const id of ['row-casts-shadow', 'row-lit']) for (let i = 0; i < 2; i++) await expect(page.getByTestId(id).nth(i)).toHaveAttribute('aria-pressed', 'true')
    const lit = await snap(page, 'lit')
    expect(await lightRuns(page)).toBeGreaterThan(0)
    expect(lit).not.toBe(unlit)
    await page.screenshot({ path: `${SHOTS}/1-lamp-added.png` })
    // The selected light's inspector header has no stack-order or grid buttons (only Delete).
    await expect(page.getByTestId('frame-layer-head')).toBeVisible()
    for (const title of ['Bring forward', 'Send backward', 'Re-snap to grid']) await expect(page.getByTitle(title, { exact: true })).toHaveCount(0)

    // 1. Byte-identity: a Darkness edit writes the Frame record, then the light goes. The Frame
    //    must paint exactly as it did before any light code ran, with no further lighting runs.
    await setRow(page, 'light-darkness', 80)
    await expect.poll(async () => (await snap(page, 'dark80')) !== lit).toBe(true)
    await page.getByTestId('light-delete').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(0)
    const runsAfterDelete = await lightRuns(page)
    const after = await snap(page, 'after')
    console.log('[byte-identity] lighting runs before any light:', runs0, 'after delete:', runsAfterDelete, 'identical:', after === unlit)
    expect(after).toBe(unlit)
    await page.waitForTimeout(500)
    expect(await lightRuns(page)).toBe(runsAfterDelete)
    await expect(page.getByTestId('row-lit')).toHaveCount(0)
  })

  test('dragging the lamp left → right flips the brighter half; one ⌘Z puts it back', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    const unlit = await snap(page, 'unlit')
    await page.getByTestId('add-light').click()
    const dot = page.getByTestId('light-dot')
    await expect(dot).toHaveCount(1)
    await dragDotTo(page, dot, 0.08, 0.5)
    await expect.poll(async () => (await layers(page))[2].x, { timeout: 5_000 }).toBeLessThan(0.12)
    const posL = (await layers(page))[2]
    await snap(page, 'L')
    const runsL = await lightRuns(page)
    await page.screenshot({ path: `${SHOTS}/2-lamp-left.png` })

    await dragDotTo(page, dot, 0.92, 0.5)
    await expect.poll(async () => (await layers(page))[2].x, { timeout: 5_000 }).toBeGreaterThan(0.88)
    await snap(page, 'R')
    expect(await lightRuns(page)).toBeGreaterThan(runsL)
    await page.screenshot({ path: `${SHOTS}/2-lamp-right.png` })

    const u = await halves(page, 'unlit'), l = await halves(page, 'L'), r = await halves(page, 'R')
    console.log('[drag] per-half mean luminance — unlit:', u, 'lamp left:', l, 'lamp right:', r)
    // Unlit, the halves differ by 0.5 levels; every gap below was measured at 8–9 levels.
    expect(Math.abs(u.left - u.right)).toBeLessThan(1)
    expect(l.left - l.right).toBeGreaterThan(5)        // lamp at the left: the left half is brighter
    expect(r.right - r.left).toBeGreaterThan(5)        // and after the drag, the right half
    expect(l.left - r.left).toBeGreaterThan(5)         // the left half got darker
    expect(r.right - l.right).toBeGreaterThan(5)       // the right half brighter

    // One ⌘Z: the lamp is back where the drag started, and so is the picture.
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await layers(page))[2].x, { timeout: 5_000 }).toBeCloseTo(posL.x, 5)
    expect((await layers(page))[2].y).toBeCloseTo(posL.y, 5)
    await snap(page, 'undo')
    const back = await halves(page, 'undo')
    console.log('[drag] after one undo:', back, 'position', (await layers(page))[2].x, (await layers(page))[2].y)
    expect(Math.abs(back.left - l.left)).toBeLessThan(0.5)
    expect(Math.abs(back.right - l.right)).toBeLessThan(0.5)
    expect(unlit).not.toBe(await stackPixels(page))
  })

  test('the text shadow falls away from the lamp; bulb off leaves the text untouched; Darkness 0 never darkens', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    await snap(page, 'unlit')
    const tb = await textBox(page, 'unlit')
    console.log('[text box px]', tb)
    expect(tb.x1 - tb.x0).toBeGreaterThan(150)
    // A low, bright lamp just left of the text, level with it: long shadows to the right.
    await setLayers(page, [...BASE, light('lamp', 'lamp', 0.14, 0.38, { height: 0.25, brightness: 3, reach: 2 })])
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    await snap(page, 'shadow')
    await page.screenshot({ path: `${SHOTS}/3-text-shadow.png` })

    // 4. Strips just past the text: away from the lamp (right) and toward it (left), across the
    //    middle of the letters. Compared with the same lamp when the text casts no shadow.
    const away: Box = [(tb.x1 + 2) / tb.w, tb.y0 / tb.h, (tb.x1 + 40) / tb.w, tb.y1 / tb.h]
    const toward: Box = [(tb.x0 - 40) / tb.w, tb.y0 / tb.h, (tb.x0 - 2) / tb.w, tb.y1 / tb.h]
    await page.getByTestId('row-casts-shadow').nth(0).click()   // the text's row (rows: lamp, text, rect)
    await expect.poll(async () => (await layers(page)).find(l => l.id === 'word')?.castsShadow).toBe(false)
    await snap(page, 'noshadow')
    const m = {
      awayShadow: await mean(page, 'shadow', away), awayNoShadow: await mean(page, 'noshadow', away),
      towardShadow: await mean(page, 'shadow', toward), towardNoShadow: await mean(page, 'noshadow', toward),
    }
    console.log('[shadow] strip means', m)
    expect(m.awayNoShadow - m.awayShadow).toBeGreaterThan(6)               // the shadow lies on the far side (measured ~10)
    expect(Math.abs(m.towardNoShadow - m.towardShadow)).toBeLessThan(1.5)   // and not on the near side
    expect(m.towardShadow - m.awayShadow).toBeGreaterThan(8)
    await page.getByTestId('row-casts-shadow').nth(0).click()               // casting again
    await expect.poll(async () => (await layers(page)).find(l => l.id === 'word')?.castsShadow).not.toBe(false)

    // 5. The bulb off on the text: its pixels (2 px inside every edge) equal the unlit Frame's.
    await page.getByTestId('row-lit').nth(0).click()
    await expect.poll(async () => (await layers(page)).find(l => l.id === 'word')?.lit).toBe(false)
    await snap(page, 'bulboff')
    const inner = await page.evaluate(() => {
      const S = (window as any).__snaps
      const u = S.unlit, off = S.bulboff, on = S.shadow
      const isText = (x: number, y: number) => { const i = (y * u.w + x) * 4; return u.d[i] > 225 && u.d[i + 1] > 222 && u.d[i + 2] > 215 }
      let n = 0, maxOff = 0, sumOn = 0
      for (let y = 2; y < u.h - 2; y++) for (let x = 2; x < u.w - 2; x++) {
        let all = true
        for (let dy = -2; dy <= 2 && all; dy++) for (let dx = -2; dx <= 2 && all; dx++) if (!isText(x + dx, y + dy)) all = false
        if (!all) continue
        n++
        const i = (y * u.w + x) * 4
        for (let c = 0; c < 3; c++) { maxOff = Math.max(maxOff, Math.abs(off.d[i + c] - u.d[i + c])); sumOn += Math.abs(on.d[i + c] - u.d[i + c]) }
      }
      return { n, maxOff, meanOnDiff: Math.round((sumOn / (n * 3)) * 100) / 100 }
    })
    console.log('[bulb off] text interior px:', inner.n, 'max |bulb off − unlit|:', inner.maxOff, 'mean |lit − unlit| (control):', inner.meanOnDiff)
    expect(inner.n).toBeGreaterThan(1500)
    expect(inner.maxOff).toBe(0)
    expect(inner.meanOnDiff).toBeGreaterThan(5)
    await page.getByTestId('row-lit').nth(0).click()
    await expect.poll(async () => (await layers(page)).find(l => l.id === 'word')?.lit).not.toBe(false)

    // 6. Darkness 0: no pixel anywhere darker than the unlit Frame (shadows included).
    await page.getByTestId('light-dot').click()                             // select the lamp → All lights card
    await setRow(page, 'light-darkness', 0)
    await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length)).toBe(3)
    await snap(page, 'dark0')
    await page.screenshot({ path: `${SHOTS}/3-darkness-0.png` })
    const d0 = await page.evaluate(() => {
      const S = (window as any).__snaps, u = S.unlit, l = S.dark0
      let darker1 = 0, darker2 = 0, minDiff = 255, brighter = 0
      for (let i = 0; i < u.d.length; i += 4) for (let c = 0; c < 3; c++) {
        const d = l.d[i + c] - u.d[i + c]
        minDiff = Math.min(minDiff, d)
        if (d < -1) darker1++
        if (d < -2) darker2++
        if (d > 3) brighter++
      }
      return { darker1, darker2, minDiff, brighterChannels: brighter }
    })
    console.log('[darkness 0] channels darker than unlit by >1:', d0.darker1, '>2:', d0.darker2, 'most negative diff:', d0.minDiff, 'channels brighter by >3:', d0.brighterChannels)
    expect(d0.darker1).toBe(0)
    expect(d0.brighterChannels).toBeGreaterThan(10_000)   // the lamp really lit the Frame
  })

  test('a spot gives a pool; a sun lights the Frame evenly', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    await snap(page, 'unlit')
    const centre: Box = [0.45, 0.5, 0.55, 0.6], outside: Box = [0.03, 0.5, 0.13, 0.6]
    await setLayers(page, [...BASE, light('spot', 'spot', 0.5, 0.04, { aimX: 0.5, aimY: 0.55 })])
    await snap(page, 'spot')
    await page.screenshot({ path: `${SHOTS}/4-spot.png` })
    const sp = {
      unlitCentre: await mean(page, 'unlit', centre), unlitOutside: await mean(page, 'unlit', outside),
      centre: await mean(page, 'spot', centre), outside: await mean(page, 'spot', outside),
    }
    console.log('[spot] means', sp)
    expect(Math.abs(sp.unlitCentre - sp.unlitOutside)).toBeLessThan(1)
    expect(sp.centre - sp.outside).toBeGreaterThan(30)

    const corners: Box[] = [[0.03, 0.03, 0.15, 0.15], [0.85, 0.03, 0.97, 0.15], [0.03, 0.86, 0.15, 0.97], [0.85, 0.86, 0.97, 0.97]]
    await setLayers(page, [...BASE, light('sun', 'sun', 0.02, 0.35)])
    await snap(page, 'sun')
    await page.screenshot({ path: `${SHOTS}/4-sun.png` })
    const sun = await Promise.all(corners.map(b => mean(page, 'sun', b)))
    const un = await Promise.all(corners.map(b => mean(page, 'unlit', b)))
    // Control: a lamp in the same spot is anything but even.
    await setLayers(page, [...BASE, light('lamp', 'lamp', 0.02, 0.35)])
    await snap(page, 'lampc')
    const lamp = await Promise.all(corners.map(b => mean(page, 'lampc', b)))
    const spread = (a: number[]) => Math.round((Math.max(...a) - Math.min(...a)) * 100) / 100
    console.log('[sun] corner means', sun, 'spread', spread(sun), '| unlit', un, '| lamp control spread', spread(lamp))
    expect(spread(un)).toBeLessThan(0.5)
    expect(spread(sun)).toBeLessThan(1.5)
    expect(Math.abs(sun[0]! - un[0]!)).toBeGreaterThan(3)   // the sun did change the Frame
    expect(spread(lamp)).toBeGreaterThan(8)
  })

  test('the 7th light is refused (toolbar and ⌘D)', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    const add = page.getByTestId('add-light')
    for (let i = 0; i < 6; i++) {
      await add.click()
      await expect(page.getByTestId('light-dot')).toHaveCount(i + 1)
    }
    await expect(add).toBeDisabled()
    await add.click({ force: true }).catch(() => {})
    await page.getByTestId('light-dot').first().focus()
    await page.keyboard.press('Meta+d')
    await expect(page.getByText('A Frame holds up to 6 lights').first()).toBeVisible()
    const n = (await layers(page)).filter(l => l.kind === 'light').length
    console.log('[cap] lights after the 7th attempt:', n)
    expect(n).toBe(6)
    await expect(page.getByTestId('light-dot')).toHaveCount(6)
    await page.screenshot({ path: `${SHOTS}/5-six-lights.png` })
  })

  test('a reload keeps the lights, switches and Darkness', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    await page.getByTestId('add-light').click()
    await page.getByTestId('light-menu-toggle').click()
    await page.getByTestId('light-menu-spot').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    await page.getByTestId('row-casts-shadow').nth(0).click()    // text: no shadow
    await page.getByTestId('row-lit').nth(1).click()             // rect: not lit
    await page.getByTestId('light-dot').first().click()
    await setRow(page, 'light-darkness', 20)
    const want = (await layers(page)).map(l => ({ id: l.id, kind: l.kind, lit: l.lit, castsShadow: l.castsShadow, type: l.light?.type, x: l.x, y: l.y }))
    expect(want.find(l => l.id === 'word')!.castsShadow).toBe(false)
    expect(want.find(l => l.id === 'shape')!.lit).toBe(false)
    const before = await snap(page, 'before')
    await page.waitForTimeout(4_000)      // the project's debounced autosave
    await page.reload()
    await waitForBackend(page)
    await openEditor(page)
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    const got = (await layers(page)).map(l => ({ id: l.id, kind: l.kind, lit: l.lit, castsShadow: l.castsShadow, type: l.light?.type, x: l.x, y: l.y }))
    expect(got).toEqual(want)
    await page.getByTestId('light-dot').first().click()
    await expect(page.getByTestId('light-darkness').first().getByRole('slider')).toHaveAttribute('aria-valuenow', '20')
    await snap(page, 'reloaded')
    await snapUrl(page, 'before', before, 'reloaded')   // page state went with the reload
    const a = await gridMeans(page, 'before'), b = await gridMeans(page, 'reloaded')
    console.log('[reload] identical pixels:', (await stackPixels(page)) === before, 'max cell diff:', maxCellDiff(a, b))
    expect(maxCellDiff(a, b)).toBeLessThan(0.5)
  })

  test('Download PNG (the Render path) draws what the editor draws', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, BASE)
    await snap(page, 'unlitEditor')
    await setLayers(page, [...BASE, light('lamp', 'lamp', 0.1, 0.3, { height: 0.35 })])
    await snap(page, 'editor')
    const ed = await gridMeans(page, 'editor'), un = await gridMeans(page, 'unlitEditor')

    // renderStaticComposite at the Frame's own 1000×1000, resampled to the editor's canvas.
    await page.getByTestId('compositor-right-panel').getByRole('button', { name: /^Download/ }).click()
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('Download PNG', { exact: true }).click()])
    const png = await readFile((await dl.path())!)
    const pngUrl = `data:image/png;base64,${png.toString('base64')}`
    const size = await page.evaluate((u) => new Promise<number[]>((res) => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = u }), pngUrl)
    expect(size).toEqual([1000, 1000])
    await snapUrl(page, 'png', pngUrl, 'editor')
    const pg = await gridMeans(page, 'png')
    // The lamp's corner and the text's shadow, region by region (canvas fractions).
    const regions: Record<string, Box> = { lamp: [0.02, 0.2, 0.18, 0.4], shadow: [0.74, 0.3, 0.86, 0.46], far: [0.8, 0.85, 0.98, 0.98] }
    const reg: Record<string, number[]> = {}
    for (const [k, b] of Object.entries(regions)) reg[k] = [await mean(page, 'editor', b), await mean(page, 'png', b), await mean(page, 'unlitEditor', b)]
    console.log('[png] max 6×6 cell diff vs editor:', maxCellDiff(pg, ed), '| editor vs unlit (teeth):', maxCellDiff(ed, un), '| regions [editor, png, unlit]:', JSON.stringify(reg))
    expect(maxCellDiff(pg, ed)).toBeLessThan(3)
    expect(maxCellDiff(ed, un)).toBeGreaterThan(15)
    for (const [editor, file] of Object.values(reg)) expect(Math.abs(editor! - file!)).toBeLessThan(3)
  })

  // The web export's painter (lib/embed/surfaces/frame.ts) mounted in the app page over a REAL
  // snapshot (planFrameExport + buildFrameSnapshot, the modal's own path), at exactly the editor
  // canvas's size, compared with the editor. Shapes only, so the snapshot needs no font.
  test('web export painter: a lit snapshot draws what the editor draws', async ({ page }) => {
    const W = 1000, H = 500, bg = '#1b4d3e'
    await openFrame(page, W, H, bg)
    const shapes = [
      { ...SHAPE, id: 'a', x: 0.3, y: 0.45, w: 0.22, h: 0.3, fill: '#e0b040' },
      { id: 'b', kind: 'ellipse', x: 0.68, y: 0.55, w: 0.16, h: 0.32, rotation: 0, opacity: 1, fill: '#e2554f', stroke: '', strokeWidth: 0 },
    ]
    const lit = [...shapes, light('lamp', 'lamp', 0.08, 0.25, { height: 0.35 })]
    await setLayers(page, shapes)
    await snap(page, 'unlitEditor')
    await setLayers(page, lit)
    await snap(page, 'editor')
    const exported = async (ls: unknown[], name: string) => {
      const url = await page.evaluate(async ([ls, W, H, bg]) => {
        const plan = await import('/_nuxt/lib/embed/frame/plan.ts' as string)
        const gather = await import('/_nuxt/lib/embed/frame/gather.ts' as string)
        const appIO = await import('/_nuxt/lib/embed/frame/appIO.ts' as string)
        const surfaces = await import('/_nuxt/lib/embed/surfaces.ts' as string)
        const layers = ls as any[]
        const variant = {
          width: W, height: H, layers, stackOrder: layers.map((l: any) => `l:${l.id}`), groups: [], background: bg, post: [],
          motion: null, wiredTreatments: {}, lighting: { darkness: 0.45, backgroundLit: true },
        }
        const p = plan.planFrameExport({ variant, fit: 'fit', wiredSlots: [], catalogIds: new Set(), hasMotion: false, animatedFill: false })
        const snapshot = await gather.buildFrameSnapshot(p, variant, appIO.createAppFrameExportIO({ uploaded: [], wiredStill: () => null, catalog: [] }))
        const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
        const r = cv.getBoundingClientRect()
        const host = document.createElement('div')
        host.style.cssText = `position:fixed;left:0;top:0;width:${r.width}px;height:${r.height}px;z-index:-1`
        document.body.appendChild(host)
        const surface = await surfaces.loadEmbedSurface('frame')
        const handle = await surface.mount(host, snapshot)
        handle.setTime(0)
        await new Promise(res => setTimeout(res, 300))
        const out = (host.querySelector('canvas') as HTMLCanvasElement)
        const c = document.createElement('canvas'); c.width = out.width; c.height = out.height
        c.getContext('2d')!.drawImage(out, 0, 0)
        const url = c.toDataURL()
        handle.destroy(); host.remove()
        return { url, w: out.width, h: out.height, lights: snapshot.variants[0].layers.filter((l: any) => l.kind === 'light').length, lighting: snapshot.variants[0].lighting }
      }, [ls, W, H, bg] as const)
      console.log(`[web export painter] ${name}: canvas ${url.w}×${url.h}, lights in snapshot ${url.lights}, lighting ${JSON.stringify(url.lighting)}`)
      await snapUrl(page, name, url.url, 'editor')
      return url
    }
    const e = await exported(lit, 'export')
    expect(e.lights).toBe(1)
    await exported(shapes, 'exportUnlit')
    const diff = await page.evaluate(() => {
      const S = (window as any).__snaps
      const cmp = (a: any, b: any) => { let n = 0, max = 0; for (let i = 0; i < a.d.length; i += 4) { let m = 0; for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.d[i + c] - b.d[i + c])); if (m > 2) n++; max = Math.max(max, m) } return { over2: n, max, total: a.d.length / 4 } }
      return { lit: cmp(S.editor, S.export), unlit: cmp(S.unlitEditor, S.exportUnlit), teeth: cmp(S.editor, S.exportUnlit) }
    })
    const cells = maxCellDiff(await gridMeans(page, 'export'), await gridMeans(page, 'editor'))
    console.log('[web export painter] pixels off by >2 levels — lit:', diff.lit, '| unlit (control):', diff.unlit, '| lit editor vs unlit export (teeth):', diff.teeth, '| max 6×6 cell diff:', cells)
    expect(cells).toBeLessThan(2)
    expect(diff.lit.over2 / diff.lit.total).toBeLessThan(0.01)
    expect(diff.teeth.over2 / diff.teeth.total).toBeGreaterThan(0.3)
  })

  // The file itself: the editor's Web export sheet → Download → the file opened in a fresh page.
  test('web export file: the downloaded lit Frame looks like the editor', async ({ page, context }) => {
    const errors: string[] = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await openFrame(page)
    await setLayers(page, BASE)
    await snap(page, 'unlitEditor')
    await setLayers(page, [...BASE, light('lamp', 'lamp', 0.1, 0.3, { height: 0.35 })])
    await snap(page, 'editor')
    await page.getByTestId('compositor-right-panel').getByRole('button', { name: /^Download/ }).click()
    await page.getByTestId('frame-web-export').click()
    const sheet = page.getByTestId('frame-web-export-sheet')
    const ready = sheet.getByText('One file · plays anywhere'), failed = sheet.getByText("The export couldn't be built", { exact: false })
    await expect(ready.or(failed)).toBeVisible({ timeout: 90_000 })
    if (await failed.isVisible()) {
      const why = errors.find(e => e.includes('[Frame] web export failed')) ?? errors.join(' | ')
      throw new Error(`web export failed: ${why}`)
    }
    const sizeText = await page.getByTestId('frame-web-export-size').textContent()
    const [wdl] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Download' }).click()])
    const html = await readFile((await wdl.path())!, 'utf8')
    expect(html).toContain('"kind":"light"')
    const r = await canvasRect(page)
    const exp = await renderExported(context, html, 0, { width: Math.round(r.width), height: Math.round(r.height) })
    await snapUrl(page, 'web', exp.png, 'editor')
    const gw = await gridMeans(page, 'web'), ge = await gridMeans(page, 'editor')
    console.log('[web export file] cell diffs (web − editor):', gw.map((v, i) => Math.round((v - ge[i]!) * 10) / 10).join(' '))
    // The region compared is the Frame outside the "LIGHT" word (rows 1–2, columns 1–4 of the
    // 6×6 grid): the file draws the word with its embedded font cut, whose glyph widths differ a
    // little from the editor's — a font-fidelity difference, not a lighting one. Everything the
    // light shapes outside it (the lamp's falloff, the shape and its shadow, the background) must
    // match; an unlit export misses by far more than 3 levels in these cells.
    const inWord = (i: number) => { const r = Math.floor(i / 6), c = i % 6; return r >= 1 && r <= 2 && c >= 1 && c <= 4 }
    const cells = maxCellDiff(gw.filter((_, i) => !inWord(i)), ge.filter((_, i) => !inWord(i)))
    const word = maxCellDiff(gw.filter((_, i) => inWord(i)), ge.filter((_, i) => inWord(i)))
    console.log('[web export file] size', sizeText, '| requests', exp.requests.length, '| max cell diff outside the word:', cells, '| inside it:', word)
    expect(exp.requests).toEqual([])
    expect(cells).toBeLessThan(3)
    expect(word).toBeLessThan(6)
    // Teeth: the same cells against the UNLIT editor are far apart (the export really is lit).
    const gu = await gridMeans(page, 'unlitEditor')
    const teeth = maxCellDiff(gw.filter((_, i) => !inWord(i)), gu.filter((_, i) => !inWord(i)))
    console.log('[web export file] teeth — max cell diff vs the unlit editor:', teeth)
    expect(teeth).toBeGreaterThan(10)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Stage 2: photos with Relight take the Frame's lights.
//
// The puppy (`flux_lora_00165_.png`: its depth map and MoGe-2 normals are cached in
// input/sailor_depth) as a 0.6-wide photo in the middle of a 1000×1000 Frame, a small shape in the
// bottom-left corner, far from the photo and its lamps. /api/depth/surfaces is a PAID route: every
// stage-2 test answers it with the cached normals file (no fal call even if the cache were gone),
// and Finish and the upload are mocked too.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PUP_FILE = 'flux_lora_00165_.png'
const PUP_NORMALS = 'moge_a579ac8e5ca4ba75.png'
const PUP = { id: 'pup', kind: 'image', filename: PUP_FILE, x: 0.5, y: 0.5, w: 0.6, h: 0.6, rotation: 0, opacity: 1, effects: [] as unknown[] }
const CORNER = { ...SHAPE, id: 'corner', x: 0.12, y: 0.9, w: 0.16, h: 0.1 }
const PHOTO = [CORNER, PUP]   // bottom → top
/** The photo's box on the canvas (it spans 0.2..0.8), inset 5% of the box. */
const P = { x0: 0.23, y0: 0.23, x1: 0.77, y1: 0.77, mx: 0.5, my: 0.5 }
const photoHalves = async (page: Page, name: string) => ({
  left: await mean(page, name, [P.x0, P.y0, P.mx, P.y1]), right: await mean(page, name, [P.mx, P.y0, P.x1, P.y1]),
  top: await mean(page, name, [P.x0, P.y0, P.x1, P.my]), bottom: await mean(page, name, [P.x0, P.my, P.x1, P.y1]),
})
type PH = Awaited<ReturnType<typeof photoHalves>>
/** Lit ÷ plain per half, so the photo's own brighter parts don't count as light. */
const gains = (lit: PH, plain: PH) => {
  const r = (k: keyof PH) => Math.round((lit[k] / plain[k]) * 1000) / 1000
  return { left: r('left'), right: r('right'), top: r('top'), bottom: r('bottom') }
}
const relightRuns = (page: Page) => page.evaluate(() => (window as any).__relightRuns?.() ?? -1)
const lightsOf = (ls: any[]) => ls.filter(l => l.kind === 'light')
/** A Relight effect as it was stored before stage 2: its own lights, in fractions of the photo's box. */
const oldRelight = (lights: { id: string; x: number; y: number }[]) => ({
  id: 'fx-relight', type: 'relight', visible: true, keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true,
  lights: lights.map(l => ({ ...l, height: 0.4, color: '#ffcf94', brightness: 3, reach: 1.4, on: true })),
})

/** Pages whose MoGe-2 normals image has loaded (the facing tile is then re-made with surfaces). */
const normalsSeen = new WeakSet<Page>()
async function mockPaidRoutes(page: Page) {
  trackFacingModule(page)
  page.on('response', (r) => { if (r.url().includes(PUP_NORMALS) && r.ok()) normalsSeen.add(page) })
  await page.route('**/api/depth/surfaces', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ normalsFilename: PUP_NORMALS, subfolder: 'sailor_depth', cached: true }) }))
}
/** The URL the app loaded the facing pass from (the dev server adds an HMR `?t=` stamp, and a
 *  module imported under another URL is another instance with its own counters). */
const facingModuleUrl = new WeakMap<Page, string>()
function trackFacingModule(page: Page) {
  page.on('request', (r) => { if (r.url().includes('/lib/frame/lighting/facingPass.ts')) facingModuleUrl.set(page, r.url()) })
}
/** Facing tiles drawn so far (the per-photo shape pass that needs the depth field), read from the
 *  app's own module instance. Unknown (-1) until the app has loaded it — a wait then times out,
 *  never passes falsely. */
const tileRuns = (page: Page) => {
  const url = facingModuleUrl.get(page)
  return url ? page.evaluate(async (u) => (await import(u)).__facingTileRuns() as number, url) : Promise.resolve(-1)
}
/** Settled: no Relight pass ran for 1.5 s (the depth field and the normals have landed and their
 *  tile is drawn), then the stack canvas is stable. */
async function settleRelight(page: Page, tilesAtLeast = 0) {
  await expect.poll(() => tileRuns(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(tilesAtLeast)
  let prev = await relightRuns(page), still = 0
  for (let i = 0; i < 60 && still < 6; i++) {
    await page.waitForTimeout(250)
    const n = await relightRuns(page)
    still = n === prev ? still + 1 : 0
    prev = n
  }
  await stackPixels(page)
}
/** Right-click the photo → "Relight…" (the editor adds the effect and, with no light, a lamp). */
async function addRelightByMenu(page: Page) {
  const tiles0 = await tileRuns(page)
  const r = await canvasRect(page)
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button: 'right' })
  await page.getByText('Relight…', { exact: true }).click()
  await expect(page.locator('[data-testid="effect-row"][data-effect-kind="relight"]')).toHaveCount(1)
  // The facing tile, drawn once the depth field has landed (Finish and the lighting both need
  // it), and the normals image, whose arrival re-makes the tile with surfaces.
  await expect.poll(() => normalsSeen.has(page), { timeout: 60_000 }).toBe(true)
  await settleRelight(page, tiles0 + 1)
}
/** Drag the (only) lamp to a Frame fraction with the real mouse and wait for the new picture. */
async function moveLamp(page: Page, fx: number, fy: number, name: string) {
  const before = await stackPixels(page)
  await dragDotTo(page, page.getByTestId('light-dot').first(), fx, fy)
  await expect.poll(async () => { const l = lightsOf(await layers(page))[0]; return Math.hypot(l.x - fx, l.y - fy) }, { timeout: 5_000 }).toBeLessThan(0.02)
  await expect.poll(async () => (await stackPixels(page)) !== before, { timeout: 10_000 }).toBe(true)
  await snap(page, name)
}
const selectRelightRow = (page: Page) => page.locator('[data-testid="effect-row"][data-effect-kind="relight"]').click()

test.describe('Frame light layers (stage 2) — photos lit by Frame lights', () => {
  test.beforeEach(async ({ page }) => { await mockPaidRoutes(page) })

  test('no light, no Relight: nothing runs; adding Relight brings a lamp that the photo follows; one ⌘Z is byte-identical', async ({ page }) => {
    const normals = page.waitForResponse(r => r.url().includes(PUP_NORMALS) && r.ok(), { timeout: 120_000 })
    await openFrame(page)
    await setLayers(page, PHOTO)
    const plainUrl = await snap(page, 'plain')
    const runs0 = { light: await lightRuns(page), stamps: await mapStamps(page), relight: await relightRuns(page) }
    console.log('[s2 no light, no Relight] runs:', runs0)
    expect(runs0).toEqual({ light: 0, stamps: 0, relight: 0 })

    // 1. Relight from the right-click: a lamp lands at Golden key's place (right of the face).
    await addRelightByMenu(page)
    await normals
    await settleRelight(page)
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    const ls = await layers(page)
    expect(ls.map(l => l.kind)).toEqual(['rect', 'image', 'light'])
    const lamp = ls[2]
    console.log('[s2 add] lamp at', lamp.x.toFixed(3), lamp.y.toFixed(3), JSON.stringify(lamp.light))
    expect(lamp.x).toBeCloseTo(0.5 + 0.35 * 0.6, 3)   // Golden key: box (0.85, 0.3)
    expect(lamp.y).toBeCloseTo(0.5 - 0.2 * 0.6, 3)
    await snap(page, 'golden')
    await page.screenshot({ path: `${SHOTS}/s2-1-relight-added-lamp-right.png` })
    const plain = await photoHalves(page, 'plain')
    const gR = gains(await photoHalves(page, 'golden'), plain)
    console.log('[s2 add] photo gain per half, lamp at the right:', gR)
    expect(gR.right - gR.left).toBeGreaterThan(0.05)

    // 2. The lamp dragged to the left (real mouse): the left half gains more.
    await moveLamp(page, 0.14, 0.4, 'lampLeft')
    await page.screenshot({ path: `${SHOTS}/s2-2-lamp-left.png` })
    const gL = gains(await photoHalves(page, 'lampLeft'), plain)
    console.log('[s2 drag] photo gain per half, lamp at the left:', gL)
    // Original light (keep 0.12) evens the photo's own light out first — it lifts the darker right
    // half by ~20% whatever the lamp does — so the move is judged lamp place against lamp place:
    // the left half gains, the right half loses.
    expect(gL.left - gR.left).toBeGreaterThan(0.05)
    expect(gR.right - gL.right).toBeGreaterThan(0.05)

    // 8. Byte identity: undo the drag, then the add (ONE step: effect and lamp go together).
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => lightsOf(await layers(page))[0]?.x, { timeout: 5_000 }).toBeCloseTo(lamp.x, 5)
    await page.keyboard.press('Meta+z')
    await expect(page.getByTestId('light-dot')).toHaveCount(0)
    const back = await layers(page)
    expect(back.map(l => l.kind)).toEqual(['rect', 'image'])
    expect(back[1].effects ?? []).toEqual([])
    const runsAfter = { light: await lightRuns(page), relight: await relightRuns(page) }
    const after = await stackPixels(page)
    console.log('[s2 byte identity] after undoing Relight + lamp: identical to the plain Frame:', after === plainUrl)
    expect(after).toBe(plainUrl)
    await page.waitForTimeout(500)
    expect({ light: await lightRuns(page), relight: await relightRuns(page) }).toEqual(runsAfter)
  })

  test('surfaces: the floor faces up — a lamp above lights the bottom half more than one low in front', async ({ page }) => {
    const normals = page.waitForResponse(r => r.url().includes(PUP_NORMALS) && r.ok(), { timeout: 120_000 })
    await openFrame(page)
    await setLayers(page, PHOTO)
    await snap(page, 'plain')
    await addRelightByMenu(page)
    await normals
    await settleRelight(page)
    // Above the photo's top edge and near its bottom edge, both centred.
    await moveLamp(page, 0.5, 0.2 + 0.06 * 0.6, 'high')
    await page.screenshot({ path: `${SHOTS}/s2-2-lamp-high.png` })
    await moveLamp(page, 0.5, 0.2 + 0.92 * 0.6, 'low')
    await page.screenshot({ path: `${SHOTS}/s2-2-lamp-low.png` })
    const plain = await photoHalves(page, 'plain')
    const hi = gains(await photoHalves(page, 'high'), plain), lo = gains(await photoHalves(page, 'low'), plain)
    console.log('[s2 surfaces] gain per half — lamp high:', hi, 'lamp low:', lo)
    // Lamp place against lamp place (Original light evens the photo out first, see above): moving
    // the lamp up raises the top half more than the bottom half…
    expect(hi.top / lo.top).toBeGreaterThan(hi.bottom / lo.bottom + 0.05)
    // …and what only surfaces know: the floor (most of the bottom half) faces UP, so it takes the
    // lamp above better than the lamp low in front of it.
    expect(hi.bottom).toBeGreaterThan(lo.bottom)
  })

  test('Setups replace the Frame’s lights around the photo (count and places); one ⌘Z puts the lamp back', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, PHOTO)
    await addRelightByMenu(page)
    const golden = lightsOf(await layers(page))
    expect(golden.length).toBe(1)
    await expect(page.getByTestId('relight-setup-Golden key')).toHaveAttribute('aria-pressed', 'true')
    const before = await snap(page, 'golden')

    await page.getByTestId('relight-setup-Neon').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'true')
    const neon = lightsOf(await layers(page))
    console.log('[s2 setups] Neon lights:', neon.map(l => [l.id, l.x.toFixed(3), l.y.toFixed(3), l.light.color]))
    expect(neon.length).toBe(2)
    expect(neon.some(l => l.id === golden[0].id)).toBe(false)   // replaced, not added to
    // Neon's box places (0.05, 0.5) and (0.95, 0.45), mapped through the 0.6 photo in the middle.
    expect(neon[0].x).toBeCloseTo(0.5 - 0.45 * 0.6, 3); expect(neon[0].y).toBeCloseTo(0.5, 3)
    expect(neon[1].x).toBeCloseTo(0.5 + 0.45 * 0.6, 3); expect(neon[1].y).toBeCloseTo(0.5 - 0.05 * 0.6, 3)
    expect(neon.map(l => l.light.color)).toEqual(['#ff3fb4', '#29d8ff'])
    await expect(page.getByTestId('relight-light-2')).toHaveAttribute('data-light-id', neon[1].id)
    await expect.poll(async () => (await stackPixels(page)) !== before).toBe(true)
    await snap(page, 'neon')
    await page.screenshot({ path: `${SHOTS}/s2-3-setup-neon.png` })

    await page.getByTestId('relight-setup-Window').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    const win = lightsOf(await layers(page))
    expect(win[0].x).toBeCloseTo(0.5 - 0.55 * 0.6, 3); expect(win[0].y).toBeCloseTo(0.5 - 0.25 * 0.6, 3)
    expect((await layers(page)).find(l => l.id === 'pup').effects.find((e: any) => e.type === 'relight').keep).toBeCloseTo(0.3, 5)

    // One ⌘Z per Setup: Window → Neon → Golden key's lamp, the same layer in the same place.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.keyboard.press('Meta+z')
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    expect(lightsOf(await layers(page)).map(l => l.id)).toEqual(neon.map(l => l.id))
    await page.keyboard.press('Meta+z')
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    const back = lightsOf(await layers(page))
    expect(back).toEqual(golden)
    await snap(page, 'undone')
    const d = maxCellDiff(await gridMeans(page, 'undone'), await gridMeans(page, 'golden'))
    console.log('[s2 setups] after two undos, max 6×6 cell diff vs Golden key:', d, '| vs Neon:', maxCellDiff(await gridMeans(page, 'undone'), await gridMeans(page, 'neon')))
    expect(d).toBeLessThan(0.5)
  })

  test('an old Relight Frame opens converted: lights on top, the toast, the other layers untouched; one ⌘Z restores the old data', async ({ page }) => {
    const OLD_FX = oldRelight([{ id: 'k1', x: 0.15, y: 0.3 }, { id: 'k2', x: 0.9, y: 0.8 }])
    const OLD = [CORNER, { ...PUP, effects: [OLD_FX] }]
    await openBlankWorkflow(page)
    await waitForBackend(page)
    await page.evaluate(([b, ls]) => window.dispatchEvent(new CustomEvent('sailor:addNode', {
      detail: { nodeType: 'Compositor', widgetOverrides: { width: 1000, height: 1000 }, propertyOverrides: { sailor_localBg: b, sailor_localLayers: ls } },
    })), [BG, JSON.parse(JSON.stringify(OLD))] as const)
    await openEditor(page, { grid: true })   // the grid stays until after the undo: ⇧G is an undo step too
    await expect(page.getByText('Relight\'s lights are now Frame lights', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    const conv = await layers(page)
    console.log('[s2 old Frame] after open:', JSON.stringify(conv.map(l => ({ id: l.id, kind: l.kind, x: l.x?.toFixed(3), y: l.y?.toFixed(3), lit: l.lit, castsShadow: l.castsShadow, lights: l.effects?.[0]?.lights?.length }))))
    expect(conv.map(l => l.kind)).toEqual(['rect', 'image', 'light', 'light'])   // the lights at the TOP
    expect(conv.slice(2).map(l => l.id)).toEqual(['ll-rl-pup-k1', 'll-rl-pup-k2'])
    expect(conv[2].x).toBeCloseTo(0.5 - 0.35 * 0.6, 3); expect(conv[2].y).toBeCloseTo(0.5 - 0.2 * 0.6, 3)
    expect(conv[3].x).toBeCloseTo(0.5 + 0.4 * 0.6, 3); expect(conv[3].y).toBeCloseTo(0.5 + 0.3 * 0.6, 3)
    expect(conv[0]).toMatchObject({ lit: false, castsShadow: false })
    expect('lights' in conv[1].effects[0]).toBe(false)
    // …and the light rows are the top rows of the layer list.
    const rowsTop = await page.evaluate(() => ({
      lights: [...document.querySelectorAll('[data-testid="light-row-swatch"]')].map(e => e.getBoundingClientRect().top),
      others: [...document.querySelectorAll('[data-testid="row-lit"]')].map(e => e.getBoundingClientRect().top),
    }))
    expect(rowsTop.lights.length).toBe(2)
    expect(Math.max(...rowsTop.lights)).toBeLessThan(Math.min(...rowsTop.others))
    await expect.poll(() => normalsSeen.has(page), { timeout: 60_000 }).toBe(true)
    await settleRelight(page, 1)
    await snap(page, 'converted')

    // One ⌘Z: the old data exactly (no light layer, the effect's own lights, the shape untouched).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.keyboard.press('Meta+z')
    await expect(page.getByTestId('light-dot')).toHaveCount(0)
    const undone = await layers(page)
    expect(undone.map(l => l.kind)).toEqual(['rect', 'image'])
    expect(undone[0].lit).toBeUndefined(); expect(undone[0].castsShadow).toBeUndefined()
    expect(undone[1].effects).toEqual(OLD[1]!.effects)
    // Undone, the painter's own read-only conversion paints the same picture.
    await settleRelight(page)
    await snap(page, 'undone')
    // Redo, then hide the grid for the screenshot of the converted Frame.
    await page.keyboard.press('Meta+Shift+z')
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    await gridOff(page)
    await settleRelight(page)
    await page.screenshot({ path: `${SHOTS}/s2-4-old-frame-converted.png` })
    const same = maxCellDiff(await gridMeans(page, 'undone'), await gridMeans(page, 'converted'))
    console.log('[s2 old Frame] undone (painter-converted) vs editor-converted, max 6×6 cell diff:', same)
    expect(same).toBeLessThan(0.5)

    // The other layers look as they did before: the corner shape's inside equals the same Frame
    // painted with no Relight and no light at all (the old Relight lit the photo only).
    await setLayers(page, PHOTO)
    await snap(page, 'before')
    const inside: Box = [0.06, 0.87, 0.18, 0.93]
    const shape = await page.evaluate(([b]) => {
      const S = (window as any).__snaps, a = S.converted, z = S.before
      const [x0, y0, x1, y1] = (b as number[]).map((v, i) => Math.round(v * (i % 2 ? a.h : a.w)))
      let max = 0
      for (let y = y0!; y < y1!; y++) for (let x = x0!; x < x1!; x++) for (let c = 0; c < 3; c++) { const i = (y * a.w + x) * 4 + c; max = Math.max(max, Math.abs(a.d[i] - z.d[i])) }
      return max
    }, [inside] as const)
    // …and so does the background: the conversion leaves it unlit (the old Relight lit the photo only).
    const bgCorner: Box = [0.02, 0.02, 0.12, 0.12]
    const bg = { converted: await mean(page, 'converted', bgCorner), before: await mean(page, 'before', bgCorner) }
    console.log('[s2 old Frame] corner shape inside: max |converted − before| =', shape, '| background top-left, converted vs before:', bg)
    expect(shape).toBe(0)
    expect(Math.abs(bg.converted - bg.before)).toBeLessThan(0.5)
  })

  test('an unopened old Relight Frame: its card is lit by the converted lights, and nothing is written', async ({ page }) => {
    await openBlankWorkflow(page)
    await waitForBackend(page)
    // Two old Frames: the only light at the photo's left in one, at its right in the other.
    const add = (x: number) => page.evaluate(([b, ls]) => window.dispatchEvent(new CustomEvent('sailor:addNode', {
      detail: { nodeType: 'Compositor', widgetOverrides: { width: 1000, height: 1000 }, propertyOverrides: { sailor_localBg: b, sailor_localLayers: ls } },
    })), [BG, [CORNER, { ...PUP, effects: [oldRelight([{ id: 'k', x, y: 0.5 }])] }]] as const)
    await add(0.05)
    await expect(page.locator('.vue-flow__node')).toHaveCount(1)
    const idL = await page.locator('.vue-flow__node').first().getAttribute('data-id')
    await add(0.95)
    await expect(page.locator('.vue-flow__node')).toHaveCount(2)
    const idR = (await page.locator('.vue-flow__node').evaluateAll(ns => ns.map(n => n.getAttribute('data-id')))).find(id => id !== idL)!
    // Read both cards (settled: two equal reads), then the halves of the photo on each.
    const card = async (id: string, name: string) => {
      const cv = page.locator(`.vue-flow__node[data-id="${id}"] [data-testid="frame-card-stack-canvas"]`)
      await expect.poll(() => cv.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 20_000 }).toBeGreaterThan(10)
      let prev = ''
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(250)
        const cur = await cv.evaluate((c: HTMLCanvasElement) => { const k = document.createElement('canvas'); k.width = c.width; k.height = c.height; k.getContext('2d')!.drawImage(c, 0, 0); return k.toDataURL() })
        if (cur === prev && i > 4) break
        prev = cur
      }
      await page.evaluate(([n, u]) => new Promise<void>((res) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
          const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(img, 0, 0)
          const w = window as any; w.__snaps ??= {}
          w.__snaps[n!] = { w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data }
          res()
        }
        img.src = u!
      }), [name, prev])
      return photoHalves(page, name)
    }
    const L = await card(idL, 'cardL'), R = await card(idR, 'cardR')
    console.log('[s2 card] photo halves — old light left:', L, '| old light right:', R)
    expect(L.left - L.right).toBeGreaterThan(5)
    expect(R.right - R.left).toBeGreaterThan(5)
    expect(L.left - R.left).toBeGreaterThan(5)
    await page.locator(`.vue-flow__node[data-id="${idL}"]`).screenshot({ path: `${SHOTS}/s2-5-card-old-frame-light-left.png` })
    // Nothing was persisted: the stored layers are still the old format.
    const stored = await page.evaluate((id) => {
      let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
      while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
      const n = c.exposed.getNodes().find((n: any) => String(n.id) === String(id))
      return JSON.parse(JSON.stringify({ layers: n.data.properties.sailor_localLayers, lighting: n.data.properties.sailor_localLighting ?? null }))
    }, idL)
    expect(stored.layers.map((l: any) => l.kind)).toEqual(['rect', 'image'])
    expect(stored.layers[1].effects[0].lights.length).toBe(1)
    expect(stored.lighting).toBeNull()
  })

  test('Finish (mocked): the guide is the photo lit by the Frame’s lamp — it differs from the original and its brighter half follows the lamp', async ({ page }) => {
    await openFrame(page)
    await setLayers(page, PHOTO)
    await addRelightByMenu(page)                                // Golden key's lamp, right of the face
    await page.route('**/upload/image', async (route) => {
      const m = (route.request().postData() ?? '').match(/filename="([^"]+)"/)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: m?.[1] ?? 'relightfinish_x.png', subfolder: '', type: 'input' }) })
    })
    const bodies: { original: string; guide: string }[] = []
    await page.route('**/api/inpaint/relight-finish', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='], model: 'fal-ai/nano-banana-2/edit' }) })
    })
    /** The pair, decoded: sizes, the mean |guide − original|, and on each half of the box (inset
     *  5%) the guide's mean luminance and its gain over the original. */
    const measure = (b: { original: string; guide: string }) => page.evaluate(async ({ original, guide }) => {
      const load = (s: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = s })
      const [a, g] = await Promise.all([load(original), load(guide)])
      const px = (im: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d')!; x.drawImage(im, 0, 0); return x.getImageData(0, 0, c.width, c.height).data }
      const W = a.naturalWidth, H = a.naturalHeight, da = px(a), dg = px(g)
      let diff = 0, k = [0, 0]
      const sum = { a: [0, 0], g: [0, 0] }
      for (let y = Math.round(H * 0.05); y < H * 0.95; y++) for (let x = Math.round(W * 0.05); x < W * 0.95; x++) {
        const i = (y * W + x) * 4, side = x < W / 2 ? 0 : 1
        sum.a[side] += 0.299 * da[i]! + 0.587 * da[i + 1]! + 0.114 * da[i + 2]!
        sum.g[side] += 0.299 * dg[i]! + 0.587 * dg[i + 1]! + 0.114 * dg[i + 2]!
        k[side]++
      }
      for (let i = 0; i < da.length; i += 4) for (let k = 0; k < 3; k++) diff += Math.abs(da[i + k]! - dg[i + k]!)
      const r = (v: number) => Math.round(v * 1000) / 1000
      return {
        a: [W, H], g: [g.naturalWidth, g.naturalHeight], diff: r(diff / ((da.length / 4) * 3)),
        guideLeft: r(sum.g[0]! / k[0]!), guideRight: r(sum.g[1]! / k[1]!), gainLeft: r(sum.g[0]! / sum.a[0]!), gainRight: r(sum.g[1]! / sum.a[1]!),
      }
    }, b)
    /** Select the Relight row, Finish, read the pair. Then the result bar: Revert when it shows.
     *  Returns the measures and whether the bar showed. */
    const finishOnce = async () => {
      await selectRelightRow(page)
      await expect(page.getByTestId('relight-finish')).toBeEnabled()
      const n = bodies.length
      await page.getByTestId('relight-finish').click()
      await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(n + 1)
      const m = await measure(bodies[n]!)
      const bar = await page.locator('[data-edit-result-bar]').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
      if (bar) {
        await page.getByTestId('edit-result-revert').click()
        await expect(page.locator('[data-edit-result-bar]')).toHaveCount(0)
        await expect(page.locator('[data-testid="effect-row"][data-effect-kind="relight"]')).toHaveCount(1)
      }
      return { ...m, bar }
    }
    // 1) Golden key's lamp at the right; the photo is the selected layer (as after the add).
    const right = await finishOnce()
    expect(right.bar).toBe(true)
    // 2) The lamp dragged to the left — the drag selects the lamp — then the photo's Relight row.
    await moveLamp(page, 0.14, 0.4, 'finishLeft')
    const left = await finishOnce()
    console.log('[s2 Finish] guide vs original — lamp right:', JSON.stringify(right), '| lamp left:', JSON.stringify(left))
    await mkdir(SHOTS, { recursive: true })
    await writeFile(`${SHOTS}/s2-6-finish-guide-lamp-left.png`, Buffer.from(bodies[1]!.guide.replace(/^data:image\/png;base64,/, ''), 'base64'))
    for (const m of [right, left]) {
      expect(m.a).toEqual(m.g)                                // the pair stays pixel-aligned
      expect(m.diff).toBeGreaterThan(2)                       // the guide is lit, not a copy
    }
    // The guide's brighter half is the lamp's half…
    expect(right.guideRight - right.guideLeft).toBeGreaterThan(3)
    expect(left.guideLeft - left.guideRight).toBeGreaterThan(3)
    // …and, lamp place against lamp place (the guide carries Original light, which lifts the
    // photo's darker right half whatever the lamp does), the left half gains and the right loses.
    expect(left.gainLeft - right.gainLeft).toBeGreaterThan(0.05)
    expect(right.gainRight - left.gainRight).toBeGreaterThan(0.05)
    // Finish's result bar (Revert · Try again · Keep) shows after a Finish started with a light
    // selected too (a lamp drag selects the lamp; the Relight row keeps it as the selected layer).
    expect(left.bar, 'the result bar after Finish with the lamp as the selected layer').toBe(true)
  })

  test('web export file of a Relight Frame looks like the editor', async ({ page, context }) => {
    const errors: string[] = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await openFrame(page)
    await setLayers(page, PHOTO)
    await snap(page, 'plainEditor')
    await addRelightByMenu(page)
    await snap(page, 'editor')
    await page.getByTestId('compositor-right-panel').getByRole('button', { name: /^Download/ }).click()
    await page.getByTestId('frame-web-export').click()
    const sheet = page.getByTestId('frame-web-export-sheet')
    const ready = sheet.getByText('One file · plays anywhere'), failed = sheet.getByText("The export couldn't be built", { exact: false })
    await expect(ready.or(failed)).toBeVisible({ timeout: 90_000 })
    if (await failed.isVisible()) throw new Error(`web export failed: ${errors.find(e => e.includes('[Frame] web export failed')) ?? errors.join(' | ')}`)
    const sizeText = await page.getByTestId('frame-web-export-size').textContent()
    const notes = await sheet.innerText()
    const [wdl] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Download' }).click()])
    const html = await readFile((await wdl.path())!, 'utf8')
    expect(html).toContain('"kind":"light"')
    const r = await canvasRect(page)
    const exp = await renderExported(context, html, 0, { width: Math.round(r.width), height: Math.round(r.height) })
    await snapUrl(page, 'web', exp.png, 'editor')
    const gw = await gridMeans(page, 'web'), ge = await gridMeans(page, 'editor'), gp = await gridMeans(page, 'plainEditor')
    const row = (g: number[]) => g.map(v => Math.round(v * 10) / 10).join(' ')
    console.log('[s2 web export] size', sizeText, '| bytes', html.length, '| requests', exp.requests.length)
    console.log('[s2 web export] sheet text:', notes.replace(/\s+/g, ' ').slice(0, 600))
    console.log('[s2 web export] cells editor:', row(ge))
    console.log('[s2 web export] cells export:', row(gw))
    console.log('[s2 web export] cells (export − editor):', gw.map((v, i) => Math.round((v - ge[i]!) * 10) / 10).join(' '))
    const ph = { editor: await photoHalves(page, 'editor'), web: await photoHalves(page, 'web'), plain: await photoHalves(page, 'plainEditor') }
    console.log('[s2 web export] photo halves:', JSON.stringify(ph))
    await mkdir(SHOTS, { recursive: true })
    await writeFile(`${SHOTS}/s2-7-web-export.png`, Buffer.from(exp.png.replace(/^data:image\/png;base64,/, ''), 'base64'))
    // Regions away from fine detail: the lit background above the photo and beside it, and the
    // photo's plain floor (bottom left of the box, clear of the puppy's fur and paws).
    const regions: Record<string, Box> = { bgTop: [0.05, 0.03, 0.95, 0.15], bgRight: [0.84, 0.3, 0.97, 0.7], floor: [0.23, 0.66, 0.36, 0.77] }
    const reg: Record<string, number[]> = {}
    for (const [k, b] of Object.entries(regions)) reg[k] = [await mean(page, 'editor', b), await mean(page, 'web', b), await mean(page, 'plainEditor', b)]
    console.log('[s2 web export] regions [editor, export, plain]:', JSON.stringify(reg))
    expect(exp.requests).toEqual([])
    expect(notes).not.toContain('Relight on Image')               // depth and surfaces travelled with the file
    expect(html).toContain('"surfaces":[')
    for (const [editor, file] of Object.values(reg)) expect(Math.abs(editor! - file!)).toBeLessThan(3)
    expect(Math.abs(reg.floor![0]! - reg.floor![2]!)).toBeGreaterThan(5)   // teeth: the floor really is relit in the editor
    expect(maxCellDiff(gw, gp)).toBeGreaterThan(10)                       // and the export really is lit
  })
})

// ── Speed ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Drag a lamp for ~2 s on a 1080×1350 Frame with 8 layers. Per pointer move, the main-thread
 * cost of the move AND the repaint it triggers: a capture-phase listener stamps the start, and a
 * MessageChannel message (the next task, after every microtask the paint chain queued) stamps
 * the end. Also rAF deltas, `__lightingLastMs` (CPU side only — the GPU finishes later), the
 * full repaint on release (same probe on pointerup) and the map stamps.
 */
async function measureDrag(page: Page) {
  await openFrame(page, 1080, 1350)
  const eight = [
    { ...SHAPE, id: 's1', x: 0.3, y: 0.2, w: 0.3, h: 0.12 },
    { ...SHAPE, id: 's2', x: 0.7, y: 0.25, w: 0.25, h: 0.2, fill: '#3b82f6' },
    { id: 'e1', kind: 'ellipse', x: 0.5, y: 0.55, w: 0.3, h: 0.24, rotation: 0, opacity: 1, fill: '#e2554f', stroke: '', strokeWidth: 0 },
    { ...SHAPE, id: 's3', x: 0.25, y: 0.82, w: 0.3, h: 0.1, fill: '#45b07a' },
    { ...TEXT, id: 't1', y: 0.4, text: 'LIGHT' },
    { ...TEXT, id: 't2', y: 0.7, text: 'and shadow', fontSize: 0.07 },
    { ...TEXT, id: 't3', y: 0.92, text: 'stage one', fontSize: 0.05, color: '#ffe9a8' },
    { ...SHAPE, id: 's4', x: 0.75, y: 0.82, w: 0.2, h: 0.1, fill: '#9b6bd6' },
  ]
  await setLayers(page, eight)
  await page.getByTestId('add-light').click()
  await expect(page.getByTestId('light-dot')).toHaveCount(1)
  await stackPixels(page)
  // One short warm-up drag: the first drag of a session stamps the maps once (measured: +1 on
  // its first move, never again — see the report); the measured drag must not include it.
  const dot = page.getByTestId('light-dot')
  let b = (await dot.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down()
  await page.mouse.move(b.x + 40, b.y + 40, { steps: 4 }); await page.mouse.up()
  await stackPixels(page)
  const canvas = await page.evaluate(() => { const c = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement; return { w: c.width, h: c.height, dpr: devicePixelRatio } })

  await page.evaluate(() => {
    const w = window as any
    w.__perf = { move: [] as number[], up: [] as number[], frames: [] as number[], pass: [] as number[], inside: 0, on: true }
    const ch = new MessageChannel()
    let pending: { kind: 'move' | 'up'; t: number; runs: number } | null = null
    ch.port1.onmessage = () => {
      if (!pending) return
      w.__perf[pending.kind].push(performance.now() - pending.t)
      if (pending.kind === 'move' && w.__lightingRuns() > pending.runs) w.__perf.inside++   // the pass ran inside the window
      pending = null
    }
    const probe = (kind: 'move' | 'up') => () => { if (!w.__perf.on || pending) return; pending = { kind, t: performance.now(), runs: w.__lightingRuns() }; ch.port2.postMessage(0) }
    window.addEventListener('pointermove', probe('move'), true)
    window.addEventListener('pointerup', probe('up'), true)
    let last = performance.now()
    const tick = (t: number) => { if (!w.__perf.on) return; w.__perf.frames.push(t - last); last = t; w.__perf.pass.push(w.__lightingLastMs()); requestAnimationFrame(tick) }
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick) })
  })
  const r = await canvasRect(page)
  b = (await dot.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2 + 3)
  const stamps0 = await mapStamps(page), runs0 = await lightRuns(page)
  await page.evaluate(() => { const p = (window as any).__perf; p.move.length = 0; p.frames.length = 0; p.pass.length = 0; p.inside = 0 })
  const t0 = Date.now()
  let moves = 0
  while (Date.now() - t0 < 2_000) {
    const a = (moves++ % 90) / 90 * Math.PI * 2
    await page.mouse.move(r.x + r.width * (0.5 + 0.38 * Math.cos(a)), r.y + r.height * (0.5 + 0.38 * Math.sin(a)))
  }
  const during = await page.evaluate(() => { const p = (window as any).__perf; return { move: [...p.move], frames: [...p.frames], pass: [...p.pass], inside: p.inside } })
  const stampsEnd = await mapStamps(page), runsEnd = await lightRuns(page)
  await page.mouse.up()
  await page.waitForTimeout(500)
  const up = await page.evaluate(() => { const p = (window as any).__perf; p.on = false; return [...p.up] })
  const stampsAfter = await mapStamps(page)
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100 }
  return {
    canvas, moves,
    perMoveMs: { n: during.move.length, passInsideWindow: during.inside, median: q(during.move, 0.5), p95: q(during.move, 0.95), max: q(during.move, 1) },
    rafMs: { n: during.frames.length, median: q(during.frames, 0.5), p95: q(during.frames, 0.95), max: q(during.frames, 1) },
    lightingLastMs: { median: q(during.pass, 0.5), p95: q(during.pass, 0.95) },
    releaseRepaintMs: up.map(v => Math.round(v * 100) / 100),
    runs: runsEnd - runs0,
    stamps: { start: stamps0, endOfDrag: stampsEnd, afterRelease: stampsAfter },
  }
}

test.describe('Frame light layers (stage 1) — speed', () => {
  test('a 2 s lamp drag at 1× pixels', async ({ page }) => {
    const res = await measureDrag(page)
    console.log('[speed 1x]', JSON.stringify(res))
    test.info().annotations.push({ type: 'speed 1x', description: JSON.stringify(res) })
    expect(res.stamps.endOfDrag).toBe(res.stamps.start)    // a pure light drag never re-stamps the maps
    expect(res.stamps.afterRelease).toBe(res.stamps.start) // nor does its release
    expect(res.runs).toBeGreaterThan(20)                   // the pass really ran through the drag
    expect(res.perMoveMs.passInsideWindow / res.perMoveMs.n).toBeGreaterThan(0.9)   // …inside each timed window
  })
  test.describe('retina', () => {
    test.use({ deviceScaleFactor: 2 })
    test('a 2 s lamp drag at 2× pixels', async ({ page }) => {
      const res = await measureDrag(page)
      console.log('[speed 2x]', JSON.stringify(res))
      test.info().annotations.push({ type: 'speed 2x', description: JSON.stringify(res) })
      expect(res.stamps.endOfDrag).toBe(res.stamps.start)
      expect(res.stamps.afterRelease).toBe(res.stamps.start)
      expect(res.runs).toBeGreaterThan(20)
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Stage 3: Gold foil and Spot UV lit by the Frame's light layers.
//
// A dark-green Frame with a gold foil "GOLD" (Georgia) across the top and a blue Spot UV ellipse
// below it. With no light the finishes take the hidden light exactly as before stage 3: the lit
// shaders never run (`__finishLitRuns`, read from the app's own finishLights.ts instance) and a
// lamp added then deleted leaves the picture byte-identical. The shader-level byte-identity of the
// no-light path is the unit suite's job (finish-lights / finish-pass unit specs).
// ══════════════════════════════════════════════════════════════════════════════════════════════
const FOIL_FILL = { type: 'foil', metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 }
const FIN_BG = '#0b3d2e'
const GOLD = { id: 'gold', kind: 'text', x: 0.5, y: 0.3, rotation: 0, opacity: 1, text: 'GOLD', fontFamily: 'Georgia', fontWeight: 700, fontSize: 0.24, color: FOIL_FILL, align: 'center', lineHeight: 1.1, effects: [] as unknown[] }
const UV = { id: 'uv', kind: 'ellipse', x: 0.5, y: 0.74, w: 0.6, h: 0.26, rotation: 0, opacity: 1, fill: '#2a6f97', stroke: '', strokeWidth: 0,
  effects: [{ id: 'uv1', type: 'spot_uv', visible: true, gloss: 0.75, raised: 0.5, varnishOnly: false }] }
const FINISHES = [UV, GOLD]   // bottom → top
/** The foil word's band and the ellipse's inner box (canvas fractions). */
const GOLD_BAND: Box = [0.12, 0.2, 0.88, 0.4]
const UV_IN: Box = [0.28, 0.67, 0.72, 0.81]
/** A white lamp where the hidden light sits by default (top left, height 0.6). */
const whiteLamp = (x = 0.15, y = 0.1, over: Record<string, unknown> = {}) => light('lamp', 'lamp', x, y, { color: '#ffffff', brightness: 1.6, height: 0.6, ...over })

const finishModuleUrl = new WeakMap<Page, string>()
/** Lit finish draws so far, from the app's own finishLights.ts instance; -1 until it has loaded. */
const finishLitRuns = (page: Page) => {
  const url = finishModuleUrl.get(page)
  return url ? page.evaluate(async (u) => (await import(u)).__finishLitRuns() as number, url) : Promise.resolve(-1)
}

/** Foil pixels of a snapshot inside a box (gold or tinted metal over the dark-green ground:
 *  far from the ground colour), as per-bin stats over `bins` columns and the brightest 5 %. */
const foilStats = (page: Page, name: string, b: Box, bins = 8) => page.evaluate(([n, b, bins]) => {
  const s = (window as any).__snaps[n as string]
  const [x0, y0, x1, y1] = (b as number[]).map((v, i) => Math.round(v * (i % 2 ? s.h : s.w)))
  const bg = [0x0b, 0x3d, 0x2e]
  const binSum = new Array(bins as number).fill(0), binN = new Array(bins as number).fill(0)
  const px: { l: number; r: number; g: number; b: number }[] = []
  for (let y = y0!; y < y1!; y++) for (let x = x0!; x < x1!; x++) {
    const i = (y * s.w + x) * 4
    const r = s.d[i], g = s.d[i + 1], bl = s.d[i + 2]
    if (Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(bl - bg[2]!) < 60) continue
    const l = 0.299 * r + 0.587 * g + 0.114 * bl
    const k = Math.min((bins as number) - 1, Math.floor(((x - x0!) / (x1! - x0!)) * (bins as number)))
    binSum[k] += l; binN[k]++
    px.push({ l, r, g, b: bl })
  }
  px.sort((a, c) => c.l - a.l)
  const top = px.slice(0, Math.max(1, Math.round(px.length * 0.05)))
  const avg = (f: (p: typeof px[number]) => number, a: typeof px) => Math.round(a.reduce((t, p) => t + f(p), 0) / Math.max(1, a.length) * 10) / 10
  const binMeans = binSum.map((v, i) => binN[i] > 50 ? Math.round(v / binN[i] * 10) / 10 : -1)
  return {
    count: px.length, mean: avg(p => p.l, px), binMeans,
    brightestBin: binMeans.indexOf(Math.max(...binMeans)),
    top: { r: avg(p => p.r, top), g: avg(p => p.g, top), b: avg(p => p.b, top) },
  }
}, [name, b, bins] as const)

/** Mean luminance of snapshot `n` over the pixels that are foil in snapshot `mask` (the
 *  no-light picture, where the ground is still its own colour), inside a box. */
const foilMeanUnder = (page: Page, mask: string, n: string, b: Box) => page.evaluate(([m, n, b]) => {
  const S = (window as any).__snaps, M = S[m as string], s = S[n as string]
  const [x0, y0, x1, y1] = (b as number[]).map((v, i) => Math.round(v * (i % 2 ? s.h : s.w)))
  let sum = 0, k = 0
  for (let y = y0!; y < y1!; y++) for (let x = x0!; x < x1!; x++) {
    const i = (y * s.w + x) * 4
    if (Math.abs(M.d[i] - 0x0b) + Math.abs(M.d[i + 1] - 0x3d) + Math.abs(M.d[i + 2] - 0x2e) < 60) continue
    sum += 0.299 * s.d[i] + 0.587 * s.d[i + 1] + 0.114 * s.d[i + 2]; k++
  }
  return { mean: Math.round(sum / Math.max(1, k) * 10) / 10, px: k }
}, [mask, n, b] as const)

/** Per-pixel compare of two snapshots in a box: how many pixels differ, and by how much at most. */
const boxDiff = (page: Page, a: string, b: string, box: Box) => page.evaluate(([a, b, box]) => {
  const S = (window as any).__snaps, A = S[a as string], B = S[b as string]
  const [x0, y0, x1, y1] = (box as number[]).map((v, i) => Math.round(v * (i % 2 ? A.h : A.w)))
  let n = 0, max = 0, tot = 0
  for (let y = y0!; y < y1!; y++) for (let x = x0!; x < x1!; x++) {
    const i = (y * A.w + x) * 4; tot++
    let m = 0; for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(A.d[i + c] - B.d[i + c]))
    if (m > 0) n++; max = Math.max(max, m)
  }
  return { differ: n, max, total: tot }
}, [a, b, box] as const)

async function shot(page: Page, file: string) {
  await mkdir(SHOTS, { recursive: true })
  await page.getByTestId('compositor-stack-canvas').screenshot({ path: `${SHOTS}/${file}` })
}
/** Select the foil word and open its colour picker (where Gold foil's Light row lives). */
async function openGoldPicker(page: Page) {
  await page.getByTestId('compositor-left-panel').getByText('GOLD', { exact: true }).click()
  await page.getByRole('button', { name: /^foil$/i }).click()
  await expect(page.getByTestId('foil-fill-controls')).toBeVisible()
}

test.describe('Frame light layers (stage 3) — foil and Spot UV lit by Frame lights', () => {
  test.beforeEach(async ({ page }) => {
    page.on('request', (r) => { if (r.url().includes('/lib/compositor/finishLights.ts')) finishModuleUrl.set(page, r.url()) })
  })

  test('no light: the lit shaders never run, and a lamp added then deleted leaves the picture byte-identical', async ({ page }) => {
    await openFrame(page, 1000, 1000, FIN_BG)
    await setLayers(page, FINISHES)
    const unlit = await snap(page, 'unlit')
    await expect.poll(() => finishLitRuns(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(0)
    const runs0 = await finishLitRuns(page)
    const f0 = await foilStats(page, 'unlit', GOLD_BAND)
    console.log('[s3 no light] lit finish runs:', runs0, '| foil', JSON.stringify(f0))
    expect(runs0).toBe(0)
    expect(f0.count).toBeGreaterThan(2000)            // the foil word is there (and painted by the hidden light)
    await shot(page, 'foil-no-light.png')

    await setLayers(page, [...FINISHES, whiteLamp()])
    const lit = await snap(page, 'lit')
    const runsLit = await finishLitRuns(page)
    expect(runsLit).toBeGreaterThan(0)
    expect(lit).not.toBe(unlit)

    await page.getByTestId('light-dot').click()
    await page.getByTestId('light-delete').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(0)
    const runsAfter = await finishLitRuns(page)
    const after = await snap(page, 'after')
    await page.waitForTimeout(500)
    console.log('[s3 no light] lit runs with the lamp:', runsLit, 'after delete:', runsAfter, '→', await finishLitRuns(page), '| identical to the first capture:', after === unlit)
    expect(after).toBe(unlit)
    expect(await finishLitRuns(page)).toBe(runsAfter)
  })

  test('the foil highlight follows the lamp, takes a red lamp’s colour, and goes dark at Darkness 100 % far from the lamp', async ({ page }) => {
    await openFrame(page, 1000, 1000, FIN_BG)
    await setLayers(page, FINISHES)
    await snap(page, 'unlit')
    const none = await foilStats(page, 'unlit', GOLD_BAND)

    // A white lamp low over the left end of the word, then dragged (real mouse) over the right end.
    await setLayers(page, [...FINISHES, whiteLamp(0.12, 0.3, { height: 0.3 })])
    await snap(page, 'L')
    await shot(page, 'foil-lamp-left.png')
    await dragDotTo(page, page.getByTestId('light-dot'), 0.88, 0.3)
    await expect.poll(async () => lightsOf(await layers(page))[0].x, { timeout: 5_000 }).toBeGreaterThan(0.84)
    await snap(page, 'R')
    await shot(page, 'foil-lamp-right.png')
    const L = await foilStats(page, 'L', GOLD_BAND), R = await foilStats(page, 'R', GOLD_BAND)
    console.log('[s3 foil follows] bins (left→right) lamp left:', L.binMeans.join(' '), '| lamp right:', R.binMeans.join(' '))
    expect(L.brightestBin).toBeLessThanOrEqual(2)
    expect(R.brightestBin).toBeGreaterThanOrEqual(5)
    const nb = L.binMeans.length
    expect(L.binMeans[0]! - R.binMeans[0]!).toBeGreaterThan(10)
    expect(R.binMeans[nb - 1]! - L.binMeans[nb - 1]!).toBeGreaterThan(10)

    // White vs red lamp at the hidden light's own place: the highlight turns red.
    await setLayers(page, [...FINISHES, whiteLamp()])
    await snap(page, 'white')
    await shot(page, 'foil-white-lamp.png')
    await setLayers(page, [...FINISHES, whiteLamp(0.15, 0.1, { color: '#ff2a2a' })])
    await snap(page, 'red')
    await shot(page, 'foil-red-lamp.png')
    const W = await foilStats(page, 'white', GOLD_BAND), Rd = await foilStats(page, 'red', GOLD_BAND)
    console.log('[s3 red lamp] brightest 5 % — no light:', JSON.stringify(none.top), '| white lamp:', JSON.stringify(W.top), '| red lamp:', JSON.stringify(Rd.top))
    expect(Rd.top.r).toBeGreaterThan(Rd.top.g + 40)
    expect(Rd.top.r).toBeGreaterThan(Rd.top.b + 40)
    expect((Rd.top.r - Rd.top.g) - (W.top.r - W.top.g)).toBeGreaterThan(25)

    // Darkness 100 %, the lamp low at the far right edge, well below the word: the foil goes
    // darker than with no light. (The bottom corners sit under the editor's toolbar.)
    await setLayers(page, [...FINISHES, whiteLamp(0.97, 0.8, { height: 0.2 })])
    if (!(await page.getByTestId('light-darkness').count())) await page.getByTestId('light-dot').click()
    await setRow(page, 'light-darkness', 100)
    await expect.poll(async () => (await layers(page)).length).toBe(3)
    await snap(page, 'dark')
    await shot(page, 'foil-darkness-100.png')
    const N0 = await foilMeanUnder(page, 'unlit', 'unlit', GOLD_BAND), D = await foilMeanUnder(page, 'unlit', 'dark', GOLD_BAND)
    console.log('[s3 darkness 100] foil mean luminance over the word’s pixels — no light:', N0.mean, '| Darkness 100, lamp far:', D.mean, '| px', D.px)
    expect(D.mean).toBeLessThan(N0.mean - 20)
  })

  test('Spot UV: the shine follows the lamp, and the layer is lit once (its Lit switch changes none of its pixels)', async ({ page }) => {
    await openFrame(page, 1000, 1000, FIN_BG)
    await setLayers(page, FINISHES)
    const uvHalves = async (n: string) => ({ left: await mean(page, n, [UV_IN[0], UV_IN[1], 0.5, UV_IN[3]]), right: await mean(page, n, [0.5, UV_IN[1], UV_IN[2], UV_IN[3]]) })
    await setLayers(page, [...FINISHES, whiteLamp(0.2, 0.74, { height: 0.25 })])
    await snap(page, 'uvL')
    await shot(page, 'spot-uv-lamp-left.png')
    await setLayers(page, [...FINISHES, whiteLamp(0.8, 0.74, { height: 0.25 })])
    await snap(page, 'uvR')
    await shot(page, 'spot-uv-lamp-right.png')
    const hl = await uvHalves('uvL'), hr = await uvHalves('uvR')
    console.log('[s3 spot uv follows] ellipse halves — lamp left:', JSON.stringify(hl), '| lamp right:', JSON.stringify(hr))
    expect(hl.left - hl.right).toBeGreaterThan(5)
    expect(hr.right - hr.left).toBeGreaterThan(5)

    // Lit once: the same Frame with the ellipse's Lit switch off. The lighting pass would re-light
    // its pixels only if the switch mattered; it must not, so the ellipse is pixel-for-pixel equal.
    await setLayers(page, [{ ...UV, lit: false }, GOLD, whiteLamp(0.8, 0.74, { height: 0.25 })])
    await snap(page, 'uvRoff')
    const d = await boxDiff(page, 'uvR', 'uvRoff', UV_IN)
    console.log('[s3 spot uv lit once] ellipse pixels, Lit on vs off:', JSON.stringify(d))
    expect(d.differ).toBe(0)
    // Teeth: the same switch on a plain (no Spot UV) ellipse does change its pixels.
    const plain = { ...UV, effects: [] }
    await setLayers(page, [plain, GOLD, whiteLamp(0.8, 0.74, { height: 0.25 })])
    await snap(page, 'plainOn')
    await setLayers(page, [{ ...plain, lit: false }, GOLD, whiteLamp(0.8, 0.74, { height: 0.25 })])
    await snap(page, 'plainOff')
    const t = await boxDiff(page, 'plainOn', 'plainOff', UV_IN)
    console.log('[s3 spot uv lit once] teeth — plain ellipse, Lit on vs off:', JSON.stringify(t))
    expect(t.differ / t.total).toBeGreaterThan(0.5)
  })

  test('the Light row reads “Lit by the Frame’s lights” and selects the lamp; the handle hides; deleting the lamp brings presets and handle back', async ({ page }) => {
    await openFrame(page, 1000, 1000, FIN_BG)
    await setLayers(page, [...FINISHES, whiteLamp()])
    await openGoldPicker(page)
    const row = page.getByTestId('finish-light-framelit')
    await expect(row).toHaveText("Lit by the Frame's lights")
    await expect(page.getByTestId('finish-light-preset')).toHaveCount(0)
    await expect(page.getByTestId('frame-light-handle')).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/s3-light-row.png` })
    await row.click()
    await expect(page.getByTestId('light-delete')).toBeVisible()      // the lamp's inspector: it is selected
    await page.getByTestId('light-delete').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(0)
    await openGoldPicker(page)
    await expect(page.getByTestId('finish-light-preset')).toBeVisible()
    await expect(page.getByTestId('finish-light-framelit')).toHaveCount(0)
    await expect(page.getByTestId('frame-light-handle')).toBeVisible()
  })

  test('web export file of a lamp + foil + Spot UV Frame looks like the editor', async ({ page, context }) => {
    const errors: string[] = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await openFrame(page, 1000, 1000, FIN_BG)
    // A foil block (no glyphs: a font-free region) and the Spot UV ellipse, lit from the left.
    const block = { id: 'block', kind: 'rect', x: 0.5, y: 0.3, w: 0.7, h: 0.26, rotation: 0, opacity: 1, fill: FOIL_FILL, stroke: '', strokeWidth: 0, radius: 0 }
    await setLayers(page, [UV, block])
    await snap(page, 'plainEditor')
    await setLayers(page, [UV, block, whiteLamp(0.2, 0.5, { height: 0.35 })])
    await snap(page, 'editor')
    await page.getByTestId('compositor-right-panel').getByRole('button', { name: /^Download/ }).click()
    await page.getByTestId('frame-web-export').click()
    const sheet = page.getByTestId('frame-web-export-sheet')
    const ready = sheet.getByText('One file · plays anywhere'), failed = sheet.getByText("The export couldn't be built", { exact: false })
    await expect(ready.or(failed)).toBeVisible({ timeout: 90_000 })
    if (await failed.isVisible()) throw new Error(`web export failed: ${errors.find(e => e.includes('[Frame] web export failed')) ?? errors.join(' | ')}`)
    const [wdl] = await Promise.all([page.waitForEvent('download'), sheet.getByRole('button', { name: 'Download' }).click()])
    const html = await readFile((await wdl.path())!, 'utf8')
    expect(html).toContain('"kind":"light"')
    expect(html).not.toContain('"needsOutlines":false')     // the full frame.js, not frame-lean.js
    const r = await canvasRect(page)
    const exp = await renderExported(context, html, 0, { width: Math.round(r.width), height: Math.round(r.height) })
    await snapUrl(page, 'web', exp.png, 'editor')
    await mkdir(SHOTS, { recursive: true })
    await writeFile(`${SHOTS}/s3-web-export.png`, Buffer.from(exp.png.replace(/^data:image\/png;base64,/, ''), 'base64'))
    // Regions away from fine detail: inside the foil block (left, lamp side, and right), inside the
    // ellipse (left and right), and the lit ground between them.
    const regions: Record<string, Box> = {
      foilLeft: [0.2, 0.22, 0.35, 0.38], foilRight: [0.65, 0.22, 0.8, 0.38],
      uvLeft: [0.28, 0.68, 0.45, 0.8], uvRight: [0.55, 0.68, 0.72, 0.8], ground: [0.05, 0.5, 0.3, 0.58],
    }
    const reg: Record<string, number[]> = {}
    for (const [k, b] of Object.entries(regions)) reg[k] = [await mean(page, 'editor', b), await mean(page, 'web', b), await mean(page, 'plainEditor', b)]
    console.log('[s3 web export] requests', exp.requests.length, '| regions [editor, export, no light]:', JSON.stringify(reg))
    expect(exp.requests).toEqual([])
    for (const [editor, file] of Object.values(reg)) expect(Math.abs(editor! - file!)).toBeLessThan(3)
    // Teeth: the lamp really changes these regions in the editor.
    expect(Math.max(...Object.values(reg).map(([e, , p]) => Math.abs(e! - p!)))).toBeGreaterThan(10)
  })
})
