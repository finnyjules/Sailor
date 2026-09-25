import { expect, test, type Locator, type Page } from '@playwright/test'
import { dropNode, openBlankWorkflow, waitForBackend } from './_helpers'

/**
 * AI in Sailor stage 3 (spec §3): results land on the work. Both model routes
 * (/api/prompt-route, /api/agent-plan) are mocked, and Variations is intercepted
 * before the layout can queue a run — takes "arrive" through the dev-only
 * sailor:test:setNodeData hook, written the way appendTake writes them. So this
 * spec spends nothing and needs no engine run. Real-mouse checks are separate.
 */

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Ask Sailor' })
const planText = (commands: unknown[], message = '') => JSON.stringify({ reasoning: '', commands, message })
const svg = (fill: string) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='40'><rect width='64' height='40' fill='${encodeURIComponent(fill)}'/></svg>`

async function mockRouter(page: Page, pick: (body: any) => { kind: string; followUps?: string[] }) {
  const calls: any[] = []
  await page.route('**/api/prompt-route', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const out = pick(body)
    await r.fulfill({ json: { kind: out.kind, followUps: out.followUps ?? [], credits: null } })
  })
  return calls
}

/** Past the start modal, a late starter Frame (it steals selection), and the
 *  /object_info catalog race — as node-toolbar.spec.ts and agent-fastlane.spec.ts do. */
async function bareCanvas(page: Page) {
  const heading = page.getByRole('heading', { name: 'What do you want to make?' })
  if (await heading.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await expect(heading).toHaveCount(0)
  }
  const frame = page.locator('.vue-flow__node-artifact-frame')
  if (await frame.first().waitFor({ state: 'attached', timeout: 3_000 }).then(() => true, () => false)) {
    await frame.first().click()
    await page.keyboard.press('Delete')
  }
  await expect(page.locator('.vue-flow__node')).toHaveCount(0)
  await prompt(page).waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(5_000)
}

async function selectNode(page: Page, node: Locator) {
  const bb = (await node.boundingBox())!
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
}

/** Review screenshots, only when STAGE3_SHOTS names a folder (never in a normal run). */
async function shot(page: Page, name: string) {
  const dir = process.env.STAGE3_SHOTS
  if (dir) await page.screenshot({ path: `${dir}/stage3-e2e-${name}.png` })
}

const ghostLabel = (page: Page) => page.locator('.vue-flow__node.agent-ghost').first()
  .evaluate(el => getComputedStyle(el, '::before').content)

test.describe('Results on the work', () => {
  // The setup alone (two reloads, the /object_info catalog, a starter Frame) can
  // take most of the default minute on a loaded machine.
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-results') } catch {}
      // Record Variations, and keep the layout's handler (default.vue
      // `handleRunVariations`, the only one that queues a run) from ever being
      // registered. The prompt's own `sailor:runVariations` listener must still
      // hear it — it tracks the running loop and is what Stop checks — so the
      // event can't simply be stopped. Dev keeps function names.
      ;(window as any).__variations = []
      ;(window as any).__stops = []
      const add = window.addEventListener.bind(window)
      window.addEventListener = ((type: string, listener: any, opts?: any) => {
        if (type === 'sailor:runVariations' && listener?.name === 'handleRunVariations') return
        return add(type, listener, opts)
      }) as typeof window.addEventListener
      add('sailor:runVariations', (e: Event) => { (window as any).__variations.push((e as CustomEvent).detail) })
      add('sailor:stopVariations', (e: Event) => { (window as any).__stops.push((e as CustomEvent).detail) })
    })
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await bareCanvas(page)
  })

  test('a question gets an answer card; a follow-up chip runs as a new request', async ({ page }) => {
    const calls = await mockRouter(page, b => (b.request === 'what does this graph do?' ? { kind: 'answer', followUps: ['What should I try next?'] } : { kind: 'answer' }))
    const asked: string[] = []
    await page.route('**/api/agent-plan', async (r) => {
      asked.push(String(r.request().postDataJSON()?.prompt ?? ''))
      await r.fulfill({ json: { text: planText([], 'It holds nothing yet.') } })
    })
    await prompt(page).fill('what does this graph do?')
    await prompt(page).press('Enter')
    const card = page.getByTestId('prompt-answer')
    await expect(card).toContainText('Answer')
    await expect(card).toContainText('It holds nothing yet.')
    await shot(page, 'answer')
    await card.getByRole('button', { name: 'What should I try next?' }).click()
    await expect.poll(() => calls.length).toBe(2)
    expect(calls[1].request).toBe('What should I try next?')
    await expect.poll(() => asked.length).toBe(2)
    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toHaveCount(0)
  })

  test('a kind with no canvas worker says so plainly and calls no planner', async ({ page }) => {
    await mockRouter(page, () => ({ kind: 'new-effect' }))
    let planned = 0
    await page.route('**/api/agent-plan', async (r) => { planned++; await r.fulfill({ json: { text: planText([]) } }) })
    await prompt(page).fill('make it rain on a window')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-answer')).toContainText('Making new effects isn’t available yet.')
    expect(planned).toBe(0)
  })

  test('proposed nodes show on the canvas with a Proposed pill; Reject removes them, Approve keeps them', async ({ page }) => {
    await mockRouter(page, () => ({ kind: 'plan' }))
    await page.route('**/api/agent-plan', r => r.fulfill({ json: { text: planText([
      { op: 'addNode', args: { nodeType: 'GradientStudio', id: '$new1' } },
      { op: 'addNode', args: { nodeType: 'TextureStudio', id: '$new2' } },
    ]) } }))
    await prompt(page).fill('add a gradient and a texture')
    await prompt(page).press('Enter')
    const changes = page.getByTestId('prompt-changes')
    await expect(changes).toContainText('2 changes to the graph · shown on the canvas')
    await expect(changes.getByTestId('prompt-change-row')).toHaveCount(2)
    await expect(page.locator('.vue-flow__node.agent-ghost')).toHaveCount(2)
    await expect.poll(() => ghostLabel(page)).toBe('"Proposed"')
    await changes.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(page.locator('.vue-flow__node')).toHaveCount(0)

    await prompt(page).fill('add a gradient and a texture')
    await prompt(page).press('Enter')
    await page.getByTestId('prompt-changes').getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.locator('.vue-flow__node')).toHaveCount(2)
    await expect(page.locator('.vue-flow__node.agent-ghost')).toHaveCount(0)
  })

  test('a proposed removal only marks the node until Approve', async ({ page }) => {
    await dropNode(page, 'GradientStudio')
    const node = page.locator('.vue-flow__node-gradient-studio')
    await expect(node).toBeVisible()
    const id = await node.getAttribute('data-id')
    await mockRouter(page, () => ({ kind: 'plan' }))
    await page.route('**/api/agent-plan', r => r.fulfill({ json: { text: planText([{ op: 'deleteNode', target: id }]) } }))
    await prompt(page).fill('remove the gradient')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-changes')).toContainText('(removed)')
    await expect(node).toHaveClass(/agent-removal/)
    await shot(page, 'removal')
    await page.getByTestId('prompt-changes').getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(node).toBeVisible()
    await expect(node).not.toHaveClass(/agent-removal/)

    await prompt(page).fill('remove the gradient')
    await prompt(page).press('Enter')
    await page.getByTestId('prompt-changes').getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.locator('.vue-flow__node-gradient-studio')).toHaveCount(0)
  })

  test('Tune… puts a Tune chip in the prompt and focuses it; sending skips the router; Esc clears the chip then leaves', async ({ page }) => {
    const calls = await mockRouter(page, () => ({ kind: 'plan' }))
    const asked: string[] = []
    await page.route('**/api/agent-plan', async (r) => { asked.push(String(r.request().postDataJSON()?.prompt ?? '')); await r.fulfill({ json: { text: planText([], 'ok') } }) })
    await dropNode(page, 'GradientStudio')
    const node = page.locator('.vue-flow__node-gradient-studio')
    await expect(node).toBeVisible()
    await selectNode(page, node)
    const bar = page.getByRole('toolbar', { name: 'Node actions' })
    await bar.getByRole('button', { name: 'Edit' }).click()
    await page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: /Tune…/ }).click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Tune')
    await expect(prompt(page)).toBeFocused()
    await prompt(page).fill('more orange')
    await prompt(page).press('Enter')
    await expect.poll(() => asked.length).toBe(1)
    expect(calls.length).toBe(0) // a mode chip decides the kind without the router
    await expect(page.getByTestId('prompt-mode-chip')).toHaveCount(0)

    await selectNode(page, node)
    await bar.getByRole('button', { name: 'Edit' }).click()
    await page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: /Tune…/ }).click()
    await expect(prompt(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('prompt-mode-chip')).toHaveCount(0)
    await expect(prompt(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(prompt(page)).not.toBeFocused()
  })

  test('Variations: three takes above the prompt; the node glows and previews each; Keep applies; nothing moves', async ({ page }) => {
    const T0 = { id: 't0', createdAt: 1, promptId: 'p0', images: [svg('#777')] }
    await page.evaluate(d => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: d })),
      { nodeType: 'Image', dataOverrides: { images: T0.images, takes: [T0], activeTakeId: 't0' } })
    const node = page.locator('.vue-flow__node-artifact-image')
    await expect(node).toBeVisible()
    await selectNode(page, node)
    // Flow-space position (the node's own transform), not its screen box: the
    // viewport may pan the node into view when the first take lands (ruling 11).
    const flowPos = () => node.evaluate(el => (el as HTMLElement).style.transform)
    const before = await flowPos()
    const nodeId = await node.getAttribute('data-id')

    // The same event Develop ▾ → Variations fires (the menu is trusted; ruling 17).
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'tweak', nodeId: id, fromMenu: true } })), nodeId)
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible()
    await expect(strip.getByTestId('prompt-takes-target')).not.toBeEmpty()
    await expect(strip.locator('[data-testid="prompt-take-tile"][data-state="pending"]')).toHaveCount(3)
    await expect(node).toHaveClass(/agent-takes-target/)
    await expect(page.getByText('Making three takes of')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__variations)).toEqual([{ nodeId, count: 3 }])

    const fills = ['#a11', '#1a1', '#11a']
    const takes = [T0]
    for (let i = 0; i < 3; i++) {
      const t = { id: `t${i + 1}`, createdAt: 2 + i, promptId: `p${i + 1}`, images: [svg(fills[i]!)] }
      takes.push(t)
      await page.evaluate(({ takes, t }) => window.dispatchEvent(new CustomEvent('sailor:test:setNodeData', {
        detail: { match: 'Image', patch: { takes, activeTakeId: t.id, images: t.images } },
      })), { takes: [...takes], t })
      // The node stays on its version while takes land.
      await expect(node.locator(`img[src*="${encodeURIComponent('#777')}"]`).first()).toBeVisible()
    }
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('sailor:variationsDone', { detail: { nodeId: id, queued: 3, cancelled: false } })), nodeId)
    await expect(strip).toContainText('Three takes · hover to preview, Keep one')
    await shot(page, 'takes')
    await expect(prompt(page)).toBeVisible() // no longer working

    const tiles = strip.getByTestId('prompt-take-tile')
    await tiles.nth(1).getByRole('button', { name: 'Preview take 2' }).hover()
    await expect(node.locator(`img[src*="${encodeURIComponent('#1a1')}"]`).first()).toBeVisible()
    await page.mouse.move(5, 5) // leave the strip
    await expect(node.locator(`img[src*="${encodeURIComponent('#777')}"]`).first()).toBeVisible()

    await tiles.nth(2).getByRole('button', { name: 'Preview take 3' }).hover()
    await tiles.nth(2).getByRole('button', { name: 'Keep' }).click()
    await expect(strip).toHaveCount(0)
    await page.mouse.move(5, 5)
    await expect(node.locator(`img[src*="${encodeURIComponent('#11a')}"]`).first()).toBeVisible()
    await expect(node).not.toHaveClass(/agent-takes-target/)
    expect(before).toMatch(/translate/)
    expect(await flowPos()).toBe(before)
  })

  test('Stop while takes arrive cancels Variations, clears the strip and returns the node to its version', async ({ page }) => {
    const T0 = { id: 't0', createdAt: 1, promptId: 'p0', images: [svg('#777')] }
    await page.evaluate(d => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: d })),
      { nodeType: 'Image', dataOverrides: { images: T0.images, takes: [T0], activeTakeId: 't0' } })
    const node = page.locator('.vue-flow__node-artifact-image')
    await expect(node).toBeVisible()
    const nodeId = await node.getAttribute('data-id')
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'tweak', nodeId: id, fromMenu: true } })), nodeId)
    const t1 = { id: 't1', createdAt: 2, promptId: 'p1', images: [svg('#a11')] }
    await page.evaluate(({ takes, t }) => window.dispatchEvent(new CustomEvent('sailor:test:setNodeData', {
      detail: { match: 'Image', patch: { takes, activeTakeId: t.id, images: t.images } },
    })), { takes: [T0, t1], t: t1 })
    await expect(page.locator('[data-testid="prompt-take-tile"][data-state="ready"]')).toHaveCount(1)
    await page.getByTestId('prompt-stop').click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__stops)).toEqual([{ nodeId }])
    await expect(node.locator(`img[src*="${encodeURIComponent('#777')}"]`).first()).toBeVisible()
    await expect(node).not.toHaveClass(/agent-takes-target/)
  })
})
