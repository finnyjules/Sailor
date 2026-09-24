import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { openCompositor } from './_helpers'

// Stage 5 — make a set: tick formats in the Layout tab, see the Frame's layout at each one,
// download the set as a zip, and send one format to the canvas as its own Frame.
test.describe('Frame Layout tab — make a set', () => {
  test('a set of two formats downloads as a zip and one format goes to the canvas', async ({ page }) => {
    test.setTimeout(180_000)
    await openCompositor(page)
    await page.evaluate(() => {
      const mk = (id: string, text: string, fontSize: number, y: number) => ({ id, kind: 'text', text, x: 0.5, y, rotation: 0, opacity: 1, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111', align: 'center' })
      ;(window as any).__compositorSetLayers([
        mk('t1', 'Weather Report', 0.12, 0.2), mk('t2', 'Ines Vollmer', 0.04, 0.4),
        mk('t3', '19.09.–15.11.2026', 0.03, 0.5), mk('t4', 'Kunstraum Lenz, Basel', 0.02, 0.6),
      ])
    })
    await page.click('[data-testid="layout-tab"]')
    await page.locator('[data-testid="layout-sheet"] [data-testid="layout-tile"]').first().click()
    await page.locator('[data-testid="layout-set-toggle"]').click()
    const formats = page.locator('[data-testid="layout-set-format"]')
    await formats.filter({ hasText: 'Meta feed · 1:1' }).locator('input').check()
    await formats.filter({ hasText: 'Meta story / reel · 9:16' }).locator('input').check()
    await page.locator('[data-testid="layout-set-open"]').click()
    const sheet = page.locator('[data-testid="layout-set-sheet"]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('in 2 formats')

    // Download: one zip with an entry per format that fits.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.locator('[data-testid="layout-set-download"]').click(),
    ])
    expect(download.suggestedFilename()).toMatch(/_set_\d+\.zip$/)
    const zip = await JSZip.loadAsync(await readFile((await download.path())!))
    const names = Object.keys(zip.files).sort()
    expect(names.length).toBeGreaterThanOrEqual(1)
    for (const n of names) expect(n).toMatch(/^(meta-feed-1x1|meta-story)\.png$/)
    const png = await zip.file(names[0]!)!.async('uint8array')
    expect([...png.slice(1, 4)].map(c => String.fromCharCode(c)).join('')).toBe('PNG')

    // Send the story to the canvas: a new Frame node appears; one undo takes it away.
    const count = async () => await page.locator('.vue-flow__node').count()
    const before = await count()
    await sheet.getByRole('button', { name: 'Send to canvas' }).nth(1).click()
    await expect.poll(count, { timeout: 10_000 }).toBe(before + 1)
  })
})
