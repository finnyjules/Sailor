import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This project is ESM (no __dirname global) — derive it from import.meta.url instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// WHY THIS FILE EXISTS. embed-build-output.unit.spec.ts and every embed-*.spec.ts's
// "no external references" test call externalRefs() (~/lib/embed/bundle.ts) — a STATIC
// grep over the generated HTML string for URL-shaped substrings. That static scan
// structurally cannot prove the self-containment guarantee: spacetype-*.js bundles carry
// three.js's FileLoader and ImageBitmapLoader verbatim, both with live `fetch(` call
// sites whose URLs are built from variables at runtime, never present as a literal
// string in the bundle. Nothing invokes them today and every asset is inlined, so the
// guarantee holds — but no grep can prove a bundled loader is never CALLED, only that no
// literal URL sits in the text. The only real proof is running a genuine export and
// watching the network. That is what this file does.
const FONT_PATH = path.resolve(__dirname, '../public/fonts/ABCROM-Bold.otf')
function fontDataUrl(p: string): string {
  return `data:font/otf;base64,${fs.readFileSync(p).toString('base64')}`
}
// A fictitious family name: guaranteed not to collide with a real system/browser font,
// so a genuinely inlined @font-face is the only way anything renders in it.
const TEST_FAMILY = 'Sailor Embed Network Test Font'

/**
 * Where an export is served from. A real http origin, not `setContent`'s about:blank:
 * against about:blank a root-relative URL that leaked into an export (`/view?…`,
 * `/sailor/…`) has no base to resolve against, so it never becomes a request and the
 * zero-network gate would pass for the wrong reason. `.invalid` never resolves, so any
 * request the page makes to this origin (other than the document itself, fulfilled by
 * `page.route` below) still fires a `request` event and then fails. Same recipe as
 * tests/_frameEmbedHelpers.ts's `renderExported`.
 */
const EMBED_URL = 'http://embed-network.invalid/'

/**
 * data: URIs are not network requests (the poster and, for spacetype, the inlined font
 * are both multi-hundred-KB data: URIs referenced from attributes/CSS), and the served
 * document itself (EMBED_URL) is the one navigation every load makes — both are
 * confirmed empirically below ("a clean export produces exactly one raw request event:
 * its own document"), not just assumed.
 */
function isNetworkRequest(url: string): boolean {
  return !url.startsWith('data:') && url !== 'about:blank' && url !== EMBED_URL
}

/**
 * Loads `html` into a FRESH page and records every request/websocket it issues.
 *
 * page.on('request') over page.route(): 'request' fires for the navigation AND every
 * subresource kind a page can issue — img, font, css, script, media/video, fetch, XHR —
 * with zero risk of perturbing the page (route() requires resuming/aborting every
 * intercepted request yourself, and a mishandled route can hang or alter timing, which
 * would be a bad trade for the runtime-fetch teeth check below where firing order
 * matters). This test only needs to OBSERVE that nothing was requested, not to block
 * anything that would otherwise succeed — a pure listener is the right tool.
 * page.on('websocket') is added too, since 'request' does not cover the WebSocket
 * handshake — belt-and-suspenders for a surface that has none today.
 *
 * A brand-new page per call, not the harness `page` fixture: the harness page's own
 * dev-server traffic (loading /dev/embed-harness, its JS modules, etc.) must never be
 * in scope — only the EXPORTED HTML's own requests count, per the task brief.
 */
async function openWatchedPage(context: BrowserContext, viewport = { width: 512, height: 512 }) {
  const page = await context.newPage()
  const requests: string[] = []
  page.on('request', (req) => { requests.push(req.url()) })
  page.on('websocket', (ws) => { requests.push(`ws:${ws.url()}`) })
  await page.setViewportSize(viewport)
  return { page, requests }
}

/** Serves `html` at EMBED_URL and navigates there. Only that exact URL is fulfilled, so
 *  every other request the page makes to the origin still fires (and then fails DNS). */
async function loadExport(page: Page, html: string): Promise<void> {
  await page.route(EMBED_URL, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await page.goto(EMBED_URL)
}

/** Waits for the LIVE renderer (not the poster fallback) to have produced a real frame. */
async function waitForLiveRender(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
    return !!c && c.width > 1
  }, undefined, { timeout: 15_000 })
  expect(await page.locator('#sailor-poster').isHidden()).toBe(true)
}

/**
 * Loads an export, lets it render and tick several animation frames — long enough that
 * a loader firing on, say, the third frame (not just at mount) would be caught — and
 * returns the network requests observed for that page's whole lifetime.
 */
