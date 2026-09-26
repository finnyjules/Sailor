import { expect, test, type Locator, type Page } from '@playwright/test'
import { openCompositor, openStudio } from './_helpers'
import { SPIKE_TAKES } from '../app/lib/shadergen/__eval__/spikeTakes'

/**
 * AI in Sailor stage 4: the one prompt in the studios, Frame and the template
 * editor. Every model route is mocked — nothing here reaches a model:
 *   - /api/prompt-route (the router), /api/vibe (the studio tune, in takes or as
 *     one patch), /api/agent-plan (Frame's and the template editor's planner);
 *   - the fire-and-forget reviews (/api/vibe-review, /api/agent-review) and the
 *     compose-and-pick pair (/api/vibe-recipes, /api/vibe-pick) answer 503, which
 *     every caller degrades on;
 *   - anything else that would reach a model or queue a run is aborted and fails
 *     the test in afterEach (guardModelRoutes).
 * Hover-to-preview feel and typing speed need the real-mouse pass (plan Task 13).
 */

test.setTimeout(180_000)

const prompt = (scope: Page | Locator) => scope.getByTestId('studio-prompt').getByRole('textbox', { name: 'Ask Sailor' })

/** Non-GET calls to a route that spends model money (or queues an engine run). */
const MODEL_ROUTE = /^\/(prompt|api\/(prompt-route|vibe|vibe-review|vibe-recipes|vibe-pick|agent-plan|agent-review|shader-gen|pipeline-suggest|font-suggest|copy-assist|image-search|style-profile|frame\/animate|scene3d\/(gen-[a-z0-9-]+|restyle)|inpaint|krea|vector|depth|lipsync|cloud-train|voice-clone|runs)(\/.*)?)$/

/** Registered FIRST so every specific mock below takes precedence (Playwright
 *  runs the most recently registered matching handler first). */
async function guardModelRoutes(page: Page) {
  const leaked: string[] = []
  await page.route(url => MODEL_ROUTE.test(url.pathname), async (r) => {
    const req = r.request()
    if (req.method() === 'GET') return r.fallback()
    leaked.push(`${req.method()} ${new URL(req.url()).pathname}`)
    return r.abort()
  })
  // The reviews and compose-and-pick: unavailable, which every caller degrades on.
  for (const p of ['vibe-review', 'agent-review', 'vibe-recipes', 'vibe-pick']) {
    await page.route(`**/api/${p}`, r => r.fulfill({ status: 503, json: { message: 'mocked: unavailable' } }))
  }
  return leaked
}

async function seedKey(page: Page) {
  await page.addInitScript(() => { try { localStorage.setItem('sailor:Sailor.AI.AnthropicApiKey', 'sk-ant-test-studio') } catch {} })
}

async function mockRouter(page: Page, kind: string, followUps: string[] = []) {
  const calls: any[] = []
  await page.route('**/api/prompt-route', async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ json: { kind, followUps, credits: null } }) })
  return calls
}

type Described = { path: string; kind: string; min?: number; max?: number; current: unknown }
/** /api/vibe: three takes when asked for `variants`, else one patch. Keys come
 *  from the request's own described controls (`path`, sliders only), so the
 *  answer is valid for whichever studio asked, and every value is away from
 *  the slider's current value (a no-op change is dropped as nothing). */
async function mockVibe(page: Page) {
  const calls: any[] = []
  await page.route('**/api/vibe', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const sliders = ((body.controls ?? []) as Described[])
      .filter(c => c.kind === 'slider' && typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min)
      .slice(0, 2)
    const at = (c: Described, f: number) => c.min! + (c.max! - c.min!) * f
    const far = (c: Described) => (Number(c.current) - c.min! > c.max! - Number(c.current) ? c.min! : c.max!)
    const take = (label: string, f: number) => ({ label, rationale: '', changes: sliders.map(c => ({ key: c.path, value: at(c, f) })) })
    if (body.variants) await r.fulfill({ json: { takes: [take('Soft', 0.1), take('Mid', 0.5), take('Bold', 0.9)] } })
    else await r.fulfill({ json: { changes: sliders.map(c => ({ key: c.path, value: far(c) })), rationale: 'Pushed it.' } })
  })
  return calls
}

const planReply = (message: string) => ({ json: { text: JSON.stringify({ reasoning: '', commands: [], message }) } })

/** Every node's saved data, as the canvas (its undo history and autosave) sees it. Walks up from
 *  `.vue-flow` to VueNodeCanvas's exposed surface (tests/character-sheet.spec.ts's recipe). */
