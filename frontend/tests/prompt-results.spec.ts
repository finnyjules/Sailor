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

/** A run of the Variations loop was queued, as the layout announces it. */
const queued = (page: Page, nodeId: string | null, ids: string[]) => page.evaluate(({ nodeId, ids }) => {
  for (const promptId of ids) window.dispatchEvent(new CustomEvent('sailor:variationsQueued', { detail: { nodeId, promptId } }))
}, { nodeId, ids })
/** The loop finished QUEUEING — the layout fires this right after the last run
 *  is queued, before any take has rendered. */
const loopDone = (page: Page, nodeId: string | null, ids: string[]) => page.evaluate(({ nodeId, ids }) =>
  window.dispatchEvent(new CustomEvent('sailor:variationsDone', { detail: { nodeId, queued: ids.length, cancelled: false, promptIds: ids } })), { nodeId, ids })

// Defense in depth for the real-run guard below (it rests on a function name):
// any POST that would queue or start a run fails the test instead of running.
// Stop's targeted interrupts are recorded, never sent.
const RUN_POST = /\/(prompt|api\/runs?|api\/runner)(\/[^?]*)?(\?|$)/
const STOP_POST = /\/(queue|interrupt)(\?|$)/
async function guardRealRuns(page: Page) {
  const leaked: string[] = []
  const stopped: { url: string; body: any }[] = []
  await page.route(url => RUN_POST.test(url.pathname) || STOP_POST.test(url.pathname), async (r) => {
    const req = r.request()
    if (req.method() !== 'POST') return r.fallback()
    const path = new URL(req.url()).pathname
    if (STOP_POST.test(path)) { stopped.push({ url: path, body: req.postDataJSON() }); return r.fulfill({ json: {} }) }
    leaked.push(path)
    return r.abort()
  })
  return { leaked, stopped }
}

/** The node's box ends above the prompt stack (its open card included). */
async function clearOfPrompt(page: Page, node: Locator) {
  const n = await node.boundingBox()
  const stack = await page.getByTestId('canvas-bottom-bar-stack').boundingBox()
  return !!n && !!stack && n.y + n.height <= stack.y
}

const ghostLabel = (page: Page) => page.locator('.vue-flow__node.agent-ghost').first()
  .evaluate(el => getComputedStyle(el, '::before').content)

