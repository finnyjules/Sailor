import { expect, test, type Page, type Route } from '@playwright/test'
import { dropNode, openBlankWorkflow, openStudio, waitForBackend } from './_helpers'
import { SPIKE_TAKES } from '../app/lib/shadergen/__eval__/spikeTakes'

/**
 * AI in Sailor stage 5: shader generation and My effects, end to end, spending
 * nothing. /api/shader-gen answers with the spike's hand-written takes, /api/my-effects
 * is an in-memory store, and /api/prompt-route is mocked. The takes still go through
 * the REAL engine checks and the REAL renderer in the browser. Anything else that would
 * reach a model or queue a run is aborted and fails the test (guardModelRoutes).
 * Hover preview by a real mouse is owed separately (plan Task 14).
 *
 * Which spike takes: in headless Chromium's software GL, `rain[1]` ("Running streaks")
 * and `rain[2]` ("Fogged glass") fail the render checks (a probe of all 24, 2026-09-25),
 * so each slot answers with takes that passed there. Even those can fail a run: the
 * "heavy" check times frames, and a loaded machine makes it noisy. So a slot's second
 * call (the engine asks once more after a failed check) gets a different take, and the
 * assertions lean only on "a take lands and can be kept", never on a given slot landing.
 */

test.setTimeout(180_000)

const S = SPIKE_TAKES
/** Per slot (take angle), the reply to its 1st, 2nd, … call. */
const TAKES = [
  [S.rain![0]!, S.lava![0]!, S.popart![0]!],
  [S.rain![3]!, S.lava![1]!, S.popart![1]!],
  [S.oil![1]!, S.lava![2]!, S.ink![1]!],
]
const PRICE = '~$0.24–0.42'

/** Non-GET calls to a route that spends model money, queues an engine run, or writes My effects. */
const GUARDED = /^\/(prompt|api\/(prompt-route|vibe|vibe-review|vibe-recipes|vibe-pick|agent-plan|agent-review|shader-gen|my-effects|pipeline-suggest|font-suggest|copy-assist|image-search|style-profile|frame\/animate|scene3d\/(gen-[a-z0-9-]+|restyle)|inpaint|krea|vector|depth|lipsync|cloud-train|voice-clone|runs)(\/.*)?)$/

/** Registered FIRST so every specific mock below takes precedence (Playwright runs the most
 *  recently registered matching handler first). The engine's visual review answers 503, which
 *  it degrades on (a failed review keeps every take).
 *  GETs pass through on purpose, except /api/my-effects: a GET on the other guarded paths is a
 *  read (a run's status, a saved recipe list) that spends nothing, and the app makes some on load.
 *  An unmocked My effects read is the one GET that must not reach the dev server: its real
 *  route isn't there until the owed restart, and it would read the developer's own library. */
async function guardModelRoutes(page: Page) {
  const leaked: string[] = []
  await page.route(url => GUARDED.test(url.pathname), async (r) => {
    const req = r.request()
    // An unmocked My effects read would reach the real (404ing, until the owed restart) route.
    if (req.method() === 'GET' && !new URL(req.url()).pathname.startsWith('/api/my-effects')) return r.fallback()
    leaked.push(`${req.method()} ${new URL(req.url()).pathname}`)
    return r.abort()
  })
  for (const p of ['vibe-review', 'agent-review', 'vibe-recipes', 'vibe-pick']) {
    await page.route(`**/api/${p}`, r => r.fulfill({ status: 503, json: { message: 'mocked: unavailable' } }))
  }
  return leaked
}

/** A late reply after the test (or a Stop) has ended is harmless: swallow it. */
const settle = (r: Route, reply: Parameters<Route['fulfill']>[0]) => r.fulfill(reply).catch(() => {})

const ANGLE = /Take (\d):/
/** /api/shader-gen, shaped like the real route: `{ text, usage, stop_reason, credits }`.
 *  Each call answers its take angle's slot after that slot's delay. */
