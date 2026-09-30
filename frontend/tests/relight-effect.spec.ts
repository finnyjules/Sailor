import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/**
 * Relight (stage 1) — browser verification. Proves what a screenshot can't: the effect really
 * ran on the GPU (run counter, not the plain fallback), lights change the pixels, a drag is ONE
 * undo step, and the right-click entry adds and selects the effect.
 */

/** One image layer (the puppy, whose depth map is cached in input/sailor_depth), inset so a canvas corner stays empty. */
async function seedPhoto(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__compositorSetLayers([
      { id: 'pup', kind: 'image', filename: 'flux_lora_00165_.png', x: 0.5, y: 0.5, w: 0.8, h: 0.8, rotation: 0, opacity: 1, effects: [] },
    ])
  })
  await expect.poll(() => page.evaluate(() => (window as any).__compositorLayers().length), { timeout: 10_000 }).toBe(1)
}
const runs = (page: Page) => page.evaluate(() => (window as any).__relightRuns?.() ?? -1)

/** Right-click the photo → Relight…, then wait until the GPU pass has actually run. */
async function addRelight(page: Page) {
  const runs0 = await runs(page)
  const box = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.getByText('Relight…', { exact: true }).click()
  await expect.poll(() => runs(page), { timeout: 15_000 }).toBeGreaterThan(runs0)
}

test.describe('Relight effect', () => {
  test('right-click Relight… adds the effect, selects it and relights the photo', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const before = await stackPixels(page)
    await addRelight(page)                                    // includes: the GPU pass really ran
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(1)
    await expect(page.getByTestId('relight-setup-Golden key')).toHaveAttribute('aria-pressed', 'true')
    expect(await stackPixels(page)).not.toBe(before)
  })

  test('dragging a light moves it and changes the picture; one undo restores it', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const handle = page.getByTestId('relight-light-handle').first()
    const b0 = (await handle.boundingBox())!
    const px0 = await stackPixels(page)
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
    await page.mouse.down()
    await page.mouse.move(b0.x - 260, b0.y + 140, { steps: 12 })
    await page.mouse.up()
    const b1 = (await handle.boundingBox())!
    expect(Math.hypot(b1.x - b0.x, b1.y - b0.y)).toBeGreaterThan(100)
    const px1 = await stackPixels(page)
    expect(px1).not.toBe(px0)
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await handle.boundingBox())!.x, { timeout: 5_000 }).toBeCloseTo(b0.x, 0)
    expect(await stackPixels(page)).toBe(px0)
  })

  test('setups switch the lights; Neon gives two handles and un-highlights after a change', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await page.getByTestId('relight-setup-Neon').click()
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(2)
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'true')
    const h = page.getByTestId('relight-light-handle').first()
    const b = (await h.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down()
    await page.mouse.move(b.x + 60, b.y + 40, { steps: 6 }); await page.mouse.up()
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'false')
  })

  test('Compare shows the photo without Relight while held', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const plain = await stackPixels(page)
    await addRelight(page)
    const lit = await stackPixels(page)
    const cmp = page.getByTestId('relight-compare')
    const cb = (await cmp.boundingBox())!
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down()
    await expect.poll(() => stackPixels(page)).toBe(plain)
    await page.mouse.up()
    await expect.poll(() => stackPixels(page)).toBe(lit)
  })

  test('a light near the top lights the top half; moved near the bottom, the bottom half', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)                                         // Golden key: a single light
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(1)
    const h = page.getByTestId('relight-light-handle').first()
    /** Drag the one light to a layer fraction (0.5, fy), and wait for the GPU pass to re-run. */
    const dragTo = async (fy: number) => {
      const runs0 = await runs(page)
      const hb = (await h.boundingBox())!
      const L = await layerRect(page)
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down()
      await page.mouse.move(L.cx, L.top + L.h * fy, { steps: 10 }); await page.mouse.up()
      await expect.poll(() => runs(page)).toBeGreaterThan(runs0)
      return halves(page)
    }
    const high = await dragTo(0.06)
    const low = await dragTo(0.92)
    // The photo without Relight (Compare held), so the gain per half is independent of the photo.
    const cb = (await page.getByTestId('relight-compare').boundingBox())!
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down()
    const plain = await halves(page)
    await page.mouse.up()
    console.log('[relight orientation] plain:', plain, 'light near top:', high, 'light near bottom:', low)
    expect(high.top).toBeGreaterThan(high.bottom)
    expect(low.bottom).toBeGreaterThan(low.top)
    expect(high.top / plain.top).toBeGreaterThan(high.bottom / plain.bottom)
    expect(low.bottom / plain.bottom).toBeGreaterThan(low.top / plain.top)
  })

  test('a wheel run over a light raises it as one undo step and does not pan; a click records nothing', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const height = () => page.evaluate(() => {
      const l = (window as any).__compositorLayers()[0]
      const fx = (l.effects ?? []).find((e: any) => e.type === 'relight')
      return fx?.lights?.[0]?.height ?? null
    })
    const h0 = await height()
    expect(h0).not.toBeNull()
    const h = page.getByTestId('relight-light-handle').first()
    const hb = (await h.boundingBox())!
    // A click that never moves: no undo step (undo would otherwise pop the effect's own add).
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down(); await page.mouse.up()
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -40)   // one trackpad-like run
    await expect.poll(height).toBeGreaterThan(h0 + 0.3)
    const hb1 = (await h.boundingBox())!
    // Centres, not corners: a higher light draws a bigger handle.
    expect(Math.abs(hb1.x + hb1.width / 2 - hb.x - hb.width / 2) + Math.abs(hb1.y + hb1.height / 2 - hb.y - hb.height / 2)).toBeLessThan(1)   // the canvas did not pan
    await page.keyboard.press('Meta+z')
    await expect.poll(height).toBeCloseTo(h0, 5)                   // one undo undid the whole run
    await expect(page.getByTestId('relight-light-handle')).toHaveCount(1)   // …and not the add
  })

  test('the first Relight add does not stall the main thread on the depth-field build', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await stackPixels(page)                                       // settled: image decoded, depth map loading
    // A 10 ms heartbeat on the main thread: the longest gap between beats is the longest the
    // page was blocked (the longtask observer reports nothing in this harness, see the control).
    const startBeat = () => page.evaluate(() => {
      const w = window as any
      clearInterval(w.__beat); w.__maxGap = 0
      let last = performance.now()
      w.__beat = setInterval(() => { const n = performance.now(); w.__maxGap = Math.max(w.__maxGap, n - last); last = n }, 10)
      w.__addAt = last
    })
    const maxGap = () => page.evaluate(() => Math.round((window as any).__maxGap))
    await startBeat()
    await addRelight(page)                                        // waits until the lit picture painted
    const litAfter = await page.evaluate(() => Math.round(performance.now() - (window as any).__addAt))
    const worst = await maxGap()
    console.log('[relight stall] lit after', litAfter, 'ms; longest main-thread block during first add:', worst, 'ms')
    expect(worst).toBeLessThan(700)                               // the inline build was 1.4–4.3 s
    // Control: the heartbeat really sees a block (else the check above passes vacuously).
    await startBeat()
    await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 150) { /* busy */ } })
    await expect.poll(maxGap).toBeGreaterThanOrEqual(140)
  })
})

