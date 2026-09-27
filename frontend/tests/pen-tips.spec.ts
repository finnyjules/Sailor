// tests/pen-tips.spec.ts
// The pen toolbar's tooltip cards and single-letter tool keys on the pen test
// page, driven with the REAL mouse and keyboard (page.mouse / page.keyboard).
import { test, expect, type Page } from '@playwright/test'

const SHOTS = process.env.PEN_TIP_SHOTS   // a directory: save the two cards as PNGs there

async function open(page: Page) {
  await page.goto('/dev/sketch-draw')
  await page.waitForSelector('[data-ready]')
  await page.waitForFunction(() => !!(window as any).__sketchDraw)
}
async function hover(page: Page, sel: string) {
  const box = (await page.locator(sel).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
}
async function shoot(page: Page, id: string, file: string) {
  if (!SHOTS) return
  const card = (await page.locator(`[data-pen-tip-id="${id}"]`).boundingBox())!
  const pad = 16
  await page.screenshot({
    path: `${SHOTS}/${file}`,
    clip: { x: card.x - pad, y: card.y - pad, width: card.width + 2 * pad, height: card.height + 2 * pad + 60 },
  })
}

test('hovering Pen shows its card with key, caption and a live demo; the next card follows at once', async ({ page }) => {
  await open(page)
  // nothing on screen yet, and no native title tooltips on the pen buttons
  await expect(page.locator('[data-pen-tip]')).toHaveCount(0)
  expect(await page.locator('.pen-toolbar [title]').count()).toBe(0)

  await hover(page, '[data-tool="path"]')
  const card = page.locator('[data-pen-tip-id="path"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Pen')
  await expect(card.locator('kbd')).toHaveText('P')
  await expect(card).toContainText('press on it and drag to bend the last piece into an arc')
  const ink = card.locator('[data-pen-tip-demo] path.ink')
  const d0 = await ink.getAttribute('d')
  expect(d0 && d0.startsWith('M')).toBeTruthy()
  // it animates while open
  await expect.poll(async () => ink.getAttribute('d'), { timeout: 3000 }).not.toBe(d0)
  // the card sits above the page's modals (portalled, high z-index)
  const z = await card.evaluate(el => Number(getComputedStyle(el.parentElement!).zIndex || getComputedStyle(el).zIndex))
  expect(z).toBeGreaterThan(1000)
  await page.waitForTimeout(900)
  await shoot(page, 'path', 'cards-pen.png')

  // warm-up: moving along the toolbar shows the next card without the delay
  await hover(page, '[data-tool="trim"]')
  const trim = page.locator('[data-pen-tip-id="trim"]')
  // a loaded machine can take a few hundred ms to paint it, so the time alone
  // proves little; the tooltip itself says it skipped the delay (warm-up)
  await expect(trim).toBeVisible({ timeout: 600 })
  await expect(trim).toHaveAttribute('data-state', 'instant-open')
  await expect(trim.locator('kbd')).toHaveText('T')
  await expect(trim).toContainText('Removes a piece between crossings')
  await page.waitForTimeout(1800)   // after the click: the piece gone, its ghost left
  await shoot(page, 'trim', 'cards-trim.png')

  // a non-tool button: a card without a demo
  await hover(page, '[data-act="guide"]')
  await expect(page.locator('[data-pen-tip-id="guide"]')).toBeVisible()
  await expect(page.locator('[data-pen-tip-id="guide"] [data-pen-tip-demo]')).toHaveCount(0)

  // Undo with an empty history: greyed out, and its card still opens
  await expect(page.locator('[data-act="undo"]')).toBeDisabled()
  await hover(page, '[data-act="undo"]')
  const undo = page.locator('[data-pen-tip-id="undo"]')
  await expect(undo).toBeVisible()
  await expect(undo).toContainText('Takes back the last step.')
  await expect(page.locator('[data-act="undo"]')).toHaveAttribute('aria-label', 'Undo')

  // leaving the toolbar closes the card
  await page.mouse.move(5, 5)
  await expect(page.locator('[data-pen-tip]')).toHaveCount(0)
})

test('P, B, L, O, N, T, C, D, G and V pick their tools from the keyboard', async ({ page }) => {
  await open(page)
  const tool = () => page.evaluate(() => (window as any).__sketchDraw.tool)
  const want: [string, string][] = [['p', 'path'], ['t', 'trim'], ['b', 'curve'], ['l', 'line'], ['o', 'circle'], ['n', 'point'], ['c', 'cut'], ['d', 'dissolve'], ['g', 'fill'], ['v', 'select']]
  for (const [k, t] of want) {
    await page.keyboard.press(k)
    expect(await tool(), k).toBe(t)
    await expect(page.locator(`[data-tool="${t}"]`)).toHaveAttribute('aria-pressed', 'true')
  }
  // with a modifier the key is not the pen's
  await page.keyboard.press('Shift+P')
  expect(await tool()).toBe('select')
  await page.keyboard.press('Alt+t')
  expect(await tool()).toBe('select')
})
