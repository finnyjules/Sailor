import { test, expect, type BrowserContext, type Page } from '@playwright/test'

// The `frames` embed player (Task 5 of the "3D Studio on the web" plan): a generic "play these
// pre-rendered frames" surface, built and network-isolation-tested the same way the other embed
// surfaces are (see embed-network.spec.ts, embed-contract.spec.ts, embed-video.spec.ts, which this
// file models on and whose serving/freeze/recording recipes it reuses).
//
// Requires the dev server (PW_BASE_URL, default http://127.0.0.1:3002) AND public/embed/frames.js
// built (`node scripts/build-embed.mjs`), exactly like every other embed-*.spec.ts.

/**
 * Where an export is served from. A real http origin, not `setContent`'s about:blank — see
 * embed-network.spec.ts's identical EMBED_URL doc for why: a root-relative reference has nothing
 * to resolve against at about:blank, and `.invalid` never resolves so any stray request still
 * fires a `request` event before failing DNS.
 */
const EMBED_URL = 'http://embed-frames.invalid/'

function isNetworkRequest(url: string): boolean {
  return !url.startsWith('data:') && url !== 'about:blank' && url !== EMBED_URL
}

/** Three solid 16x16 WebP data: URIs, one per test frame — black / mid-grey / white, chosen (over
 *  e.g. red/green/blue) so both a single-pixel colour check AND a whole-frame luma comparison
 *  (used by the recordEmbed check below) can tell the three apart; the primaries all sum to the
 *  same channel total and would make a luma-based distinctness check pass for the wrong reason. */
async function makeFrameDataUrls(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    function solid(fill: string): string {
      const c = document.createElement('canvas')
      c.width = 16
      c.height = 16
      const g = c.getContext('2d')!
      g.fillStyle = fill
      g.fillRect(0, 0, 16, 16)
      return c.toDataURL('image/webp')
    }
    return [solid('#000000'), solid('#808080'), solid('#ffffff')]
  })
}

/** Builds a `frames` export via the real export pipeline (exportEmbedHtml), run inside the page
 *  so it has a `document` and can fetch /embed/frames.js — exactly as the app itself calls it.
 *  Loaded by its resolved dev-server path (mirrors embed-video.spec.ts's `/_nuxt/lib/...` imports),
 *  not a bare specifier, which page.evaluate cannot resolve on its own. */
async function exportFrames(
  page: Page, frames: string[], fps: number, width: number, height: number, duration: number,
): Promise<string> {
  return await page.evaluate(async ({ frames: f, fps: fp, width: w, height: h, duration: d }) => {
    const { exportEmbedHtml } = await import('/_nuxt/lib/embed/export.ts')
    return await exportEmbedHtml({ kind: 'frames', config: { frames: f, fps: fp, width: w, height: h }, duration: d, width: w, height: h })
  }, { frames, fps, width, height, duration })
}

/** Loads `html` in a fresh page served from EMBED_URL, freezing the runtime clock at `t01` via
 *  the freeze hook every embed-*.spec.ts drives time with (bundle.ts's __SAILOR_FREEZE_T01__).
 *  Returns the live canvas's top-left pixel and every network request the page made. */
async function renderFrozen(
  context: BrowserContext, html: string, t01: number, size: { width: number; height: number },
): Promise<{ pixel: number[]; requests: string[] }> {
  await context.addInitScript((t: number) => { (window as any).__SAILOR_FREEZE_T01__ = t }, t01)
  const page = await context.newPage()
  const requests: string[] = []
  page.on('request', (req) => { requests.push(req.url()) })
  page.on('websocket', (ws) => { requests.push(`ws:${ws.url()}`) })
  await page.setViewportSize(size)
  await page.route(EMBED_URL, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await page.goto(EMBED_URL)
  await page.waitForFunction(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
    return !!c && c.width > 1
  }, undefined, { timeout: 15_000 })
  expect(await page.locator('#sailor-poster').isHidden()).toBe(true)   // the LIVE path ran, not the poster
  await page.waitForTimeout(300)   // a beat, so any delayed/async loader would have fired
  const pixel = await page.evaluate(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement
    return Array.from(c.getContext('2d')!.getImageData(0, 0, 1, 1).data)
  })
  await page.close()
  return { pixel, requests: requests.filter(isNetworkRequest) }
}