async function runExportAndCollectRequests(
  context: BrowserContext, html: string, { live = true }: { live?: boolean } = {},
): Promise<string[]> {
  const { page, requests } = await openWatchedPage(context)
  await loadExport(page, html)
  // `live: false` is for a teeth case whose leaked asset fails to load and so, by design,
  // rejects mount() and leaves the poster up: the request is what is under test there,
  // not the render.
  if (live) await waitForLiveRender(page)
  // A beat, not just one frame: several rAF ticks at typical refresh rates, and enough
  // headroom for a delayed setTimeout-based fetch (see the runtime teeth check below,
  // which fires at 50ms) to have long since resolved.
  await page.waitForTimeout(800)
  await page.close()
  return requests.filter(isNetworkRequest)
}

test.describe('embed export network isolation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/embed-harness')
    await page.waitForFunction(() =>
      (window as any).__embedHarnessReady === true
      && (window as any).__embedHarnessGradientReady === true
      && (window as any).__embedHarnessSpaceTypeReady === true)
  })

  // The control: an export with no injected leak must report EXACTLY zero network
  // requests — not "zero after our filter conveniently drops something we didn't
  // expect". If this fails, either a real leak exists or the data:/about:blank
  // exclusions above are wrong; either way it must not be silently swallowed.
  test('shader export makes zero network requests while rendering and animating', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarness.exportHtml())
    const requests = await runExportAndCollectRequests(context, html)
    expect(requests).toEqual([])
  })

  test('gradient export makes zero network requests while rendering and animating', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarnessGradient.exportHtml())
    const requests = await runExportAndCollectRequests(context, html)
    expect(requests).toEqual([])
  })

  // Space Type is the surface with the most inlined assets (three.js plus a real
  // embedded typeface) and the most opportunity for a leftover fetch() call site to
  // actually fire — this is the export the task exists to prove clean. Uses 'field'
  // with a REAL font inlined under a fictitious family (same recipe as "THE FONT TEST"
  // in embed-spacetype.spec.ts), not the font:null default fixture, so the exported
  // page actually exercises font loading/registration, not just an empty no-op path.
  test('spacetype export with a real inlined font makes zero network requests while rendering and animating', async ({ page, context }) => {
    const html = await page.evaluate(({ dataUrl, family }: { dataUrl: string; family: string }) => {
      const H = (window as any).__embedHarnessSpaceType
      const base = H.buildConfig('field')
      const cfg = {
        ...base,
        font: { family, weight: 700, dataUrl },
        params: { ...base.params, font: family },
      }
      return H.exportWith(cfg, 512, 512)
    }, { dataUrl: fontDataUrl(FONT_PATH), family: TEST_FAMILY })

    const requests = await runExportAndCollectRequests(context, html)
    expect(requests).toEqual([])
  })

  // Empirical proof (not an assumption) that inlined data: assets are correctly excluded
  // from "network request", and that the served document is the ONLY thing the filter
  // drops — a genuinely clean export (large inlined poster + adapter bundle, all as
  // data:/inline content) has to clear this bar on the RAW request log, not just the
  // filtered one. The raw log holds exactly one event, the navigation to EMBED_URL
  // itself; if a data: URI ever resolved through the network stack, this would catch
  // that surprise before it silently hid inside the filter above.
  test('a clean export produces exactly one raw request event: its own document', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarness.exportHtml())
    const { page: embed, requests } = await openWatchedPage(context)
    await loadExport(embed, html)
    await waitForLiveRender(embed)
    await embed.waitForTimeout(800)
    await embed.close()
    expect(requests).toEqual([EMBED_URL])
    expect(requests.filter(isNetworkRequest)).toEqual([])
  })
})