async function savedCanvas(page: Page): Promise<string> {
  return page.evaluate(() => {
    let c: any = (document.querySelector('.vue-flow') as any)?.__vueParentComponent
    while (c && !(c.exposed && typeof c.exposed.getNodes === 'function')) c = c.parent
    if (!c) throw new Error('VueNodeCanvas exposed surface not reachable')
    return JSON.stringify(c.exposed.getNodes().map((n: any) => n.data))
  })
}

/** Effect takes the render checks pass: each loops over LOOP() through the preamble's
 *  loopPhase() / loopCircle() (a raw u_time body now fails the seamless-loop check), and each
 *  visibly changes the picture under it, even a flat one (a hue sweep across it), so none is
 *  thrown away as "changed nothing". */
const loopedTake = (name: string, hueScale: number) => ({
  name, animated: true, generative: false,
  params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.7 },
    { uniform: 'u_sat', label: 'Colour', type: 'float', min: 0, max: 1, step: 0.01, default: 0.75 },
    { uniform: 'u_drift', label: 'Drift', type: 'float', min: 0, max: 0.05, step: 0.001, default: 0.01 },
  ],
  body: `uniform float u_amount; uniform float u_sat; uniform float u_drift;
void main(){
  vec3 c = tex(v_texCoord + loopCircle(u_drift));
  vec3 tint = hsv2rgb(vec3(fract(v_texCoord.x * ${hueScale.toFixed(1)} + loopPhase()), u_sat, 0.9));
  float s = 0.5 + 0.5 * sin(6.28318530718 * loopPhase());
  fragColor0 = vec4(mix(c, tint, u_amount * (0.6 + 0.2 * s)), 1.0);
}`,
})
const LOOPED_TAKES = [loopedTake('Hue sweep', 1), loopedTake('Double sweep', 2), loopedTake('Triple sweep', 3)]

/** `upper` sits wholly above `lower` on screen. */
async function expectAbove(upper: Locator, lower: Locator) {
  const a = (await upper.boundingBox())!
  const b = (await lower.boundingBox())!
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1)
}

