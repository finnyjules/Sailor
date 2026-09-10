import { test, expect, type Page } from '@playwright/test'

async function stackPixels(page: Page): Promise<string> {
  await page.waitForTimeout(500)
  return await page.evaluate(() => (document.querySelector('[data-testid="compositor-stack-canvas"]') as HTMLCanvasElement).toDataURL())
}
async function frame(page: Page) {
  return await page.evaluate(() => { const p = (window as any).__frameLab.node.data.properties; return { layers: JSON.parse(JSON.stringify(p.sailor_localLayers)), order: p.sailor_stackOrder ?? null, poster: p.sailor_posterState ?? null } })
}
// `paintLayerStack` fills the WHOLE tile with the fixture background first, so
// counting alpha>0 pixels is vacuous — an empty tile (background only) passes
// too. Count pixels whose RGB differs from the background by more than 24 on
// any channel instead: that only trips once something was actually painted
// OVER the background.
async function tileIsPainted(page: Page, selector = '[data-testid="layout-tile"] canvas'): Promise<boolean> {
  return await page.evaluate((sel) => {
    const bgHex = ((window as any).__frameLab?.node?.data?.properties?.sailor_localBg as string | undefined) ?? '#000000'
    const h = bgHex.replace('#', '')
    const bg = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
    const cv = document.querySelector(sel) as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data
    let diff = 0
    const total = d.length / 4
    for (let i = 0; i < d.length; i += 4) {
      const dr = Math.abs(d[i]! - bg[0]!), dg = Math.abs(d[i + 1]! - bg[1]!), db = Math.abs(d[i + 2]! - bg[2]!)
      if (dr > 24 || dg > 24 || db > 24) diff++
    }
    return diff > total * 0.05        // more than 5% of pixels differ from the background
  }, selector)
}
// Quantised (4 bits/channel) distinct-colour count for one tile's canvas — a
// photograph carries far more distinct colours than type on a flat ground, so
// this is the proof that a wired photo actually painted, not just some pixels.
async function distinctColorCount(page: Page, selector: string): Promise<number> {
  return await page.evaluate((sel) => {
    const cv = document.querySelector(sel) as HTMLCanvasElement
    const ctx = cv.getContext('2d')!
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data
    const seen = new Set<number>()
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]! >> 4, g = d[i + 1]! >> 4, b = d[i + 2]! >> 4
      seen.add((r << 8) | (g << 4) | b)
    }
    return seen.size
  }, selector)
}

test.describe('Frame Layout tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab')
    await page.waitForSelector('[data-ready]')
    await page.click('[data-testid="layout-tab"]')
    await page.waitForSelector('[data-testid="layout-tile"]')
  })

  test('shows painted tiles, one per fitting pattern, with sentence-case names', async ({ page }) => {
    const tiles = page.locator('[data-testid="layout-tile"]')
    expect(await tiles.count()).toBeGreaterThanOrEqual(3)
    await page.waitForTimeout(800)                 // fonts + images + paint
    expect(await tileIsPainted(page)).toBe(true)
    const labels = await page.locator('[data-testid="layout-sheet"] .text-\\[11px\\]').allTextContents()
    for (const l of labels) expect(l.trim()).toMatch(/^[A-Z]/)
    // Prove the wired photo itself painted, not just SOME pixels: a tile using
    // photoBehind must carry far more distinct colours than type on a flat
    // ground (the fixture wires two real photos into slots 1/2).
    const photoTileSel = '[data-testid="layout-tile"][data-pattern="photoBehind"]'
    expect(await page.locator(photoTileSel).count()).toBeGreaterThan(0)
    expect(await distinctColorCount(page, `${photoTileSel} canvas`)).toBeGreaterThanOrEqual(40)
  })

  test('clicking a tile applies it as ONE undo step: layers move, order is written, faces and colours stay', async ({ page }) => {
    const before = await frame(page)
    const px0 = await stackPixels(page)
    const first = page.locator('[data-testid="layout-tile"]').first()
    const patternId = await first.getAttribute('data-pattern')
    await first.click()
    const after = await frame(page)
    expect(after.poster?.patternId).toBe(patternId)
    expect(Array.isArray(after.order)).toBe(true)
    expect(after.layers.map((l: any) => [l.x, l.y, l.fontSize])).not.toEqual(before.layers.map((l: any) => [l.x, l.y, l.fontSize]))
    for (const l of after.layers.filter((l: any) => l.kind === 'text')) {
      const b = before.layers.find((x: any) => x.id === l.id)
      expect([l.fontFamily, l.fontWeight, l.color, l.text]).toEqual([b.fontFamily, b.fontWeight, b.color, b.text])
    }
    expect(await stackPixels(page)).not.toBe(px0)
    // one undo returns EVERYTHING — layers and order
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    const undone = await frame(page)
    expect(undone.layers).toEqual(before.layers)
    expect(undone.order).toEqual(before.order)
  })

  test('Another re-rolls the seed; More like this narrows to one pattern; All layouts returns', async ({ page }) => {
    const seeds0 = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-seed')))
    await page.click('[data-testid="layout-another"]')
    const seeds1 = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-seed')))
    expect(seeds1).not.toEqual(seeds0)
    await page.locator('[data-testid="layout-tile"]').first().hover()
    await page.locator('[data-testid="layout-tile-more"]').first().click({ force: true })
    const patterns = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-pattern')))
    expect(new Set(patterns).size).toBe(1)
    expect(patterns.length).toBe(6)
    await page.click('[data-testid="layout-back"]')
    const again = await page.locator('[data-testid="layout-tile"]').evaluateAll(els => els.map(e => e.getAttribute('data-pattern')))
    expect(new Set(again).size).toBeGreaterThan(1)
  })
})
