import { test, expect, type Page } from '@playwright/test'

async function frame(page: Page) {
  return await page.evaluate(() => { const p = (window as any).__frameLab.node.data.properties; return { layers: JSON.parse(JSON.stringify(p.sailor_localLayers)), bg: p.sailor_localBg ?? null, memory: p.sailor_recolour ?? null } })
}
const solidColours = (layers: any[]) => layers.map((l: any) => typeof l.color === 'string' ? l.color : typeof l.fill === 'string' ? l.fill : null)

test.describe('Frame recolour', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-lab'); await page.waitForSelector('[data-ready]')
    // nothing selected: click the canvas background outside every layer is unreliable; the lab opens with no selection
    await page.waitForSelector('[data-testid="frame-colours"]')
  })

  test('shows the frame\'s colour slots, heaviest first, with the background first', async ({ page }) => {
    const hexes = await page.locator('[data-testid="colour-slot"]').evaluateAll(els => els.map(e => e.getAttribute('data-hex')))
    expect(hexes.length).toBeGreaterThanOrEqual(3)
    const { bg } = await frame(page)
    if (typeof bg === 'string') expect(hexes[0]).toBe(bg.toLowerCase())
  })

  test('picking a family recolours the frame in one undo step, keeping shared colours shared', async ({ page }) => {
    const before = await frame(page)
    // open the picker's Library pane (the seed-engine shelf) and click the first family tile
    const libraryTab = page.getByRole('button', { name: /library/i }).first()
    await libraryTab.click()
    const tile = page.locator('[data-testid="frame-colours"] [data-testid="palette-family"]').first()
    await tile.waitFor({ timeout: 10000 })
    await tile.click()
    const after = await frame(page)
    expect(after.memory?.hexes?.length).toBeGreaterThan(0)
    expect(solidColours(after.layers)).not.toEqual(solidColours(before.layers))
    // sharing preserved: pairs of layers that matched before still match
    const b = solidColours(before.layers), a = solidColours(after.layers)
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (b[i] && b[i] === b[j]) expect(a[i]).toBe(a[j])
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    const undone = await frame(page)
    expect(undone.layers).toEqual(before.layers); expect(undone.bg).toEqual(before.bg)
  })

  test('a slot can be sent to another colour of the applied family', async ({ page }) => {
    await page.getByRole('button', { name: /library/i }).first().click()
    const tile = page.locator('[data-testid="frame-colours"] [data-testid="palette-family"]').first()
    await tile.waitFor({ timeout: 10000 }); await tile.click()
    const slot = page.locator('[data-testid="colour-slot"]').nth(1)
    const slotHex = await slot.getAttribute('data-hex')
    await slot.click()
    // `hasNot` filters by descendant match, and these option buttons are leaves with
    // no descendants — that filter is always a no-op here, so exclude by attribute instead.
    const option = page.locator(`[data-testid="colour-slot-option"]:not([data-hex="${slotHex}"])`).first()
    const toHex = await option.getAttribute('data-hex')
    await option.click()
    const { layers, bg } = await frame(page)
    const all = [...solidColours(layers), typeof bg === 'string' ? bg : null].filter(Boolean).map(h => (h as string).toLowerCase())
    expect(all).not.toContain(slotHex); expect(all).toContain(toHex)
  })

  test('Images too puts a family gradient map on the photos, in the same undo step, and clears it when turned off', async ({ page }) => {
    const before = await frame(page)
    const toggle = page.locator('[data-testid="recolour-images"] [role="switch"]')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: /library/i }).first().click()
    const tile = page.locator('[data-testid="frame-colours"] [data-testid="palette-family"]').first()
    await tile.waitFor({ timeout: 10000 }); await tile.click()
    const after = await frame(page)
    const photos = after.layers.filter((l: any) => l.kind === 'image' || l.kind === 'wired')
    expect(photos.length).toBeGreaterThan(0)
    for (const p of photos) {
      const maps = (p.effects ?? []).filter((e: any) => e.type === 'gradientMap')
      expect(maps).toHaveLength(1); expect(maps[0].stops.length).toBeGreaterThanOrEqual(2); expect(maps[0].mix).toBe(1)
      expect(after.memory.imageEffects[p.id]).toBe(maps[0].id)
    }
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    const undone = await frame(page)
    expect(undone.layers).toEqual(before.layers)                       // ONE undo took the maps with the colours
    // turn it off and re-apply: the owned maps go away
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await tile.click()
    const cleared = await frame(page)
    for (const p of cleared.layers.filter((l: any) => l.kind === 'image' || l.kind === 'wired')) expect((p.effects ?? []).filter((e: any) => e.type === 'gradientMap')).toHaveLength(0)
    expect(cleared.memory.imageEffects).toEqual({})
  })
})
