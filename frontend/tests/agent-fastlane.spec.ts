import { expect, test, type Page } from '@playwright/test'
import { openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * Agent fast-lane (Generate⇄agent unification, route 2): a trivially-safe
 * single-node plan auto-places instead of showing a Keep/Reject proposal card,
 * and never runs. The planner (/api/agent-plan) is MOCKED with page.route() so
 * these tests are deterministic and cost nothing.
 *
 * Resolved seams (from source, 2026-07-04):
 *  - /api/agent-plan returns { text: <json-string> }; parseAgentResponse decodes
 *    that inner JSON: { reasoning, commands[], message } (+ per-command rationale).
 *  - agent key gate: opts.apiKey() reads localStorage 'sailor:Sailor.AI.AnthropicApiKey'.
 *  - proposal card's primary buttons are "Keep all" / "Keep & Run" (a per-row
 *    check button has title "Keep" — assert on the card-level labels only).
 *  - bar: the one prompt, a textbox named "Ask Sailor" (SailorPrompt).
 *  - We use frontend-only STUDIO nodeTypes (GradientStudio/ShaderStudio): they
 *    are synthesized into the agent catalog from AGENT_CAPABILITIES regardless
 *    of /object_info, so applyCanvasCommand accepts them deterministically. A
 *    backend generator (GenerateImageNode) depends on /object_info being present.
 *  - CATALOG RACE: the agent's snapshot catalog is empty until /object_info
 *    loads; an instant submit gets every addNode rejected. A real user's typing
 *    delay masks this — the test settles for it explicitly before submitting.
 */
function planText(commands: unknown[], message = ''): string {
  return JSON.stringify({ reasoning: '', commands, message })
}

async function seedAgentKey(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-fastlane') } catch {}
  })
}

/** The prompt bar, ready and past the /object_info catalog-load race. */
async function readyBar(page: Page) {
  const bar = page.getByRole('textbox', { name: 'Ask Sailor' })
  await bar.waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(5_000) // let /object_info populate the agent catalog
  return bar
}

test.describe('Agent fast-lane', () => {
  test.beforeEach(async ({ page }) => {
    await seedAgentKey(page)
    await waitForBackend(page)
    // Stage 3: every prompt request is routed first. Mock it (no model calls in tests).
    await page.route('**/api/prompt-route', r => r.fulfill({ json: { kind: 'plan', followUps: [], credits: null } }))
    await openBlankWorkflow(page)
  })

  test('single-node plan auto-places with no proposal card, nothing running', async ({ page }) => {
    await page.route('**/api/agent-plan', async (route) => {
      await route.fulfill({ json: { text: planText([
        { op: 'addNode', args: { nodeType: 'GradientStudio', id: '$new1' } },
      ]) } })
    })

    const bar = await readyBar(page)
    const before = await page.locator('.vue-flow__node').count()
    await bar.fill('a soft blue to purple gradient')
    await bar.press('Enter')

    // The node was placed (empirical timing check — commit after an immediate
    // preview must actually promote the ghost).
    await expect.poll(async () => page.locator('.vue-flow__node').count(), { timeout: 15_000 }).toBe(before + 1)
    // No proposal card: the card-level Keep affordances are absent.
    await expect(page.getByRole('button', { name: /Keep all|Keep & Run/ })).toHaveCount(0)
    // One-line confirmation shown.
    await expect(page.getByText(/press Run when you're ready/i)).toBeVisible()
    // Nothing running — the header run pill stays at 0.
    await expect(page.getByText(/0 running/)).toBeVisible()
  })

  test('multi-command plan still shows the proposal card (regression guard)', async ({ page }) => {
    await page.route('**/api/agent-plan', async (route) => {
      await route.fulfill({ json: { text: planText([
        { op: 'addNode', args: { nodeType: 'GradientStudio', id: '$new1' } },
        { op: 'addNode', args: { nodeType: 'ShaderStudio', id: '$new2' } },
      ]) } })
    })

    const bar = await readyBar(page)
    await bar.fill('a gradient and a shader')
    await bar.press('Enter')

    // Proposal card appears as today — the fast lane must NOT swallow multi-command plans.
    // (Stage 3: the changes card above the prompt — Approve / Approve and run.)
    await expect(page.getByTestId('prompt-changes')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  })
})
