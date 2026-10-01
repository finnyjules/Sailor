import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { openCompositor, stackPixels } from './_helpers'

/** The puppy's MoGe-2 normal map, already in the engine's input cache. */
const PUPPY_NORMALS = 'moge_a579ac8e5ca4ba75.png'
const PUPPY_NORMALS_FILE = fileURLToPath(new URL(`../../input/sailor_depth/${PUPPY_NORMALS}`, import.meta.url))

/** /api/depth/surfaces is a PAID route: every test answers it with the puppy's cached file
 *  (free, and no fal call even if the cache were gone). A test needing another answer routes
 *  it again — Playwright tries the most recently added route first. */
async function mockSurfacesCached(page: Page) {
  trackFacingModule(page)
  await page.route('**/api/depth/surfaces', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ normalsFilename: PUPPY_NORMALS, subfolder: 'sailor_depth', cached: true }) }))
}

/**
 * Relight — browser verification. Since Frame light layers stage 2 a Relight photo has no lights
 * of its own: it takes the Frame's light layers (adding Relight to a Frame with no light brings
 * a Lamp at Golden key's place), and the light dots are the Frame's. Proves what a screenshot
 * can't: the per-photo pass really ran on the GPU (run counter, not the plain fallback), the
 * Frame lamp's place decides which side of the photo gains light, a drag is ONE undo step, and
 * the right-click entry adds and selects the effect. The per-photo pass is cached (a lamp drag
 * does not re-run it), so moves wait on the picture, never on `__relightRuns`.
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

/** Right-click the photo → Relight…, then wait until the GPU passes have actually run: the
 *  Original light paint (it needs no depth) and the facing tile once the depth field has landed —
 *  Finish needs that tile — then until no pass has run for 1.5 s. */