test.describe('Results on the work', () => {
  let guard: Awaited<ReturnType<typeof guardRealRuns>>
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
    guard = await guardRealRuns(page)
    await waitForBackend(page)
    await openBlankWorkflow(page)
    await bareCanvas(page)
  })

  test.afterEach(() => {
    expect(guard.leaked, 'a run was queued for real').toEqual([])
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

  test('new effects with no shader effect node selected point to one plainly, and call no planner', async ({ page }) => {
    await mockRouter(page, () => ({ kind: 'new-effect' }))
    let planned = 0
    let written = 0
    await page.route('**/api/agent-plan', async (r) => { planned++; await r.fulfill({ json: { text: planText([]) } }) })
    // Nothing may write effects here; every model route is mocked regardless.
    await page.route('**/api/shader-gen', async (r) => { written++; await r.fulfill({ status: 500, json: {} }) })
    await page.route('**/api/my-effects**', r => r.fulfill({ json: { effects: [] } }))
    await prompt(page).fill('make it rain on a window')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-answer')).toContainText('New effects are made on a shader effect. Select a shader effect node, or open the Shader studio.')
    expect(planned).toBe(0)
    expect(written).toBe(0)
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
    // The row names the node the way its card does, never its type.
    await expect(page.getByTestId('prompt-changes')).not.toContainText('GradientStudio')
    await expect(node).toHaveClass(/agent-removal/)
    await expect.poll(() => clearOfPrompt(page, node)).toBe(true)
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

  test('Variations: three takes above the prompt; the node glows and previews each; a click keeps; ⌘Z puts it back; nothing moves', async ({ page }) => {
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
    // Out of the way: the view pans, and the strip must not slide under a resting pointer.
    await page.mouse.move(5, 5)
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible()
    await expect(strip.getByTestId('prompt-takes-target')).not.toBeEmpty()
    await expect(strip.locator('[data-testid="prompt-take-tile"][data-state="pending"]')).toHaveCount(3)
    await expect(node).toHaveClass(/agent-takes-target/)
    await expect(page.getByText('Making three takes of')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__variations)).toEqual([{ nodeId, count: 3 }])

    // The real order: all three runs are queued and the loop reports done
    // before any take has rendered. The strip keeps working until they land.
    await queued(page, nodeId, ['p1', 'p2', 'p3'])
    await loopDone(page, nodeId, ['p1', 'p2', 'p3'])
    await expect(page.getByText('Making three takes of')).toBeVisible()
    await expect(strip.locator('[data-testid="prompt-take-tile"][data-state="pending"]')).toHaveCount(3)

    const fills = ['#a11', '#1a1', '#11a']
    const takes = [T0]
    for (let i = 0; i < 3; i++) {
      const t = { id: `t${i + 1}`, createdAt: 2 + i, promptId: `p${i + 1}`, images: [svg(fills[i]!)] }
      takes.push(t)
      await page.evaluate(({ takes, t }) => window.dispatchEvent(new CustomEvent('sailor:test:setNodeData', {
        detail: { match: 'Image', patch: { takes, activeTakeId: t.id, images: t.images } },
      })), { takes: [...takes], t })
      // The node stays on its version while takes land (its active take, not just a thumbnail).
      await expect(node.locator('.ring-action img').first()).toHaveAttribute('src', /%23777/)
    }
    await expect(strip).toContainText('Three takes · Hover to preview, click to keep')
    // The node sits clear of the whole prompt stack, strip included.
    await expect.poll(() => clearOfPrompt(page, node)).toBe(true)
    await shot(page, 'takes')
    await expect(prompt(page)).toBeVisible() // no longer working

    const tiles = strip.getByTestId('prompt-take-tile')
    await tiles.nth(1).getByRole('button', { name: 'Take 2' }).hover()
    await expect(node.locator(`img[src*="${encodeURIComponent('#1a1')}"]`).first()).toBeVisible()
    await page.mouse.move(5, 5) // leave the strip
    await expect(node.locator(`img[src*="${encodeURIComponent('#777')}"]`).first()).toBeVisible()

    await expect(tiles.getByRole('button', { name: 'Keep' })).toHaveCount(0) // no separate Keep
    await tiles.nth(2).getByRole('button', { name: 'Take 3' }).hover()
    await tiles.nth(2).getByRole('button', { name: 'Take 3' }).click() // the click keeps it
    await expect(strip).toHaveCount(0)
    await page.mouse.move(5, 5)
    await expect(node.locator(`img[src*="${encodeURIComponent('#11a')}"]`).first()).toBeVisible()
    await expect(node).not.toHaveClass(/agent-takes-target/)
    expect(before).toMatch(/translate/)
    expect(await flowPos()).toBe(before)

    // ⌘Z: one step back to the version the node had before the keep (hovers recorded nothing).
    await page.keyboard.press('ControlOrMeta+z')
    await expect(node.locator(`img[src*="${encodeURIComponent('#777')}"]`).first()).toBeVisible()
    await expect(node).not.toHaveClass(/agent-takes-target/)
    // The takes that came back are still the node's (they were paid for): redo brings the kept one.
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(node.locator(`img[src*="${encodeURIComponent('#11a')}"]`).first()).toBeVisible()
  })

  /** A node with three takes landed in an open strip (the Variations flow above, in brief). */
  async function landedTakes(page: Page) {
    const T0 = { id: 't0', createdAt: 1, promptId: 'p0', images: [svg('#777')] }
    await page.evaluate(d => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: d })),
      { nodeType: 'Image', dataOverrides: { images: T0.images, takes: [T0], activeTakeId: 't0' } })
    const node = page.locator('.vue-flow__node-artifact-image')
    await expect(node).toBeVisible()
    // Let the added node be recorded as a step of its own before the strip opens.
    await page.waitForTimeout(600)
    const nodeId = await node.getAttribute('data-id')
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'tweak', nodeId: id, fromMenu: true } })), nodeId)
    await page.mouse.move(5, 5)
    await queued(page, nodeId, ['p1', 'p2', 'p3'])
    await loopDone(page, nodeId, ['p1', 'p2', 'p3'])
    const takes = [T0]
    for (const [i, fill] of ['#a11', '#1a1', '#11a'].entries()) {
      const t = { id: `t${i + 1}`, createdAt: 2 + i, promptId: `p${i + 1}`, images: [svg(fill)] }
      takes.push(t)
      await page.evaluate(({ takes, t }) => window.dispatchEvent(new CustomEvent('sailor:test:setNodeData', {
        detail: { match: 'Image', patch: { takes, activeTakeId: t.id, images: t.images } },
      })), { takes: [...takes], t })
    }
    const strip = page.getByTestId('prompt-takes')
    await expect(strip.locator('[data-testid="prompt-take-tile"][data-state="ready"]')).toHaveCount(3)
    return { node, strip, tiles: strip.getByTestId('prompt-take-tile') }
  }
  const shows = (node: Locator, fill: string) => node.locator(`img[src*="${encodeURIComponent(fill)}"]`).first()

  test('Enter on a focused take keeps it; ⌘Z is one step back, however many takes were previewed', async ({ page }) => {
    const { node, strip, tiles } = await landedTakes(page)
    await tiles.nth(1).getByRole('button', { name: 'Take 2' }).hover()
    await tiles.nth(2).getByRole('button', { name: 'Take 3' }).hover()
    await page.mouse.move(5, 5)
    await tiles.nth(0).getByRole('button', { name: 'Take 1' }).focus() // focus previews
    await expect(shows(node, '#a11')).toBeVisible()
    await expect(strip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(strip).toHaveCount(0)
    await expect(shows(node, '#a11')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(shows(node, '#777')).toBeVisible()
  })

  test('Current keeps what was there: a click on it closes the strip with the node as it was', async ({ page }) => {
    const { node, strip, tiles } = await landedTakes(page)
    await tiles.nth(1).getByRole('button', { name: 'Take 2' }).hover()
    await expect(shows(node, '#1a1')).toBeVisible()
    await strip.getByTestId('prompt-take-current').click()
    await expect(strip).toHaveCount(0)
    await expect(shows(node, '#777')).toBeVisible()
  })

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true })
    test('the first tap previews a take, a second tap on it keeps it', async ({ page }) => {
      const { node, strip, tiles } = await landedTakes(page)
      await tiles.nth(1).getByRole('button', { name: 'Take 2' }).tap()
      await expect(strip).toBeVisible()
      await expect(shows(node, '#1a1')).toBeVisible()
      await expect(strip.getByTestId('prompt-takes-hint')).toHaveText('Tap to preview, tap again to keep')
      await tiles.nth(1).getByRole('button', { name: 'Take 2' }).tap()
      await expect(strip).toHaveCount(0)
      await expect(shows(node, '#1a1')).toBeVisible()
    })
  })

  test('Stop after the loop reported done interrupts the set’s runs still rendering; a late take never becomes active', async ({ page }) => {
    const T0 = { id: 't0', createdAt: 1, promptId: 'p0', images: [svg('#777')] }
    await page.evaluate(d => window.dispatchEvent(new CustomEvent('sailor:addNode', { detail: d })),
      { nodeType: 'Image', dataOverrides: { images: T0.images, takes: [T0], activeTakeId: 't0' } })
    const node = page.locator('.vue-flow__node-artifact-image')
    await expect(node).toBeVisible()
    const nodeId = await node.getAttribute('data-id')
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('sailor:promptKind', { detail: { kind: 'tweak', nodeId: id, fromMenu: true } })), nodeId)
    await queued(page, nodeId, ['p1', 'p2', 'p3'])
    await loopDone(page, nodeId, ['p1', 'p2', 'p3'])
    const t1 = { id: 't1', createdAt: 2, promptId: 'p1', images: [svg('#a11')] }
    await page.evaluate(({ takes, t }) => window.dispatchEvent(new CustomEvent('sailor:test:setNodeData', {
      detail: { match: 'Image', patch: { takes, activeTakeId: t.id, images: t.images } },
    })), { takes: [T0, t1], t: t1 })
    await expect(page.locator('[data-testid="prompt-take-tile"][data-state="ready"]')).toHaveCount(1)
    await page.getByTestId('prompt-stop').click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__stops)).toEqual([{ nodeId, promptIds: ['p2', 'p3'], cancelLoop: false }])
    // Only those two runs are stopped (when the engine is up to hear it).
    for (const s of guard.stopped) {
      if (s.url === '/interrupt') expect(['p2', 'p3']).toContain(s.body?.prompt_id)
      else expect(s.body).toEqual({ delete: ['p2', 'p3'] })
    }
    await expect(node.locator(`img[src*="${encodeURIComponent('#777')}"]`).first()).toBeVisible()
    await expect(node).not.toHaveClass(/agent-takes-target/)

    // p2 finishes anyway: its take goes into the node's history, but the node stays on its version.
    await page.evaluate(id => window.postMessage({
      type: 'sailor-bridge', v: 2, direct: true, event: 'executed', node_id: id, prompt_id: 'p2',
      output: { images: [{ filename: 'late-take.png', subfolder: '', type: 'output' }] },
    }, window.location.origin), nodeId)
    // It lands in the node's takes (its thumbnail shows in the node's take row)…
    const lateThumb = node.locator('img[src*="late-take"]')
    await expect(lateThumb).toHaveCount(1)
    // …but the active take is still the one the strip closed on.
    await expect(lateThumb.locator('xpath=..')).not.toHaveClass(/ring-action/)
    await expect(node.locator('.ring-action img').first()).toHaveAttribute('src', /%23777/)
  })
})
