// frontend/tests/sailor-prompt.spec.ts
import { expect, test, type Page } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

// The one prompt on the canvas (spec §2.1). /api/agent-plan is mocked, so this costs nothing.
async function seedKey(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-prompt') } catch {} })
}
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Ask Sailor' })

// A blank project opens the start modal ("What do you want to make?") over the
// canvas, which rightly blocks `/` and pane clicks. Close it with Escape, then
// wait until the prompt's input is the top element at its own centre — the same
// signal the layout's `/` guard uses.
async function dismissStartModal(page: Page) {
  const heading = page.getByRole('heading', { name: 'What do you want to make?' })
  if (await heading.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await expect(heading).toHaveCount(0)
  }
  await expect.poll(() => prompt(page).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === el || el.parentElement!.contains(hit))
  }), { timeout: 10_000 }).toBe(true)
}

test.describe('Sailor prompt on the canvas', () => {
  test.beforeEach(async ({ page }) => {
    await seedKey(page)
    await waitForBackend(page)
    // Stage 3: every prompt request is routed first. Mock it (no model calls in tests).
    await page.route('**/api/prompt-route', r => r.fulfill({ json: { kind: 'plan', followUps: [], credits: null } }))
    await openBlankWorkflow(page)
  })

  test('/ focuses it, Esc leaves it, suggestions show while focused', async ({ page }) => {
    await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
    await dismissStartModal(page)
    await page.locator('.vue-flow__pane').click({ position: { x: 200, y: 200 } })
    await page.keyboard.press('/')
    await expect(prompt(page)).toBeFocused()
    await expect(page.getByTestId('prompt-suggestions')).toBeVisible()
    await expect(prompt(page)).toHaveAttribute('placeholder', 'Ask Sailor')
    await page.keyboard.press('Escape')
    await expect(prompt(page)).not.toBeFocused()
  })

  test('working shows progress with Stop, and Stop ends it', async ({ page }) => {
    // A distinctive late reply: a bare "late" would substring-match the toolbar's "Templates".
    // The reply lands ~3 s in, after Stop; `replied` resolves once it has, so the
    // final assertion proves Stop discarded a reply that actually arrived.
    let markReplied!: () => void
    const replied = new Promise<void>(r => { markReplied = r })
    await page.route('**/api/agent-plan', async (route) => {
      await new Promise(r => setTimeout(r, 3_000))
      // Stop aborts the fetch, so fulfilling may throw on the aborted request;
      // either way the reply's moment has passed, so always resolve.
      try { await route.fulfill({ json: { text: '{"reasoning":"","commands":[],"message":"too late reply"}' } }) } catch {}
      finally { markReplied() }
    })
    await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
    await dismissStartModal(page)
    await page.waitForTimeout(5_000) // /object_info catalog race, as in agent-fastlane.spec.ts
    await prompt(page).fill('what does this graph do?')
    await prompt(page).press('Enter')
    await expect(page.getByText('Working on “what does this graph do?”')).toBeVisible()
    await page.getByTestId('prompt-stop').click()
    await expect(prompt(page)).toBeVisible()
    await replied
    await page.waitForTimeout(500) // let the app process the (discarded) reply
    await expect(page.getByText('too late reply', { exact: true })).toHaveCount(0)
  })

  test('selecting a node puts its title in the chip and placeholder', async ({ page }) => {
    await page.route('**/api/agent-plan', r => r.fulfill({ json: { text: JSON.stringify({ reasoning: '', message: '', commands: [{ op: 'addNode', args: { nodeType: 'GradientStudio', id: '$new1' } }] }) } }))
    await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
    await dismissStartModal(page)
    await page.waitForTimeout(5_000)
    await prompt(page).fill('a soft gradient')
    await prompt(page).press('Enter')
    const node = page.locator('.vue-flow__node').first()
    await node.waitFor({ state: 'visible', timeout: 15_000 })
    await node.click()
    const chip = page.getByTestId('prompt-selection-chip')
    await expect(chip).toBeVisible()
    const title = (await chip.innerText()).trim()
    await expect(prompt(page)).toHaveAttribute('placeholder', `Change or ask about ${title}`)
    await chip.getByRole('button', { name: 'Clear selection' }).click()
    await expect(chip).toHaveCount(0)
  })
})