// PROOF THIS TEST HAS TEETH. A test that reports "0 requests" is worthless unless it
// would have caught a real one. Both scenarios below start from a genuine, clean export
// (built the same way the tests above build it, so nothing here is a synthetic fixture)
// and then inject a leak the EXPORT PIPELINE never produced and never scanned — string
// surgery on the HTML happens in THIS test file, after exportHtml()/externalRefs already
// ran and passed, so nothing about exportEmbedHtml's own build-time gate is exercised or
// bypassed. The assertions below use `.toContain(...)`, not a raw `.toEqual([])`, so this
// suite stays green — the failing form of these exact assertions (`expect(requests
// .filter(isNetworkRequest)).toEqual([])` against the same leaky HTML) was run manually
// during development to confirm it fails and names the injected URL; see this task's
// report for both captured failures.
test.describe('teeth check — the recorder catches leaks externalRefs cannot', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/embed-harness')
    await page.waitForFunction(() => (window as any).__embedHarnessReady === true)
  })

  // Case 1: a static element the static scan COULD in principle have caught too (a
  // literal URL string) — establishes the recorder catches the easy case before the
  // harder one below, which the static scan structurally cannot.
  test('an injected <img> pointing at a real URL is caught', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarness.exportHtml())
    const leaky = html.replace('</body>', '<img src="https://example.com/x.png"></body>')

    const requests = await runExportAndCollectRequests(context, leaky)
    expect(requests).toContain('https://example.com/x.png')
  })

  // Case 2: THE case the static scan cannot see, and the whole reason this file exists.
  // The URL is built from concatenated string fragments at RUNTIME ('https:' + '//...'),
  // exactly mirroring how three.js's FileLoader builds a request URL from a `path` field
  // plus an argument rather than ever holding one literal "https://..." string anywhere
  // in the bundle — externalRefs' absolute-URL pattern requires a CONTIGUOUS "https://"
  // substring in the text it scans, so this genuinely cannot be found by grepping the
  // HTML; only running the page and watching what it actually calls can catch it. The
  // fetch also fires from a setTimeout, i.e. after the live canvas has already rendered
  // — proving "let it render, then wait a beat" (not just "check requests at load") is
  // load-bearing, per the task brief's "fires on the third frame" scenario.
  test('a runtime fetch that only fires after render, with no literal URL string in the page source, is caught', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarness.exportHtml())
    const leakScript = [
      '<script>',
      'setTimeout(function () {',
      "  var proto = 'https:';",
      "  var rest = '//example.com/y';",
      '  fetch(proto + rest);',
      '}, 50);',
      '</script>',
    ].join('')
    const leaky = html.replace('</body>', `${leakScript}</body>`)

    // Confirms the injected fetch really is invisible to the static scan this file
    // exists to complement — if this ever starts finding it, the fixture no longer
    // demonstrates what the test claims and needs to be revisited.
    const { externalRefs } = await import('../app/lib/embed/bundle')
    expect(externalRefs(leaky)).toEqual([])

    const requests = await runExportAndCollectRequests(context, leaky)
    expect(requests).toContain('https://example.com/y')
  })
})

// ROOT-RELATIVE TEETH, one per surface. The leak the old setContent() loader could not
// see: a root-relative URL (the shape a server asset takes — `/view?…`, `/sailor/…`) has
// nothing to resolve against at about:blank, so it never became a request at all. Served
// from EMBED_URL it resolves to `http://embed-network.invalid/…` and must be recorded.
// Each of these was also run against the old setContent() loader during development and
// recorded no request, which is what makes them teeth for THIS change.
test.describe('teeth check — a root-relative asset reference is caught on every surface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/embed-harness')
    await page.waitForFunction(() =>
      (window as any).__embedHarnessReady === true
      && (window as any).__embedHarnessGradientReady === true
      && (window as any).__embedHarnessSpaceTypeReady === true)
  })

  const LEAK = '/sailor-teeth.png'
  const LEAK_URL = new URL(LEAK, EMBED_URL).href

  // Natural: the shader config's own image field, un-inlined. `baseDataUrl` goes straight
  // to `img.src` at mount, and a bare "/…" string inside the JSON config matches none of
  // externalRefs' patterns — so the export gate lets it through, exactly the case this
  // runtime check exists for. The export mounts the config in the harness page to capture
  // its poster, so the asset has to exist on the authoring server (as a real one would):
  // it is served there as a 1x1 PNG. In the exported page it fails to load and mount()
  // rejects (the poster stays up), so this one does not wait for a live render.
  test('shader: an un-inlined base image in the config is caught', async ({ page, context }) => {
    const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    await page.route(`**${LEAK}`, r => r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }))
    const html = await page.evaluate(async (leak: string) => {
      const H = (window as any).__embedHarness
      return await H.exportWith({ ...H.config, baseDataUrl: leak }, 512, 512)
    }, LEAK)
    const requests = await runExportAndCollectRequests(context, html, { live: false })
    expect(requests).toContain(LEAK_URL)
  })

  // Injected: the gradient config loads nothing by URL, so there is no field to leave
  // un-inlined. A root-relative <img> is appended to the exported HTML instead.
  test('gradient: an injected root-relative <img> is caught', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarnessGradient.exportHtml())
    const leaky = html.replace('</body>', `<img src="${LEAK}"></body>`)
    const requests = await runExportAndCollectRequests(context, leaky)
    expect(requests).toContain(LEAK_URL)
  })

  // Injected: Space Type's one URL-shaped asset, `font.dataUrl`, is refused at mount by
  // fontFaceRule unless it is a data: URI, so it cannot carry a relative URL. Same <img>
  // injection as the gradient case.
  test('spacetype: an injected root-relative <img> is caught', async ({ page, context }) => {
    const html = await page.evaluate(() => (window as any).__embedHarnessSpaceType.exportHtml())
    const leaky = html.replace('</body>', `<img src="${LEAK}"></body>`)
    const requests = await runExportAndCollectRequests(context, leaky)
    expect(requests).toContain(LEAK_URL)
  })
})