async function addRelight(page: Page) {
  const tiles0 = await tileRuns(page)
  const box = (await page.locator('[data-testid="compositor-stack-canvas"]').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.getByText('Relight…', { exact: true }).click()
  await settleRelight(page, tiles0 + 1)
}

test.describe('Relight effect', () => {
  test.beforeEach(async ({ page }) => { await mockSurfacesCached(page) })
  test('right-click Relight… adds the effect and a Frame lamp, selects it and relights the photo', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    const before = await stackPixels(page)
    await addRelight(page)                                    // includes: the GPU pass really ran
    await expect(page.getByTestId('light-dot')).toHaveCount(1)
    await expect(page.getByTestId('relight-setup-Golden key')).toHaveAttribute('aria-pressed', 'true')
    // The lamp is the Frame's own light layer, at the top of the stack, and the panel's chip is it.
    const ls = await page.evaluate(() => (window as any).__compositorLayers().map((l: any) => ({ id: l.id, kind: l.kind })))
    expect(ls.map((l: any) => l.kind)).toEqual(['image', 'light'])
    await expect(page.getByTestId('relight-light-1')).toHaveAttribute('data-light-id', ls[1].id)
    await expect(page.getByTestId('light-dot')).toHaveAttribute('data-light-id', ls[1].id)
    expect(await stackPixels(page)).not.toBe(before)
  })

  test('dragging the Frame lamp moves it and changes the picture; one undo restores it', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const handle = page.getByTestId('light-dot').first()
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

  test('setups replace the Frame lights; Neon gives two light dots and un-highlights after a change', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await page.getByTestId('relight-setup-Neon').click()
    await expect(page.getByTestId('light-dot')).toHaveCount(2)
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'true')
    const h = page.getByTestId('light-dot').first()
    const b = (await h.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down()
    await page.mouse.move(b.x + 60, b.y + 40, { steps: 6 }); await page.mouse.up()
    await expect(page.getByTestId('relight-setup-Neon')).toHaveAttribute('aria-pressed', 'false')
  })

  test('Compare shows the photo without Relight while held', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await stackPixels(page)
    const plain = await photoPixels(page)
    await addRelight(page)
    const lit = await stackPixels(page)
    expect(await photoPixels(page)).not.toBe(plain)
    const cmp = page.getByTestId('relight-compare')
    const cb = (await cmp.boundingBox())!
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.down()
    // Held: the photo itself is exactly the plain photo (the Frame around it stays lit by its lamp).
    await expect.poll(() => photoPixels(page), { timeout: 10_000 }).toBe(plain)
    await page.mouse.up()
    await expect.poll(() => stackPixels(page)).toBe(lit)
  })

  // Orientation is judged lamp place against lamp place (see expectLitTowardTheLight), never by
  // raw brightness: the puppy photo's bottom half is 17% brighter to begin with, Original light
  // evens that out whatever the lamp does, and with MoGe-2 surfaces its floor (59% of the bottom
  // half) correctly faces UP, so a light near the top lights the floor as well (debug report
  // 2026-09-30).
  test('the Frame lamp near the top lights the top half; moved near the bottom, the bottom half', async ({ page }) => {
    const { plain, high, low } = await measureOrientation(page)   // surfaces: the mocked cached answer (beforeEach)
    console.log('[relight orientation] plain:', plain, 'light near top:', high, 'light near bottom:', low)
    expectLitTowardTheLight(plain, high, low)
  })

  test('orientation on depth only (surfaces switched off)', async ({ page }) => {
    let normalsFetched = false
    page.on('request', (r) => { if (r.url().includes('moge_')) normalsFetched = true })
    await page.route('**/api/depth/surfaces', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ off: true }) }))
    const { plain, high, low } = await measureOrientation(page)
    console.log('[relight orientation, depth only] plain:', plain, 'light near top:', high, 'light near bottom:', low)
    expect(normalsFetched).toBe(false)
    expectLitTowardTheLight(plain, high, low)
    // The control for the surfaces test below: on depth alone the floor does not know it faces
    // up, so the lamp low in front lights the bottom half MORE than the lamp above (measured
    // 121 vs 108; with surfaces it is the other way round, 102 vs 107). Since stage 2 the photo's own brighter
    // bottom is no longer beaten in raw brightness by a lamp above (the Frame lamp is softer than
    // the old box light), so raw top-vs-bottom is not asserted.
    expect(low.bottom).toBeGreaterThan(high.bottom)
  })

  test('orientation with MoGe-2 surfaces', async ({ page }) => {
    await page.route('**/api/depth/surfaces', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ normalsFilename: 'moge_a579ac8e5ca4ba75.png', subfolder: 'sailor_depth', cached: true }) }))
    // The wait starts before measureOrientation opens the editor, so it must outlast a cold page open too.
    const normalsLoaded = page.waitForResponse((r) => r.url().includes('moge_a579ac8e5ca4ba75.png') && r.ok(), { timeout: 60_000 })
    const { plain, high, low } = await measureOrientation(page, normalsLoaded)
    console.log('[relight orientation, surfaces] plain:', plain, 'light near top:', high, 'light near bottom:', low)
    expectLitTowardTheLight(plain, high, low)
    // What only surfaces know: the floor (most of the bottom half) faces UP, so the bottom half is
    // brighter with the light above than with it low in front. The gain checks alone also pass
    // with the normal map's green channel read upside down; this one does not.
    expect(high.bottom).toBeGreaterThan(low.bottom)
  })

  test('the shader reads the MoGe-2 normal map the right way up', async ({ page }) => {
    test.skip(!existsSync(PUPPY_NORMALS_FILE), `needs the cached normal map ${PUPPY_NORMALS} in input/sailor_depth`)
    await page.goto('/')
    // The facing pass's fragment shader (RELIGHT_FRAG), with main() swapped to output the normal it reads.
    const r = await page.evaluate(async () => {
      const rp = await import('/_nuxt/lib/relight/relightPass.ts' as string)
      const gp = await import('/_nuxt/lib/compositor/gpuPost.ts' as string)
      const load = (u: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u })
      const col = await load('/view?filename=flux_lora_00165_.png&type=input')
      const nor = await load('/view?filename=moge_a579ac8e5ca4ba75.png&subfolder=sailor_depth&type=input')
      const frag = (rp.RELIGHT_FRAG as string).replace(/void main\(\) \{[\s\S]*\}$/,
        'void main() { vec2 p = vec2(vUv.x, 1.0 - vUv.y); fragColor = vec4(normalAt(p) * 0.5 + 0.5, 1.0); }')
      const W = 256, H = 256
      const out = new gp.GpuPost(frag).render(col, col, W, H, {
        ...rp.depthRectUniforms({ u0: 0, v0: 0, du: 1, dv: 1 }, 1024, 1024),
        uImgTexel: new Float32Array([1 / W, 1 / H]), uAspect: 1, uRelief: 4, uDetail: 0, uHasNormals: 1,
      }, { normals: nor }) as HTMLCanvasElement | null
      if (!out) return null
      const read = (s: CanvasImageSource) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d')!; x.drawImage(s, 0, 0, W, H); return x.getImageData(0, 0, W, H).data }
      const o = read(out), n = read(nor)
      // Expected at the same pixel: red unchanged, green inverted (map: green = up; lighting: y down).
      let same = 0, flipped = 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, j = ((H - 1 - y) * W + x) * 4
        same += Math.abs(o[i + 1]! - (255 - n[i + 1]!)) + Math.abs(o[i]! - n[i]!)
        flipped += Math.abs(o[i + 1]! - (255 - n[j + 1]!)) + Math.abs(o[i]! - n[j]!)
      }
      return { same: same / (W * H * 2), flipped: flipped / (W * H * 2) }
    })
    console.log('[relight normals decode] mean abs diff, same row:', r?.same, 'mirrored row:', r?.flipped)
    expect(r).not.toBeNull()
    expect(r!.same).toBeLessThan(2)                                // measured 0.25
    expect(r!.flipped).toBeGreaterThan(20)                         // control: the map is not symmetric (63.5)
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
  test.beforeEach(async ({ page }) => { await mockSurfacesCached(page) })

  // 2026-09-30 (Read shape button): the Frame editor only ever PEEKS for free; a paid read
  // starts only from the panel's own "Read shape" click.
  test('a new photo: Read shape button shows the price, no read happens until clicked, then reads once and swaps', async ({ page }) => {
    let peeks = 0, reads = 0
    await page.route('**/api/depth/surfaces', async (route) => {
      const body = route.request().postDataJSON() as { peek?: boolean }
      if (body.peek) {
        peeks++
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ absent: true }) })
        return
      }
      reads++
      // addRelight alone (right-click, menu click, wait for the depth-only GPU pass) runs a
      // few seconds in this harness, so the delay has to clear that plus the assertions below.
      await new Promise((r) => setTimeout(r, 3_000))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ normalsFilename: 'moge_a579ac8e5ca4ba75.png', subfolder: 'sailor_depth', cached: false }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)                                    // depth-only pass has already run
    await expect(page.getByTestId('relight-surfaces-read')).toHaveText(/Read shape · ~\$0\.01/)
    expect(reads).toBe(0)
    const depthOnly = await stackPixels(page)
    const runsBeforeSurfaces = await runs(page)

    await page.getByTestId('relight-surfaces-read').click()
    await expect(page.getByTestId('relight-status-loading')).toHaveText(/Reading shape · ~\$0\.01/)
    await expect(page.getByTestId('relight-surfaces-read')).toHaveCount(0)
    await expect(page.getByTestId('relight-status-loading')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => runs(page), { timeout: 5_000 }).toBeGreaterThan(runsBeforeSurfaces)
    expect(await stackPixels(page)).not.toBe(depthOnly)
    expect(reads).toBe(1)
    expect(peeks).toBeGreaterThanOrEqual(1)
  })

  test('a cached photo: no button, surfaces used automatically from a free peek, never a paid read', async ({ page }) => {
    let peeks = 0, reads = 0
    await page.route('**/api/depth/surfaces', async (route) => {
      const body = route.request().postDataJSON() as { peek?: boolean }
      if (body.peek) peeks++; else reads++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ normalsFilename: 'moge_a579ac8e5ca4ba75.png', subfolder: 'sailor_depth', cached: true }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await expect(page.getByTestId('relight-surfaces-read')).toHaveCount(0)
    await expect(page.getByTestId('relight-status-loading')).toHaveCount(0)
    expect(reads).toBe(0)
    expect(peeks).toBeGreaterThanOrEqual(1)
  })

  test("switched off: the route answers 503 { off: true }, no button, no status line, picture stays on depth only", async ({ page }) => {
    await page.route('**/api/depth/surfaces', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ off: true }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const depthOnly = await stackPixels(page)
    await expect(page.getByTestId('relight-surfaces-read')).toHaveCount(0)
    await expect(page.getByTestId('relight-status-loading')).toHaveCount(0)
    await expect(page.getByTestId('relight-status-error')).toHaveCount(0)
    expect(await stackPixels(page)).toBe(depthOnly)
  })

  test('a failed read shows the error line with Retry, and Retry calls the route again', async ({ page }) => {
    let requests = 0
    await page.route('**/api/depth/surfaces', async (route) => {
      const body = route.request().postDataJSON() as { peek?: boolean }
      if (body.peek) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ absent: true }) })
        return
      }
      requests++
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'moge-2: boom' }) })
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await page.getByTestId('relight-surfaces-read').click()
    await expect(page.getByTestId('relight-status-error')).toBeVisible()
    expect(requests).toBe(1)
    await page.getByTestId('relight-surfaces-retry').click()
    await expect.poll(() => requests, { timeout: 5_000 }).toBe(2)
    await expect(page.getByTestId('relight-status-error')).toBeVisible()
  })
})