async function mockShaderGen(page: Page, delays = [300, 900, 1500]) {
  const calls: any[] = []
  const perSlot = [0, 0, 0]
  await page.route('**/api/shader-gen', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const slot = (Number(ANGLE.exec(String(body.prompt ?? ''))?.[1] ?? 1) - 1) % TAKES.length
    // Each call gets a take of its own: a slot that has used up its replies gets a reply that
    // isn't a take (the engine fails that slot), never an earlier take again.
    const take = TAKES[slot]![perSlot[slot]!++]
    await new Promise(res => setTimeout(res, delays[slot] ?? 0))
    await settle(r, { json: { text: take ? JSON.stringify(take) : 'No more takes in this mock.', usage: { input_tokens: 5000, output_tokens: 3000 }, stop_reason: 'end_turn', credits: null } })
  })
  return calls
}

/** /api/my-effects as an in-memory store: GET list, GET/PUT/PATCH/DELETE one. */
async function mockMyEffects(page: Page) {
  const store = new Map<string, any>()
  await page.route('**/api/my-effects**', async (r) => {
    const url = new URL(r.request().url())
    const id = decodeURIComponent(url.pathname.split('/').pop()!)
    const m = r.request().method()
    if (m === 'GET' && url.pathname.endsWith('/my-effects')) return settle(r, { json: { effects: [...store.values()] } })
    if (m === 'PUT') { const rec = { ...r.request().postDataJSON(), updatedAt: new Date().toISOString() }; store.set(id, rec); return settle(r, { json: rec }) }
    if (m === 'PATCH') { const rec = { ...store.get(id), name: r.request().postDataJSON().name }; store.set(id, rec); return settle(r, { json: rec }) }
    if (m === 'DELETE') { store.delete(id); return settle(r, { json: { ok: true, id } }) }
    return settle(r, { json: store.get(id) ?? {}, status: store.has(id) ? 200 : 404 })
  })
  return store
}

async function mockRouter(page: Page, kind = 'new-effect') {
  const calls: any[] = []
  await page.route('**/api/prompt-route', async (r) => { calls.push(r.request().postDataJSON()); await settle(r, { json: { kind, followUps: [], credits: null } }) })
  return calls
}

async function seedKey(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-shadergen') } catch {} })
}

const openShaderStudio = (page: Page) => openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
const prompt = (page: Page) => page.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })
const tileIn = (page: Page, state: 'ready' | 'pending' | 'failed') => page.locator(`[data-testid="prompt-take-tile"][data-state="${state}"]`)

