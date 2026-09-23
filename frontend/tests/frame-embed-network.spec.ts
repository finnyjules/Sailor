import { test, expect } from '@playwright/test'
import { openHarness, renderExported } from './_frameEmbedHelpers'

test.describe('Frame embed — zero network', () => {
  test.beforeEach(async ({ page }) => openHarness(page))

  // 'shatter' (R9): even cold (this frozen single-paint render never gets past the pass-through
  // frame), applyShatter still KICKS `warmPaperBoolean`'s dynamic `import('paper')` — proving
  // that import resolves against the bundle's own inlined paper-core, not a network fetch.
  for (const name of ['vector', 'image', 'backdrop', 'still', 'fill', 'standin', 'shatter']) {
    test(`the "${name}" export makes no request`, async ({ page, context }) => {
      const html = await page.evaluate(async (n) => {
        const H = (window as any).__frameEmbedHarness
        return await H.exportHtml(await H.snapshot(n))
      }, name)
      const { requests } = await renderExported(context, html, 0.4, { width: 1000, height: 500 })
      expect(requests).toEqual([])
    })
  }

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
    const { requests } = await renderExported(context, html, 0.4, { width: 1000, height: 500 })
    expect(requests.some(u => u.includes('/view?'))).toBe(true)
  })
})