// 1×1 transparent PNG — a valid, tiny stand-in for the "Finish" result (same fixture shape as
// shot-director-models.spec.ts).
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** `/upload/image` (multipart `FormData`): echo back the real filename the client picked, so a
 *  test that checks the result's name for the `relightfinish_` prefix is checking the app's own
 *  naming, not a name this mock made up. */
async function mockUpload(page: Page) {
  const state = { count: 0 }
  await page.route('**/upload/image', async (route) => {
    state.count++
    const body = route.request().postData() ?? ''
    const m = body.match(/filename="([^"]+)"/)
    const name = m?.[1] ?? 'relightfinish_unknown.png'
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name, subfolder: '', type: 'input' }) })
  })
  return state
}

/** `/api/inpaint/relight-finish` — the one route Task 4 exercises. `off: true` answers 503
 *  `{ off: true }` (the kill switch / hosted refusal), matching the real route's shape.
 *  A 1 s delay gives the tests something to observe ("Finishing…", the disabled button) before
 *  the result lands, the same way the real Nano Banana 2 call takes real time. */
function mockRelightFinish(page: Page, opts: { off?: boolean } = {}) {
  const state = { count: 0, bodies: [] as any[] }
  page.route('**/api/inpaint/relight-finish', async (route) => {
    state.count++
    state.bodies.push(route.request().postDataJSON())
    if (opts.off) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ off: true }) })
      return
    }
    await new Promise((r) => setTimeout(r, 1_000))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ images: [TINY_PNG_DATA_URL], model: 'fal-ai/nano-banana-2/edit' }) })
  })
  return state
}