test.describe('shader generation (stage 5)', () => {
  let leaked: string[] = []
  test.beforeEach(async ({ page }) => {
    leaked = await guardModelRoutes(page)
    await seedKey(page)
  })
  test.afterEach(() => {
    expect(leaked, 'a model or My effects route was called without a mock').toEqual([])
  })

  test('Shader studio: Remix shows its price, effects land one by one, hover previews, Keep saves to My effects', async ({ page }) => {
    const gen = await mockShaderGen(page); const store = await mockMyEffects(page); const routed = await mockRouter(page)
    await openShaderStudio(page)
    await page.getByTestId('studio-inspector-head').locator('[data-testid="studio-action-row"][data-action-id="remix"]').click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
    await expect(page.getByTestId('studio-prompt').getByTestId('prompt-note')).toHaveText(PRICE)
    await prompt(page).fill('rain on a window'); await prompt(page).press('Enter')
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    const tiles = strip.getByTestId('prompt-take-tile')
    await expect(tiles).toHaveCount(3)
    // The 300 ms slot settles while the 1500 ms one is still working: they arrive one by one.
    await expect(tiles.nth(0)).not.toHaveAttribute('data-state', 'pending', { timeout: 20_000 })
    expect(await tiles.nth(2).getAttribute('data-state')).toBe('pending')
    await expect(tileIn(page, 'pending')).toHaveCount(0, { timeout: 60_000 })
    expect(await tileIn(page, 'ready').count()).toBeGreaterThanOrEqual(1)
    expect(routed).toHaveLength(0) // the chip decided the kind
    // "Three more" is another paid set: its price shows on the button before the click.
    await expect(strip.getByRole('button', { name: /^Three more/ })).toHaveText(`Three more · ${PRICE}`)
    // While the set is open, nothing on screen is exported or put on the canvas (a take is a draft).
    await page.getByRole('button', { name: /Render on canvas/ }).click()
    await expect(page.getByRole('button', { name: 'As image', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'As video', exact: true })).toBeDisabled()
    const downloads = page.getByRole('button', { name: /^Download\b/ }).first()
    await downloads.click()
    await expect(page.getByRole('button', { name: 'Export embed', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Download PNG', exact: true })).toBeDisabled()
    await downloads.click() // closes the menu (Escape would close the studio)
    // The shader-generation setting: no tier or model is sent, and at most one picture per call.
    expect(gen.length).toBeGreaterThanOrEqual(3)
    expect(gen.every(b => !('tier' in b) && !('model' in b))).toBe(true)
    expect(gen.every(b => (b.images?.length ?? 0) <= 1)).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('rain on a window'))).toBe(true)
    // Hovering a ready take previews it on the layer: the inspector names the take's effect.
    const states = await tiles.evaluateAll(els => els.map(e => e.getAttribute('data-state')))
    const slot = states.indexOf('ready')
    const first = tiles.nth(slot)
    await first.getByRole('button', { name: /Preview take/ }).hover()
    const names = TAKES[slot]!.map(t => t.name)
    await expect(page.getByTestId('studio-inspector-head')).toContainText(new RegExp(names.join('|')))
    await first.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(page.getByTestId('prompt-answer')).toContainText('Saved to My effects as')
    await expect(strip).toHaveCount(0)
    expect(store.size).toBe(1)
    const saved = [...store.values()][0]
    expect(saved.id).toMatch(/^mine_[a-z0-9]{12}$/)
    expect(saved.versions).toHaveLength(1)
    await expect(page.getByTestId('my-effect-recipe')).toBeVisible()
    await expect(page.getByTestId('my-effect-version')).toHaveText(['v1'])
  })

  test('Stop mid-run clears partial takes and puts the layer stack back', async ({ page }) => {
    await mockShaderGen(page, [200, 20_000, 20_000]); await mockMyEffects(page); await mockRouter(page)
    await openShaderStudio(page)
    const layerRows = () => page.getByRole('button', { name: 'Toggle layer' }).count()
    const before = await layerRows()
    await page.getByTestId('studio-actions').getByTestId('studio-action-row').filter({ hasText: 'New layer from a description' }).click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    await prompt(page).fill('ink on paper'); await prompt(page).press('Enter')
    // Partial: the fast slot has settled (landed, or given up after its second try), the rest are working.
    const tiles = page.getByTestId('prompt-take-tile')
    await expect(tiles.nth(0)).not.toHaveAttribute('data-state', 'pending', { timeout: 20_000 })
    await expect(tileIn(page, 'pending')).toHaveCount(2)
    // Previewing the landed take puts it on a new layer at the end of the stack… (the fast
    // slot can give up on a loaded machine — see the header — and then there is nothing to preview).
    if (await tiles.nth(0).getAttribute('data-state') === 'ready') {
      await tiles.nth(0).getByRole('button', { name: /Preview take/ }).click()
      await expect.poll(layerRows).toBe(before + 1)
    } else {
      test.info().annotations.push({ type: 'note', description: 'the fast slot gave up; Stop checked without a preview' })
    }
    await page.getByTestId('prompt-stop').click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
    // …and Stop takes it back out.
    await expect.poll(layerRows).toBe(before)
  })

  test('the gallery: My effects section and chip, Make one sets the chip, Remix on a card', async ({ page }) => {
    await mockShaderGen(page); const store = await mockMyEffects(page); await mockRouter(page)
    // One My effect, in the store before the page loads.
    store.set('mine_aaaaaaaaaaaa', {
      id: 'mine_aaaaaaaaaaaa', name: 'Rain on glass', from: 'Water ripple', animated: true, generative: false,
      createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
      versions: [{ label: 'v1', body: S.rain![0]!.body, params: S.rain![0]!.params, values: {}, note: 'rain on a window', createdAt: '2026-09-25T00:00:00.000Z' }],
    })
    await openShaderStudio(page)
    const changeEffect = page.getByTestId('studio-inspector-head').getByRole('button', { name: 'Change effect' })
    await changeEffect.click()
    const gallery = page.getByTestId('effect-gallery')
    await expect(gallery).toBeVisible()
    await expect(gallery.getByText('My effects').first()).toBeVisible()
    // The card is the effect's newest version, under its own pinned id (Ruling #2).
    await expect(gallery.locator('[data-effect-id="mine_aaaaaaaaaaaa~v1"]')).toContainText('Rain on glass')
    await expect(gallery.locator('[data-effect-id="mine_aaaaaaaaaaaa~v1"]')).toContainText('My effect · from “Water ripple”')
    await expect(gallery.getByTestId('effect-gallery-make')).toContainText(PRICE)
    await gallery.getByTestId('effect-gallery-make').click()
    await expect(gallery).toHaveCount(0)
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    await changeEffect.click()
    // Remix sits over the card (a sibling of the card's button), shown on hover.
    const card = gallery.locator('[data-effect-id="water_ripple"]')
    const cardWrap = card.locator('xpath=../..')
    await card.hover()
    await cardWrap.getByTestId('effect-gallery-remix').click()
    await expect(gallery).toHaveCount(0)
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
  })

  test('canvas: a shader node offers Remix… and New effect… with the price, and takes preview on the node', async ({ page }) => {
    const gen = await mockShaderGen(page, [100, 200, 300]); await mockMyEffects(page); const routed = await mockRouter(page)
    await openBlankWorkflow(page); await waitForBackend(page)
    await dropNode(page, 'ShaderEffect')
    const node = page.locator('.vue-flow__node').last()
    await node.waitFor({ state: 'attached', timeout: 15_000 })
    await node.click()
    const develop = page.getByRole('toolbar', { name: 'Node actions' }).getByRole('button', { name: /Develop/ })
    const menu = page.getByRole('menu', { name: 'Develop' })
    // No effect picked yet: nothing to remix, so New effect… only; the chip says "Shader effect".
    await expect(page.getByTestId('prompt-selection-chip')).toContainText('Shader effect')
    await develop.click()
    await expect(menu.getByRole('menuitem', { name: /New effect…/ })).toContainText(`3 takes · ${PRICE}`)
    await expect(menu.getByRole('menuitem', { name: /Remix…/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    // Pick Water ripple on the node: its chip and the strip then name the node by that effect.
    // (The node's picker row sits under the prompt at this size, so it is clicked by event: this
    // is setup — picking an effect — not what the test is about.)
    await node.getByTestId('shader-effect-picker').dispatchEvent('click')
    const gallery = page.getByTestId('effect-gallery')
    await gallery.locator('[data-effect-id="water_ripple"]').click()
    await gallery.getByRole('button', { name: 'Use effect' }).click()
    await expect(gallery).toHaveCount(0)
    await node.click()
    const effectName = /^\s*Water ripple\s*$/i // the catalog's own name, whatever its case
    await expect(page.getByTestId('prompt-selection-chip')).toHaveText(effectName)
    await develop.click()
    await expect(menu.getByRole('menuitem', { name: /Remix…/ })).toContainText(`3 takes · ${PRICE}`)
    await menu.getByRole('menuitem', { name: /Remix…/ }).click()
    const box = page.getByRole('textbox', { name: 'Ask Sailor' })
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
    await box.fill('rain on a window')
    await box.press('Enter')
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('prompt-take-tile')).toHaveCount(3)
    await expect(tileIn(page, 'pending')).toHaveCount(0, { timeout: 60_000 })
    expect(await tileIn(page, 'ready').count()).toBeGreaterThanOrEqual(1)
    expect(routed).toHaveLength(0)
    expect(gen.length).toBeGreaterThanOrEqual(3)
    // The strip names its target by the node's own shown name: its chosen effect's.
    await expect(page.getByTestId('prompt-takes-target')).toHaveText(effectName)
  })

  test('a routed new effect with no chip shows the price in the working label', async ({ page }) => {
    await mockShaderGen(page, [3000, 3000, 3000]); await mockMyEffects(page); const routed = await mockRouter(page, 'new-effect')
    await openShaderStudio(page)
    await prompt(page).fill('make it rain'); await prompt(page).press('Enter')
    await expect(page.getByTestId('studio-prompt')).toContainText(`Working on “make it rain” · ${PRICE}`)
    expect(routed[0]).toMatchObject({ request: 'make it rain', host: 'studio' })
  })
})
