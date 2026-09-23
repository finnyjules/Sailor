import { test, expect, type Page } from '@playwright/test'

// Regression for the studios' video export wiring (plan 1 of the browser video
// export), on the Shader Studio lab page: the browser route downloads a file and
// leaves the footer clean; the forced server route says so; Cancel stops the
// export in either route, and nothing downloads afterwards.
//
// The server-route tests upload baked PNG frames to ComfyUI's input/ folder
// (that is how the server route works). They are left there on purpose: input/
// is the app's own upload area, and other sessions' files live beside them.

const LAB = '/dev/shader-studio-lab'
const SERVER_KEY = 'Sailor.VideoExport'

async function openLab(page: Page) {
  await page.goto(LAB)
  await expect(page.getByRole('button', { name: /^Download/ })).toBeVisible({ timeout: 60_000 })
}

async function startDownloadVideo(page: Page) {
  await page.getByRole('button', { name: /^Download/ }).click()
  await page.getByText('Download video', { exact: true }).click()
}

const footer = (page: Page) => page.locator('p.truncate.text-xs').first()

/** The footer's status line, '' when it shows none. */
async function footerText(page: Page): Promise<string> {
  return (await footer(page).count()) ? ((await footer(page).textContent()) ?? '').trim() : ''
}

/** Wait until no export is running (the Download menu is back from "Working…"). */
async function waitIdle(page: Page) {
  await expect(page.getByRole('button', { name: /^Download/ })).toBeVisible({ timeout: 170_000 })
}

// "Empty" footer: no export message. The autosave line may still be there.
const NO_EXPORT_MESSAGE = /^(|Saving…|Saved ✓)$/

test.describe('studio video export — Shader Studio wiring', () => {
  test.setTimeout(180_000)

  test('browser route: Download video saves shader_<digits>.mp4 and leaves the footer clean', async ({ page }) => {
    await openLab(page)
    const download = page.waitForEvent('download', { timeout: 170_000 })
    await startDownloadVideo(page)
    const d = await download
    expect(d.suggestedFilename()).toMatch(/^shader_\d+\.mp4$/)
    await waitIdle(page)
    await expect.poll(() => footerText(page)).toMatch(NO_EXPORT_MESSAGE)
  })

  test.describe('forced server route', () => {
    test.beforeEach(async ({ page }) => {
      const up = await page.request.get('/system_stats').then(r => r.ok()).catch(() => false)
      test.skip(!up, 'ComfyUI is not running')
      await page.goto(LAB)
      await page.evaluate(k => localStorage.setItem(k, 'server'), SERVER_KEY)
      await page.reload()
      await expect(page.getByRole('button', { name: /^Download/ })).toBeVisible({ timeout: 60_000 })
    })
    test.afterEach(async ({ page }) => {
      await page.evaluate(k => localStorage.removeItem(k), SERVER_KEY).catch(() => {})
    })

    test('the download happens, and the footer says it was made on the server', async ({ page }) => {
      const download = page.waitForEvent('download', { timeout: 170_000 })
      await startDownloadVideo(page)
      const d = await download
      expect(d.suggestedFilename()).toMatch(/^shader_\d+\.mp4$/)
      await waitIdle(page)
      await expect(footer(page)).toHaveText('Made on the server (browser recording is switched off).')
    })

    test('Cancel during the server bake stops it, and nothing downloads', async ({ page }) => {
      let downloaded = false
      page.on('download', () => { downloaded = true })
      await startDownloadVideo(page)
      await expect(footer(page)).toHaveText(/^Baking \d+\/\d+$/, { timeout: 60_000 })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(footer(page)).toHaveText('Export cancelled.', { timeout: 30_000 })
      await page.waitForTimeout(5_000)
      expect(downloaded).toBe(false)
      await expect(footer(page)).toHaveText('Export cancelled.')
    })
  })

  test('Cancel: the footer says "Export cancelled." and nothing downloads', async ({ page }) => {
    await openLab(page)
    let downloaded = false
    page.on('download', () => { downloaded = true })
    await startDownloadVideo(page)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(footer(page)).toHaveText('Export cancelled.', { timeout: 30_000 })
    await page.waitForTimeout(5_000)
    expect(downloaded).toBe(false)
    await expect(footer(page)).toHaveText('Export cancelled.')
  })
})
