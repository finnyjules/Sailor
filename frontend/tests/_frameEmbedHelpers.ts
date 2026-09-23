import { expect, type BrowserContext, type Page } from '@playwright/test'

export async function openHarness(page: Page): Promise<void> {
  await page.goto('/dev/frame-embed-harness')
  await page.waitForFunction(() => (window as any).__frameEmbedHarnessReady === true, undefined, { timeout: 30_000 })
}

/** Where renderExported serves the exported file from. A real http origin, not `setContent`'s
 *  about:blank: against about:blank a root-relative URL such as the painter's `/view?…` fallback
 *  does not resolve, so it would never become a request and the zero-network gate would pass
 *  for the wrong reason. `.invalid` never resolves, so nothing this page asks for can succeed. */
const EMBED_URL = 'http://frame-embed.invalid/'

/** Loads an exported file in a FRESH page (its own document: its own fonts, its own module state),
 *  freezes it at `t01`, and returns the live canvas plus every request the file made. Mirrors
 *  tests/embed-parity.spec.ts: the freeze flag must be a context init script, not a page one. */
export async function renderExported(
  context: BrowserContext, html: string, t01: number, viewport: { width: number; height: number },
): Promise<{ png: string; requests: string[] }> {
  await context.addInitScript((t: number) => { (window as any).__SAILOR_FREEZE_T01__ = t }, t01)
  const p = await context.newPage()
  const requests: string[] = []
  p.on('request', r => {
    const u = r.url()
    if (u === EMBED_URL) return   // the exported file itself
    if (!u.startsWith('data:') && u !== 'about:blank') requests.push(u)
  })
  p.on('websocket', ws => requests.push(`ws:${ws.url()}`))
  await p.route(EMBED_URL, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await p.setViewportSize(viewport)
  await p.goto(EMBED_URL)
  await p.waitForFunction(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
    return !!c && c.width > 1
  }, undefined, { timeout: 30_000 })
  expect(await p.locator('#sailor-poster').isHidden()).toBe(true)   // the LIVE path ran, not the poster
  const png = await p.evaluate(() => (document.querySelector('#sailor-embed canvas') as HTMLCanvasElement).toDataURL())
  // A beat after the frame, so a load the painter starts late (a lazily decoded image) is seen too.
  await p.waitForTimeout(300)
  await p.close()
  return { png, requests }
}

/**
 * Like `renderExported`, but does NOT freeze the clock — the export's own rAF loop keeps calling
 * `setTime`, exactly as it would embedded in a real host page. R9's paper-core check needs this:
 * a geometry effect that reads paper.js (`boolean`/`shatter`) is COLD on a mount's first paint by
 * construction (`warmPaperBoolean`'s `import('paper')` is always async, kicked but not awaited —
 * see booleanGeometry.ts), so a frozen single-shot `renderExported` would only ever capture the
 * pass-through frame and could never prove paper-core computes the same clipped geometry the full
 * `paper` package does. Waits `settleMs` past the canvas's first paint (several rAF ticks — long
 * enough for the already-bundled dynamic import to resolve and the loop's next tick to repaint
 * with the warmed result) before reading pixels. Only meaningful for a STILL fixture (no motion):
 * with nothing animating, any post-warm tick paints the same pixels, so the exact tick sampled
 * does not matter.
 */
export async function renderExportedLive(
  context: BrowserContext, html: string, viewport: { width: number; height: number }, settleMs = 800,
): Promise<{ png: string; requests: string[] }> {
  const p = await context.newPage()
  const requests: string[] = []
  p.on('request', r => {
    const u = r.url()
    if (u === EMBED_URL) return
    if (!u.startsWith('data:') && u !== 'about:blank') requests.push(u)
  })
  p.on('websocket', ws => requests.push(`ws:${ws.url()}`))
  await p.route(EMBED_URL, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }))
  await p.setViewportSize(viewport)
  await p.goto(EMBED_URL)
  await p.waitForFunction(() => {
    const c = document.querySelector('#sailor-embed canvas') as HTMLCanvasElement | null
    return !!c && c.width > 1
  }, undefined, { timeout: 30_000 })
  expect(await p.locator('#sailor-poster').isHidden()).toBe(true)
  await p.waitForTimeout(settleMs)
  const png = await p.evaluate(() => (document.querySelector('#sailor-embed canvas') as HTMLCanvasElement).toDataURL())
  await p.close()
  return { png, requests }
}

/** Pixels whose any channel differs by more than `threshold` levels (default 2). Sizes must match;
 *  a size mismatch returns differing = -1. */
export async function pixelDiff(page: Page, a: string, b: string, threshold = 2): Promise<{ differing: number; total: number }> {
  return await page.evaluate(async ([x, y, th]) => {
    const load = (u: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = u })
    const [ia, ib] = await Promise.all([load(x!), load(y!)])
    if (ia.width !== ib.width || ia.height !== ib.height) return { differing: -1, total: 0 }
    const data = (i: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = i.width; c.height = i.height
      const g = c.getContext('2d')!; g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data
    }
    const da = data(ia), db = data(ib)
    let differing = 0
    for (let p = 0; p < da.length; p += 4) {
      if (Math.abs(da[p]! - db[p]!) > th || Math.abs(da[p + 1]! - db[p + 1]!) > th
        || Math.abs(da[p + 2]! - db[p + 2]!) > th || Math.abs(da[p + 3]! - db[p + 3]!) > th) differing++
    }
    return { differing, total: da.length / 4 }
  }, [a, b, threshold] as const)
}