test.describe('the one prompt in studios', () => {
  let leaked: string[] = []
  test.beforeEach(async ({ page }) => {
    leaked = await guardModelRoutes(page)
    await seedKey(page)
  })
  test.afterEach(() => {
    expect(leaked, 'a model route was called without a mock').toEqual([])
  })

  test('Shader: the chip is the effect, / focuses the studio prompt, Esc leaves it without closing', async ({ page }) => {
    await mockRouter(page, 'tweak')
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    const chip = page.getByTestId('studio-prompt').getByTestId('prompt-selection-chip')
    await expect(chip).not.toHaveText('')
    // The chip names the effect, exactly as the inspector head does.
    const head = (await page.getByTestId('studio-inspector-head').innerText()).trim()
    expect(head).toContain((await chip.innerText()).trim())
    await page.keyboard.press('/')
    await expect(prompt(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(prompt(page)).not.toBeFocused()
    await expect(page.getByTestId('studio-shell-dock')).toBeVisible() // the studio is still open
  })

  test('Shader: a request routes as a studio and three takes show above the prompt; Keep closes the strip', async ({ page }) => {
    const routed = await mockRouter(page, 'tweak')
    const vibe = await mockVibe(page)
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    await prompt(page).fill('warmer')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 20_000 })
    expect(routed[0]).toMatchObject({ request: 'warmer', host: 'studio' })
    expect(vibe[0].variants).toBe(3)
    const tiles = page.getByTestId('prompt-take-tile')
    await expect(tiles).toHaveCount(3)
    await expectAbove(page.getByTestId('prompt-takes'), prompt(page))
    const first = tiles.first()
    await expect(first).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
    await first.hover()
    await expect(first.getByRole('button', { name: 'Keep', exact: true })).toHaveCount(0) // no separate Keep
    await first.getByRole('button', { name: 'Take 1' }).click() // the click keeps it
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
  })

  test('Shader: Rewrite the effect sets a priced mode chip, and sending writes three effect takes above the prompt, with no router call', async ({ page }) => {
    const routed = await mockRouter(page, 'tweak')
    const vibe = await mockVibe(page)
    // /api/shader-gen answers each take with the spike's hand-written rain take (no model is reached).
    const written: string[] = []
    await page.route('**/api/shader-gen', async (r) => {
      const body = r.request().postDataJSON()
      written.push(String(body.prompt ?? ''))
      const slot = Number(/Take (\d):/.exec(String(body.prompt ?? ''))?.[1] ?? 1) - 1
      await r.fulfill({ json: { text: JSON.stringify(SPIKE_TAKES.rain![slot % SPIKE_TAKES.rain!.length]), usage: null, stop_reason: 'end_turn' } })
    })
    const saved: string[] = []
    await page.route('**/api/my-effects**', async (r) => {
      if (r.request().method() !== 'GET') saved.push(r.request().method())
      await r.fulfill({ json: { effects: [] } })
    })
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    const remix = page.getByTestId('studio-actions').locator('[data-testid="studio-action-row"][data-action-id="remix"]')
    await expect(remix).toContainText('Rewrite the effect')
    await expect(remix.getByTestId('studio-action-price')).toHaveText('48–88 credits')
    await remix.click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('Remix')
    // The chip carries the price before anything runs.
    await expect(page.getByTestId('studio-prompt').getByTestId('prompt-note')).toHaveText('48–88 credits')
    await expect(prompt(page)).toBeFocused()
    await prompt(page).fill('ink on paper')
    await prompt(page).press('Enter')
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await expectAbove(strip, prompt(page))
    const tiles = page.getByTestId('prompt-take-tile')
    await expect(tiles).toHaveCount(3)
    // Every tile settles (a take either passes the checks or shows it didn't come back).
    await expect(page.locator('[data-testid="prompt-take-tile"][data-state="pending"]')).toHaveCount(0, { timeout: 60_000 })
    // A mode chip decides the kind itself: no router call, and the studio's tune never runs.
    expect(routed).toHaveLength(0)
    expect(vibe).toHaveLength(0)
    // One call per take (a take that fails its checks may be asked again), each carrying the request.
    expect(written.length).toBeGreaterThanOrEqual(3)
    for (const n of [1, 2, 3]) expect(written.some(w => w.includes(`Take ${n}:`))).toBe(true)
    expect(written.every(w => w.includes('ink on paper'))).toBe(true)
    await expect(page.getByTestId('prompt-mode-chip')).toHaveCount(0)
    // While the set is open the layer it previews on is read-only: its dials, the effect
    // picker, and the stack's shape (× puts back the layer as it was).
    const layerControls = page.getByTestId('shader-studio-layer-controls')
    const changeEffect = page.getByTestId('studio-inspector-head').getByRole('button', { name: 'Change effect' })
    await expect(layerControls).toHaveAttribute('inert', /.*/)
    await expect(changeEffect).toBeDisabled()
    const layerRows = () => page.getByRole('button', { name: 'Toggle layer' }).count()
    const before = await layerRows()
    await page.getByRole('button', { name: 'Add layer' }).click()
    await expect(page.getByTestId('shader-add-layer-menu')).toHaveCount(0) // the + menu stays shut while a set is open
    expect(await layerRows()).toBe(before)
    // × puts the effect back, saves nothing, and hands the controls back.
    await strip.getByRole('button', { name: 'Close takes' }).click()
    await expect(strip).toHaveCount(0)
    expect(saved).toEqual([])
    await expect(layerControls).not.toHaveAttribute('inert', /.*/)
    await expect(changeEffect).toBeEnabled()
  })

  test('Shader: the head names the effect; two AI rows with a description and a price; the hint; the dice; the Layers + menu', async ({ page }) => {
    await openStudio(page, 'ShaderStudio', 'sailor:openShaderStudio')
    const head = page.getByTestId('studio-inspector-head')
    const changeEffect = head.getByRole('button', { name: 'Change effect' })
    await expect(changeEffect).toBeEnabled()
    // Pick an effect from the gallery: the head then names it.
    await changeEffect.click()
    const gallery = page.getByTestId('effect-gallery')
    const card = gallery.locator('[data-effect-id="water_ripple"]')
    const picked = (await card.locator('.truncate').first().innerText()).trim()
    await card.click()
    await gallery.getByRole('button', { name: 'Use effect' }).click()
    await expect(page.getByTestId('effect-gallery')).toHaveCount(0)
    await expect(head.getByTestId('studio-inspector-title')).toHaveText(picked)
    // Change effect sits on the title's own row.
    const t = (await head.getByTestId('studio-inspector-title').boundingBox())!
    const c = (await changeEffect.boundingBox())!
    expect(Math.abs((t.y + t.height / 2) - (c.y + c.height / 2))).toBeLessThan(12)
    const actions = page.getByTestId('studio-actions')
    await expect(actions.getByRole('heading')).toHaveCount(0)
    const rows = actions.getByTestId('studio-action-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByTestId('studio-action-name')).toHaveText('Try other settings')
    await expect(rows.nth(0).getByTestId('studio-action-description')).toHaveText('Same effect, 3 new sets of dial values')
    await expect(rows.nth(0).getByTestId('studio-action-price')).toHaveText('2–6 credits')
    await expect(rows.nth(1).getByTestId('studio-action-name')).toHaveText('Rewrite the effect')
    await expect(rows.nth(1).getByTestId('studio-action-description')).toHaveText('3 new versions of the code itself')
    await expect(rows.nth(1).getByTestId('studio-action-price')).toHaveText('48–88 credits')
    // Names fit: never cut.
    for (const i of [0, 1]) {
      const fits = await rows.nth(i).getByTestId('studio-action-name').evaluate(el => el.scrollWidth <= el.clientWidth + 1)
      expect(fits).toBe(true)
    }
    await expect(actions.getByTestId('studio-actions-hint')).toHaveText('Or type what you want in the prompt below')
    await expect(actions).not.toContainText('Tune')
    await expect(actions).not.toContainText('New variation')
    await expect(actions).not.toContainText('New layer')
    await expectAbove(changeEffect, actions)

    // The screenshot for Julien: the inspector's top, head to the Source card.
    const shot = process.env.SAILOR_INSPECTOR_SHOT
    if (shot) {
      const top = (await head.boundingBox())!
      const source = (await page.locator('summary').filter({ hasText: 'Source' }).first().boundingBox())!
      const col = (await actions.boundingBox())!
      await page.screenshot({ path: shot, clip: { x: col.x - 16, y: top.y - 16, width: col.width + 32, height: source.y + source.height + 110 - (top.y - 16) } })
    }

    // New variation is the dice on the Variation dial: a fresh seed.
    const seed = page.getByRole('slider', { name: 'Variation' })
    const before = await seed.getAttribute('aria-valuenow')
    let changed = false
    for (let i = 0; i < 3 && !changed; i++) {
      await page.getByRole('button', { name: 'New variation' }).click()
      changed = (await seed.getAttribute('aria-valuenow')) !== before
    }
    expect(changed).toBe(true)

    // Describe a new layer lives in the Layers + menu, starred and priced; it sets the New effect chip.
    await page.getByRole('button', { name: 'Add layer' }).click()
    const menu = page.getByTestId('shader-add-layer-menu')
    await expect(menu).toBeVisible()
    const describe = menu.locator('[data-action-id="new-layer"]')
    await expect(describe.getByTestId('studio-action-name')).toHaveText('Describe a new layer')
    await expect(describe.getByTestId('studio-action-price')).toHaveText('48–88 credits')
    await describe.click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    await expect(prompt(page)).toBeFocused()
    // The other item adds an empty layer, as + used to.
    const layerRows = () => page.getByRole('button', { name: 'Toggle layer' }).count()
    const n = await layerRows()
    await page.getByRole('button', { name: 'Add layer' }).click()
    await menu.locator('[data-action-id="empty-layer"]').click()
    await expect.poll(layerRows).toBe(n + 1)
  })

  test('Space type: the transport is in the tool bar and a request comes back as a proposed change', async ({ page }) => {
    const routed = await mockRouter(page, 'tweak')
    const vibe = await mockVibe(page)
    await openStudio(page, 'SpaceType', 'sailor:openSpaceType')
    const toolBar = page.getByTestId('studio-tool-bar')
    await expect(toolBar.getByRole('slider', { name: 'Scrub preview' })).toBeVisible({ timeout: 15_000 })
    await expectAbove(prompt(page), toolBar)
    await prompt(page).fill('slower')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-changes')).toBeVisible({ timeout: 20_000 })
    expect(routed[0]).toMatchObject({ request: 'slower', host: 'studio' })
    expect(vibe[0].variants).toBeUndefined() // Space type has no takes: one proposal
    await expect(page.getByTestId('prompt-change-row').first()).toBeVisible()
    await expectAbove(page.getByTestId('prompt-changes'), prompt(page))
    await page.getByTestId('prompt-changes').getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(page.getByTestId('prompt-changes')).toHaveCount(0)
  })

  test('Frame: a full row (no pill), still there in Motion, results above it', async ({ page }) => {
    const routed = await mockRouter(page, 'plan')
    const plans: any[] = []
    await page.route('**/api/agent-plan', (r) => { plans.push(r.request().postDataJSON()); return r.fulfill(planReply('Nothing to change.')) })
    await openCompositor(page)
    const dock = page.getByTestId('compositor-prompt-dock')
    const box = dock.getByRole('textbox', { name: 'Ask Sailor' })
    await expect(box).toBeVisible()
    await expect(page.getByTestId('compositor-prompt-pill')).toHaveCount(0)
    await box.fill('tighten it')
    await box.press('Enter')
    await expect(dock.getByTestId('prompt-answer')).toContainText('Nothing to change', { timeout: 20_000 })
    expect(routed[0]).toMatchObject({ request: 'tighten it', host: 'frame' })
    expect(plans).toHaveLength(1)
    await expectAbove(dock.getByTestId('prompt-answer'), box)
    await page.getByRole('button', { name: 'Motion', exact: true }).first().click()
    await expect(box).toBeVisible()
  })

  test('Frame: a routed new effect writes three takes for the background, the Frame is inert while they are open, and × ends it', async ({ page }) => {
    const routed = await mockRouter(page, 'new-effect')
    const written: string[] = []
    await page.route('**/api/shader-gen', async (r) => {
      const body = r.request().postDataJSON()
      written.push(String(body.prompt ?? ''))
      const slot = Number(/Take (\d):/.exec(String(body.prompt ?? ''))?.[1] ?? 1) - 1
      await r.fulfill({ json: { text: JSON.stringify(LOOPED_TAKES[slot % LOOPED_TAKES.length]), usage: null, stop_reason: 'end_turn' } })
    })
    await page.route('**/api/my-effects**', r => r.fulfill({ json: { effects: [] } }))
    await openCompositor(page)
    const dock = page.getByTestId('compositor-prompt-dock')
    const box = dock.getByRole('textbox', { name: 'Ask Sailor' })
    await box.fill('rain on a window')
    await box.press('Enter')
    const strip = dock.getByTestId('prompt-takes')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await expect(strip).toContainText('Background')
    expect(routed[0]).toMatchObject({ request: 'rain on a window', host: 'frame' })
    await expect(dock.locator('[data-testid="prompt-take-tile"][data-state="pending"]')).toHaveCount(0, { timeout: 60_000 })
    expect(written.length).toBeGreaterThanOrEqual(3)
    // × would put back what was there, so nothing else may be edited meanwhile.
    await expect(page.getByTestId('frame-edit-surface')).toHaveAttribute('inert', /.*/)
    // A previewed take is shown on the artboard only: no draft ever reaches the saved Frame node
    // (so no canvas undo step or autosave can hold one), and × leaves the node as it was.
    const savedBefore = await savedCanvas(page)
    const ready = dock.locator('[data-testid="prompt-take-tile"][data-state="ready"]')
    await expect(ready).toHaveCount(3) // every take passes the checks: none "didn't loop" or "changed nothing"
    await ready.first().getByRole('button', { name: /^Take \d$/ }).hover() // previewed (a click would keep it)
    await page.waitForTimeout(600)
    const during = await savedCanvas(page)
    expect(during).not.toContain('draft_')
    expect(during).toBe(savedBefore)
    await strip.getByRole('button', { name: 'Close takes' }).click()
    await expect(strip).toHaveCount(0)
    expect(await savedCanvas(page)).toBe(savedBefore)
    await expect(page.getByTestId('frame-edit-surface')).not.toHaveAttribute('inert', /.*/)
  })

  test('3D: the prompt sits above the add bar and answers plainly', async ({ page }) => {
    const routed = await mockRouter(page, 'tweak')
    await openStudio(page, 'Scene3DStudio', 'sailor:openScene3DStudio')
    const addBar = page.locator('[data-prim-menu]').first()
    await expect(addBar).toBeVisible({ timeout: 15_000 })
    await expectAbove(page.getByTestId('studio-shell-dock'), addBar)
    await prompt(page).fill('make it glass')
    await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-answer')).toContainText('3D can’t take instructions yet')
    // 3D has no worker, so the answer is fixed: no router call is paid for it.
    expect(routed).toHaveLength(0)
  })

  test('Template editor: the one prompt routes, and its answer shows above it', async ({ page }) => {
    const routed = await mockRouter(page, 'plan')
    await page.route('**/api/agent-plan', r => r.fulfill(planReply('Nothing to change.')))
    await page.goto('/dev/v3editor')
    await page.waitForLoadState('networkidle')
    // A click before hydration lands on dead SSR markup: retry until the picker goes.
    const start = page.getByRole('button', { name: /Start designing/ })
    const box = prompt(page)
    await expect(async () => {
      if (await start.isVisible()) await start.click({ timeout: 5_000 })
      await expect(box).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 45_000 })
    await box.fill('tighten spacing')
    await box.press('Enter')
    const answer = page.getByTestId('studio-prompt').getByTestId('prompt-answer')
    await expect(answer).toContainText('Nothing to change', { timeout: 20_000 })
    expect(routed[0]).toMatchObject({ request: 'tighten spacing', host: 'studio' })
    await expectAbove(answer, box)
  })
})
