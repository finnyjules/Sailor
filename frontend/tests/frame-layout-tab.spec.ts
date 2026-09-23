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
    const labels = await page.locator('[data-testid="layout-sheet"] [data-testid="layout-tile"] + div').allTextContents()
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

  test('Vary (the button, V and the arrow keys) steps through the variations, each one undo step', async ({ page }) => {
    // Start from an applied layout, so the count and the choices belong to it.
    await page.locator('[data-testid="layout-sheet"] [data-testid="layout-tile"]').first().click()
    const count = page.locator('[data-testid="layout-vary-count"]')
    await expect(count).toHaveText(/^1 of \d+$/)
    const total = Number((await count.textContent())!.split(' of ')[1])
    test.skip(total < 2, 'the fixture\'s first layout has a single variation')
    const before = await frame(page)
    await page.click('[data-testid="layout-vary-next"]')
    await expect(count).toHaveText(`2 of ${total}`)
    const after = await frame(page)
    expect(after.poster?.index).toBe(1)
    expect(after.layers).not.toEqual(before.layers)
    await page.locator('[data-testid="layout-vary-name"]').click()   // focus off any field
    await page.keyboard.press('v')
    await expect(count).toHaveText(total > 2 ? `3 of ${total}` : `1 of ${total}`)
    const beforeArrow = await frame(page)
    // The arrows step variations only with nothing selected (with a selection they nudge): clear it
    // the way a click on the empty stage does (dispatched on the stage itself, so no panel is hit).
    await page.locator('[data-testid="compositor-stage"]').dispatchEvent('click')
    await page.keyboard.press('ArrowLeft')
    await expect(count).toHaveText(`2 of ${total}`)
    // each step is one undo step: one undo returns the layers from before the arrow
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    expect((await frame(page)).layers).toEqual(beforeArrow.layers)
  })

  test('a layout\'s own pieces go when another layout is applied', async ({ page }) => {
    const owned = async () => (await frame(page)).layers.filter((l: any) => l.owner?.by === 'layout').map((l: any) => l.owner.key).sort()
    const apply = async (id: string) => {
      const tile = page.locator(`[data-testid="layout-sheet"] [data-testid="layout-tile"][data-pattern="${id}"]`).last()   // the library tile (variation tiles share the id)
      await tile.scrollIntoViewIfNeeded()
      await tile.click()
      await expect.poll(async () => (await frame(page)).poster?.patternId).toBe(id)
    }
    // Run-off's own pieces, alone
    await apply('runoff')
    const runoffOnly = await owned()
    // Index adds rules; applying Run-off afterwards leaves exactly Run-off's pieces
    await apply('index')
    const indexPieces = await owned()
    expect(indexPieces.some((k: string) => k.startsWith('rule'))).toBe(true)
    await apply('runoff')
    expect(await owned()).toEqual(runoffOnly)
  })

  test('a format keeps text clear of the app and carries only its lines', async ({ page }) => {
    // Pick a format in the Frame section of the Design tab (nothing selected).
    await page.click('[data-testid="design-tab"], button:has-text("Design")')
    const size = page.locator('select:has(option[value="meta-story"])').first()
    await size.selectOption('meta-story')
    await page.click('[data-testid="layout-tab"]')
    await expect(page.locator('[data-testid="layout-format-label"]')).toHaveText('Format: Meta story / reel · 9:16')
    await expect(page.locator('[data-testid="keep-clear-overlay"]')).toBeVisible()
    await expect(page.locator('[data-testid="keep-clear-overlay"]')).toContainText('Covered by the app')
    // Apply the first offered layout: every visible text layer sits inside the uncovered band.
    await page.locator('[data-testid="layout-sheet"] [data-testid="layout-tile"]').first().click()
    const band = await page.evaluate(() => {
      const p = (window as any).__frameLab.node.data.properties
      // Only the lines the layout places (its stored roles); other text layers keep their spots.
      const ids = Object.values(p.sailor_posterState?.roles ?? {}) as string[]
      const texts = p.sailor_localLayers.filter((l: any) => ids.includes(l.id) && l.visible !== false)
      return texts.map((l: any) => l.y)
    })
    for (const y of band) { expect(y).toBeGreaterThan(0.14); expect(y).toBeLessThan(0.65) }

    // A video thumbnail carries two lines: the others are hidden and named in the panel.
    await page.click('[data-testid="design-tab"], button:has-text("Design")')
    await size.selectOption('video-thumb')
    await page.click('[data-testid="layout-tab"]')
    await expect(page.locator('[data-testid="layout-format-hidden"]')).toContainText('Not shown in this format')
    await expect(page.locator('[data-testid="keep-clear-overlay"]')).toHaveCount(0)
    await page.locator('[data-testid="layout-sheet"] [data-testid="layout-tile"]').first().click()
    const hidden = await page.evaluate(() => {
      const p = (window as any).__frameLab.node.data.properties
      const roles = p.sailor_posterState?.roles ?? {}
      const vis = (id?: string) => p.sailor_localLayers.find((l: any) => l.id === id)?.visible
      return { title: vis(roles.title), date: roles.date ? vis(roles.date) : false, caption: roles.caption ? vis(roles.caption) : false }
    })
    expect(hidden.title).not.toBe(false)
    expect(hidden.date).toBe(false)
    expect(hidden.caption).toBe(false)
  })
})
