import { test, expect } from '@playwright/test'
import { openHarness, renderExported, pixelDiff } from './_frameEmbedHelpers'

test.describe('Frame embed — zero network', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  // 'shatter'/'boolean' (R9/R14c): both fixtures carry FrameSnapshot.needsOutlines: true, so
  // surfaces/frame.ts's mount() now `await warmPaperBoolean()`s — which does `import('paper')` —
  // BEFORE its first paint, every time, not merely on some cold/best-effort path. This proves that
  // AWAITED import resolves against the full bundle's own inlined paper-core module and never
  // reaches the network, however this fixture's needsOutlines flag routes it (currently 'frame',
  // never 'frame-lean' — see gather.ts's computeNeedsOutlines).
  // 'outline' / 'text-partner' (C1 / I1): outlined text and a text boolean partner — both reach
  // the outline-font loader, which must answer from the file, never /api/fonts/….
  // 'wired-clip' (Task 7): an animated wired studio baked into frames inside the file.
  for (const name of ['vector', 'image', 'backdrop', 'still', 'fill', 'standin', 'shatter', 'boolean', 'outline', 'text-partner', 'wired-clip']) {
    test(`the "${name}" export makes no request`, async ({ page, context }) => {
      const html = await page.evaluate(async (n) => {
        const H = (window as any).__frameEmbedHarness
        return await H.exportHtml(await H.snapshot(n))
      }, name)
      const { requests } = await renderExported(context, html, 0.4, { width: 1000, height: 500 })
      expect(requests).toEqual([])
    })
  }

  // Task 7: the wired clip PLAYS — the file's canvas differs between two moments — and it does so
  // from the frames inside the file (the zero-request check above covers the same fixture).
  test('an animated wired layer plays in the export instead of freezing', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('wired-clip')
      if (snap.wired[0]?.kind !== 'clip' || snap.wired[0].frames.length !== 6) throw new Error('the wired-clip fixture did not bake 6 frames')
      if (snap.still) throw new Error('a Frame with a wired clip must not be a still')
      return await H.exportHtml(snap)
    })
    const a = await renderExported(context, html, 0.1, { width: 1000, height: 500 })
    const b = await renderExported(context, html, 0.6, { width: 1000, height: 500 })
    expect(a.requests).toEqual([])
    expect(b.requests).toEqual([])
    const { differing } = await pixelDiff(page, a.png, b.png)
    expect(differing).toBeGreaterThan(1000)
  })

  // The gate on the gate: a snapshot with one inlined image removed must make the painter fall
  // back to the server URL, and this listener must see that request. Otherwise the tests above
  // prove nothing. The image removed is the image FILL: an image LAYER or clip frame missing from
  // the snapshot makes the adapter refuse to mount at all (the poster stays; see the contract
  // spec), so the fill is the path on which the painter itself still reaches for its URL.
  test('a missing inlined asset IS seen as a request', async ({ page, context }) => {
    const html = await page.evaluate(async () => {
      const H = (window as any).__frameEmbedHarness
      const snap = await H.snapshot('fill')
      const key = Object.keys(snap.assets.urls).find(k => k.startsWith('fillImage|'))
      if (!key) throw new Error('the fill fixture carries no inlined image fill')
      delete snap.assets.urls[key]
      return await H.exportHtml(snap)
    })
    // ignorePageErrorsMatching, not a blanket allow (fix round 2): this test deliberately makes
    // the painter reach for a missing asset — Chromium logs its own console.error for the
    // resulting failed request (ERR_NAME_NOT_RESOLVED, since EMBED_URL's origin never resolves),
    // which is proof the mechanism worked, not a defect — but any OTHER page error here would
    // still be a real one, and must still fail this test.
    const { requests } = await renderExported(
      context, html, 0.4, { width: 1000, height: 500 }, { ignorePageErrorsMatching: /ERR_NAME_NOT_RESOLVED/ },
    )
    expect(requests.some(u => u.includes('/view?'))).toBe(true)
  })
})
