import { test, expect, type Page } from '@playwright/test'
import { openHarness, renderExported } from './_frameEmbedHelpers'

/** Width and height of a PNG data URL, read from its IHDR chunk. */
function pngSize(dataUrl: string): { w: number; h: number } {
  const b = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

/** RGBA of each [x, y] (device pixels) of a PNG data URL, decoded in the page. */
async function samplePixels(page: Page, png: string, points: [number, number][]): Promise<number[][]> {
  return await page.evaluate(async ([u, pts]) => {
    const img = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0)
    return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data))
  }, [png, points] as const)
}

/** The export runtime's own device-pixel ratio rule (bundle.ts: capped at 2). */
async function runtimeDpr(page: Page): Promise<number> {
  return Math.min(2, await page.evaluate(() => window.devicePixelRatio || 1))
}

// Requires the shared dev server: PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/frame-embed-contract.spec.ts --project=chromium
test.describe('Frame embed — contract', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  test('mount puts one canvas in the container; destroy removes it', async ({ page }) => {
    const [mounted, before, after] = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const ok = await H.mount('a', await H.snapshot('vector'))
      const n = H.canvasCount('a'); H.destroy('a')
      return [ok, n, H.canvasCount('a')]
    })
    expect(mounted).toBe(true)
    expect(before).toBe(1)
    expect(after).toBe(0)
  })

  test('setTime moves a Frame with motion', async ({ page }) => {
    const [a, b] = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      await H.mount('a', await H.snapshot('vector'))
      H.setTime('a', 0.1); const x = H.pixels('a')
      H.setTime('a', 0.6); const y = H.pixels('a')
      return [x, y]
    })
    expect(a).not.toBe(b)
  })

  test('setSize resizes the canvas', async ({ page }) => {
    const dims = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      await H.mount('a', await H.snapshot('vector'))
      H.setSize('a', 640, 200)
      const c = document.querySelector('#slot-a canvas') as HTMLCanvasElement
      return [c.width, c.height]
    })
    expect(dims).toEqual([640, 200])
  })

  test('two Frames on one page each draw what they draw alone', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const vec = await H.snapshot('vector'), img = await H.snapshot('image')
      await H.mount('a', vec); H.setTime('a', 0.37); const vecAlone = H.pixels('a'); H.destroy('a')
      await H.mount('a', img); H.setTime('a', 0.37); const imgAlone = H.pixels('a'); H.destroy('a')
      await H.mount('a', vec); await H.mount('b', img)
      H.setTime('a', 0.37); H.setTime('b', 0.37)
      return { vecAlone, imgAlone, vecTogether: H.pixels('a'), imgTogether: H.pixels('b') }
    })
    expect(r.vecTogether).toBe(r.vecAlone)
    expect(r.imgTogether).toBe(r.imgAlone)
  })

  test('a mount missing an inlined image refuses and leaves no canvas', async ({ page }) => {
    const [mounted, canvases] = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('image')
      delete snap.assets.urls['image|harness-photo.png']
      return [await H.mount('a', snap), H.canvasCount('a')]
    })
    expect(mounted).toBe(false)
    expect(canvases).toBe(0)
  })

  // Ruling R6: 'box' framing hands the adapter the page's whole box. A 1000×500 artboard in a
  // 2000×500 page must get a 2000-wide canvas; the default letterbox would give it 1000.
  test('a box-framed export takes the whole page box, not a letterbox of the artboard', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      return await H.exportHtml(await H.snapshot('vector'))
    })
    const dpr = await runtimeDpr(page)
    const { png } = await renderExported(context, html, 0.4, { width: 2000, height: 500 })
    const { w, h } = pngSize(png)
    expect(Math.abs(w - 2000 * dpr)).toBeLessThanOrEqual(2)
    expect(Math.abs(h - 500 * dpr)).toBeLessThanOrEqual(2)
  })

  // Ruling R7: layers are cropped at the artboard edge. The 'bleed' rect spans artboard x
  // 900..1100; in a 2000×500 box the artboard sits at 500..1500, so the rect's outer half would
  // land on 1500..1600 — which must show the background (#204080) instead.
  test('a layer that overflows the artboard does not paint into the bleed', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      return await H.exportHtml(await H.snapshot('bleed'))
    })
    const dpr = await runtimeDpr(page)
    const { png } = await renderExported(context, html, 0, { width: 2000, height: 500 })
    const at = (x: number, y: number): [number, number] => [Math.round(x * dpr), Math.round(y * dpr)]
    const [inside, ...bleed] = await samplePixels(page, png, [at(1450, 250), at(1510, 250), at(1550, 250), at(1590, 250)])
    expect(inside).toEqual([255, 0, 0, 255])            // the rect is there, inside the artboard
    for (const px of bleed) expect(px).toEqual([32, 64, 128, 255])
  })

  // Doc-level post effects run over the whole box, bleed included: an Invert must not leave the
  // bleed un-inverted beside an inverted artboard (a visible seam at the artboard edge).
  test('a doc-level post effect reaches the bleed, so the artboard edge shows no seam', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      return await H.exportHtml(await H.snapshot('bleed-post'))
    })
    const dpr = await runtimeDpr(page)
    const { png } = await renderExported(context, html, 0, { width: 2000, height: 500 })
    const at = (x: number, y: number): [number, number] => [Math.round(x * dpr), Math.round(y * dpr)]
    const [artboardBg, rect, bleedRight, bleedLeft] = await samplePixels(page, png,
      [at(1300, 250), at(1450, 250), at(1550, 250), at(200, 250)])
    const inverted = [255 - 32, 255 - 64, 255 - 128, 255]
    expect(artboardBg).toEqual(inverted)
    expect(rect).toEqual([0, 255, 255, 255])            // inverted red, and still cropped below
    expect(bleedRight).toEqual(inverted)
    expect(bleedLeft).toEqual(inverted)
  })
})