test.describe('Relight surfaces (stage 2)', () => {
  test('surfaces land: the price shows while reading, then the picture changes and the status clears', async ({ page }) => {
    // addRelight alone (right-click, menu click, wait for the depth-only GPU pass) runs a few
    // seconds in this harness, so the mock's delay has to clear that plus the assertion below
    // with room to spare, or the answer lands before we ever observe "loading".
    let requests = 0
    await page.route('**/api/depth/surfaces', async (route) => {
      requests++
      await new Promise((r) => setTimeout(r, 5_000))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ normalsFilename: 'moge_a579ac8e5ca4ba75.png', subfolder: 'sailor_depth', cached: false }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)                                    // depth-only pass has already run
    await expect(page.getByTestId('relight-status-loading')).toHaveText(/Reading shape · \$/)
    const depthOnly = await stackPixels(page)
    const runsBeforeSurfaces = await runs(page)
    await expect(page.getByTestId('relight-status-loading')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => runs(page), { timeout: 5_000 }).toBeGreaterThan(runsBeforeSurfaces)
    expect(await stackPixels(page)).not.toBe(depthOnly)
    expect(requests).toBe(1)
  })

  test("switched off: the route answers 503 { off: true }, no status line, picture stays on depth only", async ({ page }) => {
    await page.route('**/api/depth/surfaces', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ off: true }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const depthOnly = await stackPixels(page)
    await expect(page.getByTestId('relight-status-loading')).toHaveCount(0)
    await expect(page.getByTestId('relight-status-error')).toHaveCount(0)
    expect(await stackPixels(page)).toBe(depthOnly)
  })

  test('a failed read shows the error line with Retry, and Retry calls the route again', async ({ page }) => {
    let requests = 0
    await page.route('**/api/depth/surfaces', async (route) => {
      requests++
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'moge-2: boom' }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await expect(page.getByTestId('relight-status-error')).toBeVisible()
    expect(requests).toBe(1)
    await page.getByTestId('relight-surfaces-retry').click()
    await expect.poll(() => requests, { timeout: 5_000 }).toBe(2)
    await expect(page.getByTestId('relight-status-error')).toBeVisible()
  })
})

/** The Relight layer's box in client px, from the dim overlay's hole (rotation 0 in these tests). */
async function layerRect(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="relight-dim"]') as SVGSVGElement
    const pts = svg.querySelector('polygon')!.getAttribute('points')!.split(' ').map(p => p.split(',').map(Number) as [number, number])
    const r = svg.getBoundingClientRect()
    const sx = r.width / Number(svg.getAttribute('width')), sy = r.height / Number(svg.getAttribute('height'))
    const xs = pts.map(p => r.left + p[0] * sx), ys = pts.map(p => r.top + p[1] * sy)
    const left = Math.min(...xs), top = Math.min(...ys), w = Math.max(...xs) - left, h = Math.max(...ys) - top
    return { left, top, w, h, cx: left + w / 2 }
  })
}

/** Mean luminance of the layer's top and bottom halves on the stack canvas (inset 5%). */
async function halves(page: Page): Promise<{ top: number; bottom: number }> {
  await stackPixels(page)                                         // wait for a settled frame
  const L = await layerRect(page)
  return page.evaluate((L) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const cr = cv.getBoundingClientRect()
    const k = cv.width / cr.width
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height
    const x = c.getContext('2d')!; x.drawImage(cv, 0, 0)
    const x0 = Math.round((L.left - cr.left + L.w * 0.05) * k), x1 = Math.round((L.left - cr.left + L.w * 0.95) * k)
    const y0 = Math.round((L.top - cr.top + L.h * 0.05) * k), y1 = Math.round((L.top - cr.top + L.h * 0.95) * k)
    const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data
    const W = x1 - x0, H = y1 - y0
    let t = 0, b = 0, nt = 0, nb = 0
    for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
      const o = (y * W + i) * 4, lum = 0.2126 * d[o]! + 0.7152 * d[o + 1]! + 0.0722 * d[o + 2]!
      if (y < H / 2) { t += lum; nt++ } else { b += lum; nb++ }
    }
    return { top: t / nt, bottom: b / nb }
  }, L)
}