const relightRow = (page: Page) => page.locator('[data-testid="effect-row"][data-effect-kind="relight"]')
const layerFilename = (page: Page) => page.evaluate(() => (window as any).__compositorLayers()[0]?.filename)
const finishBtn = (page: Page) => page.getByTestId('relight-finish')
const resultBar = (page: Page) => page.locator('[data-edit-result-bar]')
/** Everything Finish writes or Revert restores: photo, crop and the whole effect stack. */
const layerState = (page: Page) => page.evaluate(() => {
  const l = (window as any).__compositorLayers()[0]
  return JSON.stringify({ filename: l?.filename, crop: l?.crop ?? null, effects: l?.effects ?? null })
})

/** The sent pair, decoded in the page: both PNG data URLs of the same size, and how far apart
 *  their pixels are (mean absolute difference per channel, 0–255). */
async function measurePair(page: Page, body: { original: string; guide: string }) {
  return page.evaluate(async ({ original, guide }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })
    const [a, b] = await Promise.all([load(original), load(guide)])
    const px = (im: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight
      const x = c.getContext('2d')!; x.drawImage(im, 0, 0)
      return x.getImageData(0, 0, c.width, c.height).data
    }
    let diff = 0
    if (a.naturalWidth === b.naturalWidth && a.naturalHeight === b.naturalHeight) {
      const da = px(a), db = px(b)
      for (let i = 0; i < da.length; i += 4) for (let k = 0; k < 3; k++) diff += Math.abs(da[i + k]! - db[i + k]!)
      diff /= (da.length / 4) * 3
    }
    return { a: [a.naturalWidth, a.naturalHeight], b: [b.naturalWidth, b.naturalHeight], diff }
  }, body)
}