test.describe('the frames embed player', () => {
  test.beforeEach(async ({ page }) => {
    // Any already-instrumented page will do — exportEmbedHtml is fetched by resolved path
    // below, not through this page's own harness globals; embed-network.spec.ts's beforeEach
    // uses the same page for the same reason (a real Nuxt page whose dev-server module graph
    // /_nuxt/... paths resolve against).
    await page.goto('/dev/embed-harness')
    await page.waitForFunction(() => (window as any).__embedHarnessReady === true)
  })

  test('draws frame 0 (black) at t≈0.1 and frame 2 (white) at t≈0.7, with zero network requests', async ({ page, context }) => {
    const frames = await makeFrameDataUrls(page)
    const html = await exportFrames(page, frames, 3, 16, 16, 1)

    const early = await renderFrozen(context, html, 0.1, { width: 16, height: 16 })
    expect(early.requests).toEqual([])
    expect(early.pixel[0]).toBeLessThan(20)   // black
    expect(early.pixel[1]).toBeLessThan(20)
    expect(early.pixel[2]).toBeLessThan(20)

    const late = await renderFrozen(context, html, 0.7, { width: 16, height: 16 })
    expect(late.requests).toEqual([])
    expect(late.pixel[0]).toBeGreaterThan(235)   // white
    expect(late.pixel[1]).toBeGreaterThan(235)
    expect(late.pixel[2]).toBeGreaterThan(235)
  })

  test('a clean frames export produces exactly one raw request: its own document', async ({ page, context }) => {
    const frames = await makeFrameDataUrls(page)
    const html = await exportFrames(page, frames, 3, 16, 16, 1)

    await context.addInitScript((t: number) => { (window as any).__SAILOR_FREEZE_T01__ = t }, 0)
    const p = await context.newPage()
    const requests: string[] = []
    p.on('request', (req) => { requests.push(req.url()) })
    p.on('websocket', (ws) => { requests.push(`ws:${ws.url()}`) })
    await p.setViewportSize({ width: 16, height: 16 })
    await p.route(EMBED_URL, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
    await p.goto(EMBED_URL)
    await p.waitForFunction(() => {
      const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
      return !!c && c.width > 1
    }, undefined, { timeout: 15_000 })
    await p.waitForTimeout(800)
    await p.close()
    expect(requests).toEqual([EMBED_URL])
  })

  // The proof recordEmbed (lib/engine/recordEmbed.ts) plays the frames surface correctly, not
  // just that the surface itself draws right: recordEmbed calls surface.mount then setTime(i /
  // frameCount) for each of frameCount = round(duration*fps) = 3 frames and copies the canvas
  // each time — exactly the path a "download as video" export takes. Read back through the
  // dev-only video harness's readEmbedVideo (the same bridge embed-video.spec.ts uses — a raw
  // `import('mediabunny')` cannot resolve from inside page.evaluate, only from a page whose own
  // script already imports it, see that file's module doc), which reports a frame count plus a
  // whole-frame luma spread from the first decoded frame. Black/grey/white (see makeFrameDataUrls)
  // makes that spread a genuine three-way distinctness check, not just "not all zero".
  test('recordEmbed over the frames surface yields three distinct frames', async ({ page }) => {
    const frames = await makeFrameDataUrls(page)
    const recorded = await page.evaluate(async (f: string[]) => {
      const { loadEmbedSurface } = await import('/_nuxt/lib/embed/surfaces.ts')
      const { recordEmbed } = await import('/_nuxt/lib/engine/recordEmbed.ts')
      const surface = await loadEmbedSurface('frames')
      const config = { frames: f, fps: 3, width: 16, height: 16 }
      const rec = await recordEmbed(surface, config, { width: 16, height: 16, fps: 3, duration: 1 })
      const bytes = new Uint8Array(await rec.blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { base64: btoa(bin), ext: rec.ext, contentType: rec.contentType }
    }, frames)

    await page.goto('/dev/video-export-harness')
    await page.waitForFunction(() => !!(window as any).__videoHarness, undefined, { timeout: 30_000 })
    const r = await page.evaluate(async ({ base64, contentType }) => {
      const bin = atob(base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: contentType })
      return await (window as any).__videoHarness.readEmbedVideo(blob)
    }, { base64: recorded.base64, contentType: recorded.contentType })

    expect(r.frames).toBe(3)
    expect([r.width, r.height]).toEqual([16, 16])
    // Black's own channel sum is 0, so lumaSpread (max |sum - firstSum|) landing near white's
    // ~765 is only possible if the recording actually carried all three distinct frames through,
    // not e.g. three copies of the first one.
    expect(r.lumaSpread).toBeGreaterThan(400)
  })
})

// PROOF THIS TEST HAS TEETH, modelled directly on embed-network.spec.ts's identical-purpose
// "teeth check" describe blocks. A "zero requests" assertion above is worthless unless it would
// actually catch a real leak — the two tests above assert `.toEqual([])` against the recorder,
// but nothing yet proves that recorder isn't just blind (e.g. a typo'd event name, or a filter
// that happens to swallow everything). This starts from the SAME real, clean `frames` export the
// tests above build via the real export pipeline, injects a leak the export pipeline itself never
// produces, and proves the identical `page.on('request')` recorder catches and names it.
//
// Root-relative, not an absolute URL: this mirrors embed-network.spec.ts's "root-relative asset
// reference" teeth check (not its "absolute URL"/"runtime fetch" pair, which target
// externalRefs()'s static scan specifically) because frames.ts's own asset field
// (FramesEmbedConfig.frames) is validated to require `data:` URIs (see frames.ts's `validate`),
// so there is no "un-inlined config field" case to exercise for this surface — an injected <img>
// is the only realistic leak shape here, same as the gradient/spacetype root-relative cases in
// embed-network.spec.ts.
//
// Verified by temporarily breaking the recorder itself (commenting out this test file's
// `p.on('request', ...)` push below) and re-running just this test: it failed with
// `expect(received).toContain(expected)` / `Expected value: "http://embed-frames.invalid/leak-frame.webp"`
// / `Received array: []` — i.e. with a blind recorder the leak goes undetected and the test
// correctly fails. The break was then reverted (not committed) and the test re-run green.
test.describe('teeth check — the recorder catches a leak in an otherwise clean frames export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/embed-harness')
    await page.waitForFunction(() => (window as any).__embedHarnessReady === true)
  })

  test('an injected root-relative <img> in an otherwise clean export is caught', async ({ page, context }) => {
    const frames = await makeFrameDataUrls(page)
    const html = await exportFrames(page, frames, 3, 16, 16, 1)
    const LEAK = '/leak-frame.webp'
    const LEAK_URL = new URL(LEAK, EMBED_URL).href
    const leaky = html.replace('</body>', `<img src="${LEAK}"></body>`)

    await context.addInitScript((t: number) => { (window as any).__SAILOR_FREEZE_T01__ = t }, 0.1)
    const p = await context.newPage()
    const requests: string[] = []
    p.on('request', (req) => { requests.push(req.url()) })
    p.on('websocket', (ws) => { requests.push(`ws:${ws.url()}`) })
    await p.setViewportSize({ width: 16, height: 16 })
    await p.route(EMBED_URL, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: leaky }))
    await p.goto(EMBED_URL)
    // The leak is an <img> appended alongside the real stage, not inside it — it does not
    // interfere with the live canvas mounting, so the same "did the live path actually run"
    // wait as every other test in this file still applies.
    await p.waitForFunction(() => {
      const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
      return !!c && c.width > 1
    }, undefined, { timeout: 15_000 })
    await p.waitForTimeout(800)
    await p.close()

    expect(requests.filter(isNetworkRequest)).toContain(LEAK_URL)
  })
})
