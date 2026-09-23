import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { externalRefs } from '../app/lib/embed/bundle'

/**
 * The Frame web export sheet, end to end, in the REAL CompositorModal over a real Frame node
 * (/dev/frame-lab mounts the card and opens the modal on load; a fresh browser context has no
 * saved fixture, so this is always the pristine one).
 *
 * The sheet must say what goes in the file before anything downloads: the size, and the fonts
 * (frame-lab's text layers use Inter, a real web family). The downloaded file must be a Frame
 * embed that loads nothing from the network, and Fit / Fill must change what the sheet says.
 *
 * Run: cd frontend && PW_BASE_URL=http://127.0.0.1:3002 npx playwright test tests/frame-web-export-sheet.spec.ts --project=chromium
 */
test.describe.configure({ timeout: 180_000 })

test('Web export: the sheet names the fonts, downloads a self-contained Frame file, and Fill changes the hint', async ({ page }, testInfo) => {
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]', { timeout: 30_000 })
  await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 30_000 })

  // The web export is the "Export embed" row of the right panel's Download menu.
  const openWebExport = async () => {
    await page.locator('[data-testid="compositor-right-panel"]').getByRole('button', { name: /^Download/ }).click()
    await page.locator('[data-testid="frame-web-export"]').click()
  }
  const sheet = page.locator('[data-testid="frame-web-export-sheet"]')
  await openWebExport()
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('One file · plays anywhere')).toBeVisible({ timeout: 90_000 })
  await expect(sheet.getByText('Fonts going into the file')).toBeVisible()
  await expect(sheet.locator('[data-testid="frame-web-export-group-fonts"] li').first()).toContainText('Inter')
  await expect(sheet.getByRole('button', { name: 'Download' })).toBeEnabled()
  await sheet.screenshot({ path: testInfo.outputPath('web-export-sheet-ready.png') })

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    sheet.getByRole('button', { name: 'Download' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('sailor-frame.html')
  const html = await readFile((await download.path())!, 'utf8')
  expect(html).toContain('__SAILOR_SNAPSHOT__')
  expect(html).toContain('"kind":"frame"')
  // Self-contained. `externalRefs` is the export's own network gate (bundle.ts imports only a
  // type, so it runs here in Node). The snapshot — the Frame's DATA — must carry no ComfyUI image
  // URL and no Google Fonts reference: every image and font is inlined. (The whole file cannot be
  // checked for "/view?": the renderer's own code holds that string as the fallback its asset
  // resolver never reaches in an export — frame-embed-network.spec.ts proves no request is made.)
  expect(externalRefs(html)).toEqual([])
  const start = html.indexOf('window.__SAILOR_SNAPSHOT__ = ')
  expect(start).toBeGreaterThan(-1)
  const snapshotJson = html.slice(start, html.indexOf('</script>', start))
  expect(snapshotJson).toContain('"kind":"frame"')
  expect(snapshotJson).not.toContain('/view?')
  expect(snapshotJson).not.toContain('fonts.googleapis.com')
  expect(html).not.toContain('https://fonts.googleapis.com')
  await expect(sheet).toBeHidden()
  await expect(page.getByText(/^Downloaded · /)).toBeVisible()

  await openWebExport()
  await expect(sheet.getByText('Whole Frame stays visible. The background stretches to the edges of the box.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Fill', exact: true }).click()
  await expect(sheet.getByText('Frame covers the whole box. The edges get cropped.')).toBeVisible()
  await expect(sheet.getByText('Whole Frame stays visible. The background stretches to the edges of the box.')).toHaveCount(0)
})

// The final review's sheet findings, in the real modal: an edit made while the sheet is open
// rebuilds the file (I5); Copy embed code confirms, and a refused clipboard shows the code to copy
// by hand (U2); the sheet is a dialog (U4); Escape closes the sheet, not the Frame editor (U1).
test('Web export: an edit while the sheet is open rebuilds the file; Copy confirms or falls back; Escape closes only the sheet', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/dev/frame-lab')
  await page.waitForSelector('[data-ready]', { timeout: 30_000 })
  await page.locator('[data-testid="compositor-stack-canvas"]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForSelector('[data-testid="frame-colours"]')

  await page.locator('[data-testid="compositor-right-panel"]').getByRole('button', { name: /^Download/ }).click()
  await page.locator('[data-testid="frame-web-export"]').click()
  const sheet = page.getByRole('dialog', { name: 'Web export' })
  await expect(sheet).toBeVisible()
  const copy = sheet.getByRole('button', { name: 'Copy embed code' })
  await expect(sheet.getByText('One file · plays anywhere')).toBeVisible({ timeout: 90_000 })

  // I5: recolour a slot with the sheet open. The file must be rebuilt (the sheet goes back to
  // working, then ready) and the download must carry the new colour.
  const hexInput = page.locator('[data-testid="colour-slot"]').nth(1).locator('[data-testid="colour-slot-hex"]')
  await hexInput.fill('12abef'); await hexInput.press('Enter')
  await expect(sheet.getByText('Working out what goes in the file…')).toBeVisible({ timeout: 5_000 })
  await expect(copy).toBeDisabled()   // U2: nothing to copy until the file is ready
  await expect(sheet.getByText('One file · plays anywhere')).toBeVisible({ timeout: 90_000 })

  // U2: a successful copy says so; a refused one shows the code instead of throwing.
  await copy.click()
  await expect(sheet.getByText('Copied', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('<iframe src="sailor-frame.html"')
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')) })
  await copy.click()
  await expect(sheet.getByText("Couldn't copy. Select the code below and copy it by hand.")).toBeVisible()
  await expect(sheet.getByRole('textbox', { name: 'Embed code' })).toHaveValue(/<iframe src="sailor-frame.html"/)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    sheet.getByRole('button', { name: 'Download' }).click(),
  ])
  const html = await readFile((await download.path())!, 'utf8')
  const start = html.indexOf('window.__SAILOR_SNAPSHOT__ = ')
  expect(html.slice(start, html.indexOf('</script>', start)).toLowerCase()).toContain('#12abef')

  // U1: Escape with the sheet open closes the sheet and leaves the Frame editor open.
  await page.locator('[data-testid="compositor-right-panel"]').getByRole('button', { name: /^Download/ }).click()
  await page.locator('[data-testid="frame-web-export"]').click()
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(page.locator('[data-testid="compositor-stack-canvas"]')).toBeVisible()
})