/** 64×64: an opaque square inside an 8 px transparent border — a cut-out the right-click can still hit. */
const CUTOUT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAg0lEQVR4nO3PQRECAQDDwBBVyDgxyEAMMnDFOYDnDZPuO48WZmZmpur2K3g/jw9/7P54ff0ocRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRLn1QNmZmZmuMgJoj0EYOtl9tsAAAAASUVORK5CYII='

test.describe('Relight Finish (stage 3, Task 4)', () => {
  test.beforeEach(async ({ page }) => { await mockSurfacesCached(page) })

  test('Finish → Finishing… → pending bar → Relight row gone + filename changed → Undo restores it', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const upload = await mockUpload(page)
    const finish = mockRelightFinish(page)
    const origFilename = await layerFilename(page)
    await expect(relightRow(page)).toHaveCount(1)
    const before = await layerState(page)

    await expect(finishBtn(page)).toHaveText(/Finish · ~\$0\.08/)
    await finishBtn(page).click()
    await expect(finishBtn(page)).toHaveText('Finishing…')
    await expect(finishBtn(page)).toBeDisabled()
    // The panel is locked while it runs: the settings can't drift from the guide that was sent.
    await expect(page.getByTestId('relight-controls-body')).toHaveAttribute('inert', /.*/)

    await expect(page.locator('[data-edit-result-bar]')).toBeVisible({ timeout: 10_000 })
    expect(finish.count).toBe(1)
    expect(upload.count).toBe(finish.count)
    // The pair: two PNG data URLs (no prompt — it is fixed on the server), the same size, and the
    // guide really is relit (not a copy of the original).
    const body = finish.bodies[0]
    expect(Object.keys(body).sort()).toEqual(['guide', 'original'])
    expect(body.original).toMatch(/^data:image\/png;base64,/)
    expect(body.guide).toMatch(/^data:image\/png;base64,/)
    const pair = await measurePair(page, body)
    expect(pair.a[0]).toBeGreaterThan(1)
    expect(pair.a).toEqual(pair.b)
    expect(pair.diff).toBeGreaterThan(2)
    // The Relight row is gone, and the layer got a fresh, relightfinish_-prefixed photo — both
    // written by the SAME setLocal (finishApplyPatch).
    await expect(relightRow(page)).toHaveCount(0)
    const finishedFilename = await layerFilename(page)
    expect(finishedFilename).not.toBe(origFilename)
    expect(finishedFilename).toMatch(/^relightfinish_/)
    // The effect panel closed with it (selectedEffect cleared on success).
    await expect(page.getByTestId('relight-compare')).toHaveCount(0)

    await page.getByTestId('edit-result-revert').click()
    await expect(page.locator('[data-edit-result-bar]')).toHaveCount(0)
    expect(await layerFilename(page)).toBe(origFilename)
    await expect(relightRow(page)).toHaveCount(1)
    // Photo, crop and the whole effect stack are back exactly as they were.
    expect(await layerState(page)).toBe(before)
  })

  test('Finish → Keep clears the bar; one global undo returns to the relit layer', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await mockUpload(page)
    mockRelightFinish(page)
    const origFilename = await layerFilename(page)
    const before = await layerState(page)

    await finishBtn(page).click()
    await expect(page.locator('[data-edit-result-bar]')).toBeVisible({ timeout: 10_000 })

    await page.getByTestId('edit-result-validate').click()
    await expect(page.locator('[data-edit-result-bar]')).toHaveCount(0)

    await page.keyboard.press('Meta+z')
    await expect.poll(() => layerFilename(page)).toBe(origFilename)
    await expect(relightRow(page)).toHaveCount(1)
    expect(await layerState(page)).toBe(before)
  })

  test('Undo with Meta+Z while the bar is up clears the bar, brings the dock back, and sends nothing more', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const upload = await mockUpload(page)
    const finish = mockRelightFinish(page)
    const before = await layerState(page)

    await finishBtn(page).click()
    await expect(resultBar(page)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('compositor-prompt-dock')).toBeHidden()

    await page.keyboard.press('Meta+z')
    await expect(resultBar(page)).toHaveCount(0)
    await expect.poll(() => layerState(page)).toBe(before)
    await expect(page.getByTestId('compositor-prompt-dock')).toBeVisible()
    await page.waitForTimeout(1_500)   // longer than the mock's delay: nothing else goes out
    expect(finish.count).toBe(1)
    expect(upload.count).toBe(finish.count)
  })

  test('a cut-out photo gets no Finish button and sends nothing', async ({ page }) => {
    // The puppy's own file, served as a cut-out (opaque middle, transparent border): the editor
    // sees transparency, the middle still takes the right-click, and its depth (keyed by
    // filename) is still the cached one, so Relight itself runs.
    await page.route('**/*', (route) => {
      const u = route.request().url()
      if (route.request().resourceType() === 'image' && u.includes('/view') && u.includes('flux_lora_00165_')) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(CUTOUT_PNG_B64, 'base64') })
      }
      return route.fallback()
    })
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const finish = mockRelightFinish(page)
    await expect(relightRow(page)).toHaveCount(1)
    await expect(page.getByTestId('relight-setup-Neon')).toBeVisible()
    await expect(finishBtn(page)).toHaveCount(0)
    expect(finish.count).toBe(0)
  })

  test('the route answering 503 { off: true } hides the Finish button for the session', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await mockUpload(page)
    const finish = mockRelightFinish(page, { off: true })
    await expect(finishBtn(page)).toHaveCount(1)

    await finishBtn(page).click()
    await expect(finishBtn(page)).toHaveCount(0, { timeout: 10_000 })
    expect(finish.count).toBe(1)
    // The row is untouched — an "off" answer changes nothing about the layer.
    await expect(relightRow(page)).toHaveCount(1)
  })

  test('a fast double-click sends exactly one Finish request', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    await mockUpload(page)
    const finish = mockRelightFinish(page)

    // Two synchronous native clicks: `runRelightFinish`'s single-click guard is set (a plain ref
    // write) before its first `await`, so the second call sees it already armed regardless of
    // whether Vue has re-rendered the (now-disabled) button yet.
    await page.locator('[data-testid="relight-finish"]').evaluate((el: HTMLButtonElement) => { el.click(); el.click() })
    await expect(page.locator('[data-edit-result-bar]')).toBeVisible({ timeout: 10_000 })
    expect(finish.count).toBe(1)
  })

  test('Try again sends one more request, changes the filename again, and the row stays gone', async ({ page }) => {
    await openCompositor(page)
    await seedPhoto(page)
    await addRelight(page)
    const upload = await mockUpload(page)
    const finish = mockRelightFinish(page)

    await finishBtn(page).click()
    await expect(page.locator('[data-edit-result-bar]')).toBeVisible({ timeout: 10_000 })
    expect(finish.count).toBe(1)
    const afterFirst = await layerFilename(page)

    await page.getByTestId('edit-result-reroll').click()
    await expect.poll(() => finish.count, { timeout: 10_000 }).toBe(2)
    await expect(page.locator('[data-edit-result-bar]')).toBeVisible()
    await expect.poll(() => layerFilename(page)).not.toBe(afterFirst)
    await expect(relightRow(page)).toHaveCount(0)
    // The bar's own write is not "moving on": it stays up, and one upload per answer.
    await page.waitForTimeout(300)
    await expect(page.locator('[data-edit-result-bar]')).toBeVisible()
    expect(upload.count).toBe(finish.count)
  })

  // Not covered here: "Relight isn't ready yet" (renderRelightPair returning null because the
  // depth field hasn't loaded) — addRelight() settles until the facing tile, which needs the
  // depth field, has been drawn. There is no deterministic way
  // from this harness to click Finish in the narrow window before that first pass without racing
  // a timer, so per the brief this case is skipped rather than faked.
})

type Halves = { top: number; bottom: number }

/** Golden key's Frame lamp dragged (real mouse) near the top of the photo, then near its bottom.
 *  `plain` is the photo before Relight. `ready` (e.g. the normal map's response) is awaited
 *  before the first drag. */
async function measureOrientation(page: Page, ready?: Promise<unknown>): Promise<{ plain: Halves; high: Halves; low: Halves }> {
  await openCompositor(page)
  await seedPhoto(page)
  await expect.poll(async () => (await halves(page)).top, { timeout: 20_000 }).toBeGreaterThan(10)   // the photo has painted
  const plain = await halves(page)
  await addRelight(page)                                         // the Frame's one lamp
  await expect(page.getByTestId('light-dot')).toHaveCount(1)
  if (ready) await ready
  await settleRelight(page)                                      // the field and surfaces have painted
  const h = page.getByTestId('light-dot').first()
  /** Drag the lamp to the photo fraction (0.5, fy) and wait for the new picture. */
  const dragTo = async (fy: number) => {
    const px0 = await stackPixels(page)
    const hb = (await h.boundingBox())!
    const L = await layerRect(page)
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down()
    await page.mouse.move(L.cx, L.top + L.h * fy, { steps: 10 }); await page.mouse.up()
    await expect.poll(async () => (await stackPixels(page)) !== px0, { timeout: 10_000 }).toBe(true)
    return halves(page)
  }
  const high = await dragTo(0.06)
  const low = await dragTo(0.92)
  return { plain, high, low }
}

/** Moving the lamp from low to high raises the top half more than the bottom half. Judged lamp
 *  place against lamp place: Original light evens the photo's own light out first (it lifts its
 *  darker top whatever the lamp does), so a gain over the plain photo mixes the two. The plain
 *  photo is still read, to prove the halves are of a painted photo. */
function expectLitTowardTheLight(plain: Halves, high: Halves, low: Halves) {
  expect(plain.top).toBeGreaterThan(10)
  expect(high.top / low.top).toBeGreaterThan(high.bottom / low.bottom + 0.05)
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
/** Settled: no per-photo Relight pass for 1.5 s (depth field / normals landed), then a stable canvas. */
async function settleRelight(page: Page, tilesAtLeast = 0) {
  await expect.poll(() => tileRuns(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(tilesAtLeast)
  let prev = await runs(page), still = 0
  for (let i = 0; i < 60 && still < 6; i++) {
    await page.waitForTimeout(250)
    const n = await runs(page)
    still = n === prev ? still + 1 : 0
    prev = n
  }
  await stackPixels(page)
}

/** The photo layer's box in client px, from its own x, y, w (a square photo; rotation 0 here). */
async function layerRect(page: Page) {
  const cr = (await page.getByTestId('compositor-stack-canvas').boundingBox())!
  const l = await page.evaluate(() => (window as any).__compositorLayers().find((x: any) => x.id === 'pup'))
  const w = l.w * cr.width, h = w
  const left = cr.x + l.x * cr.width - w / 2, top = cr.y + l.y * cr.height - h / 2
  return { left, top, w, h, cx: left + w / 2 }
}

/** The photo's pixels alone (inset 5%), as a data URL — a byte-exact comparison of the photo. */
async function photoPixels(page: Page): Promise<string> {
  const L = await layerRect(page)
  return page.evaluate((L) => {
    const cv = document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement
    const cr = cv.getBoundingClientRect(), k = cv.width / cr.width
    const x0 = Math.round((L.left - cr.left + L.w * 0.05) * k), y0 = Math.round((L.top - cr.top + L.h * 0.05) * k)
    const w = Math.round(L.w * 0.9 * k), h = Math.round(L.h * 0.9 * k)
    const c = document.createElement('canvas'); c.width = w; c.height = h
    c.getContext('2d')!.drawImage(cv, x0, y0, w, h, 0, 0, w, h)
    return c.toDataURL()
  }, L)
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
