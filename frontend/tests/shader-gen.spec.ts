import { expect, test, type Page, type Route } from '@playwright/test'
import { dropNode, openBlankWorkflow, openCompositor, openStudio, waitForBackend } from './_helpers'
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

/** The spike takes predate the loop rule: their motion runs on raw u_time, which the seamless-loop
 *  check rejects. The mock replies run the same bodies on a clock that swings smoothly out and
 *  back once per LOOP() — seamless by construction — so they still pass every check. */
const LOOPED_TIME = '(0.5 * LOOP() * (1.0 - cos(6.28318530718 * loopPhase())))'
const S = Object.fromEntries(Object.entries(SPIKE_TAKES).map(([k, ts]) => [k, ts.map(t => ({ ...t, body: t.body.replace(/\bu_time\b/g, LOOPED_TIME) }))])) as typeof SPIKE_TAKES
/** Per slot (take angle), the reply to its 1st, 2nd, … call. */
const TAKES = [
  [S.rain![0]!, S.lava![0]!, S.popart![0]!],
  [S.rain![3]!, S.lava![1]!, S.popart![1]!],
  [S.oil![1]!, S.lava![2]!, S.ink![1]!],
]
/** Only takes that read their input (`generative: false`) — what a kept take over no picture was. */
const READS_INPUT_TAKES = [
  [S.rain![0]!, S.popart![0]!, S.rain![3]!],
  [S.popart![1]!, S.oil![1]!, S.ink![1]!],
  [S.lava![3]!, S.oil![0]!, S.popart![3]!],
]
/** A loop-correct take that costs next to nothing to draw: a slow hue swing over the picture. */
const CHEAP_LOOPED_TAKE = {
  name: 'Hue swing', animated: true, generative: false,
  params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.6 },
    { uniform: 'u_warm', label: 'Warmth', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 },
    { uniform: 'u_cycles', label: 'Cycles', type: 'float', min: 1, max: 4, step: 1, default: 1 },
  ],
  body: `uniform float u_amount; uniform float u_warm; uniform float u_cycles;
void main(){
  vec3 c = tex(v_texCoord);
  float s = 0.5 + 0.5 * sin(6.28318530718 * loopPhase() * max(1.0, floor(u_cycles + 0.5)));
  vec3 tint = mix(vec3(0.2, 0.5, 1.0), vec3(1.0, 0.55, 0.2), u_warm);
  fragColor0 = vec4(mix(c, c * tint * 1.6, u_amount * s), 1.0);
}`,
}
/** "Prism drift" as Julien's takes came back (2026-09-25): thin coloured beams over the photo, a
 *  fast whole-cycle wobble — and a slow drift that grows with loopPhase(), so every beam teleports
 *  back ≈10 px at the wrap. The old image-mean loop check passed it. */
const beamsTake = (drift: string) => ({
  name: 'Prism beams', animated: true, generative: false,
  params: [
    { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.9 },
    { uniform: 'u_width', label: 'Beam width', type: 'float', min: 0.5, max: 4, step: 0.1, default: 1.5 },
    { uniform: 'u_dim', label: 'Dim', type: 'float', min: 0, max: 1, step: 0.01, default: 0.2 },
  ],
  body: `uniform float u_amount; uniform float u_width; uniform float u_dim;
void main(){
  vec3 c = tex(v_texCoord);
  float wob = 0.1 * sin(6.28318530718 * 3.0 * loopPhase());
  float drift = ${drift};
  vec3 beams = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float d = abs(v_texCoord.x - (0.15 + 0.22 * fi + wob + drift)) * u_resolution.x;
    beams += clamp(1.0 - d / u_width, 0.0, 1.0) * thinfilm(0.3 * fi);
  }
  fragColor0 = vec4(c * (1.0 - u_dim) + beams * u_amount, 1.0);
}`,
})
const TELEPORT_BEAMS = beamsTake('0.04 * loopPhase()')
const LOOPING_BEAMS = beamsTake('loopCircle(0.02).x')
const PRICE = '~$0.24–0.42'
/** One more picture on every call (a reference, ≤ 512 px: 350 input tokens). */
const PRICE_WITH_REFERENCE = '~$0.24–0.43'

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
async function mockShaderGen(page: Page, delays = [300, 900, 1500], takes = TAKES) {
  const calls: any[] = []
  const perSlot = [0, 0, 0]
  await page.route('**/api/shader-gen', async (r) => {
    const body = r.request().postDataJSON()
    calls.push(body)
    const slot = (Number(ANGLE.exec(String(body.prompt ?? ''))?.[1] ?? 1) - 1) % takes.length
    // Each call gets a take of its own: a slot that has used up its replies gets a reply that
    // isn't a take (the engine fails that slot), never an earlier take again.
    const take = takes[slot]![perSlot[slot]!++]
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

/** Paste a small real PNG into the studio prompt. A real ⌘V needs OS clipboard permission
 *  headless; this paste event carries a real PNG File in a real DataTransfer — what the browser
 *  hands the field on ⌘V. */
async function pastePicture(page: Page) {
  const box = prompt(page)
  await box.click()
  await box.evaluate(async (el) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#e0457b'; ctx.fillRect(0, 0, 64, 48)
    const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'look.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
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
    await page.getByTestId('studio-actions').locator('[data-testid="studio-action-row"][data-action-id="remix"]').click()
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

  test('no source picture: the request asks for a standalone effect, and a kept take that reads its input still shows, over the sample picture', async ({ page }) => {
    const gen = await mockShaderGen(page, [100, 200, 300], READS_INPUT_TAKES); const store = await mockMyEffects(page); await mockRouter(page)
    await openShaderStudio(page)
    await page.getByRole('button', { name: 'Add layer' }).click()
    await page.getByTestId('shader-add-layer-menu').locator('[data-action-id="new-layer"]').click()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    await prompt(page).fill('prism light'); await prompt(page).press('Enter')
    const strip = page.getByTestId('prompt-takes')
    await expect(strip).toBeVisible({ timeout: 20_000 })
    await expect(tileIn(page, 'pending')).toHaveCount(0, { timeout: 60_000 })
    // Nothing is wired in: no picture goes to the model, and the prompt asks for a standalone effect.
    expect(gen.length).toBeGreaterThanOrEqual(3)
    expect(gen.every(b => !b.images?.length)).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('There is no picture for the effect to run over'))).toBe(true)
    const ready = tileIn(page, 'ready').first()
    // Hover-preview already draws it over the sample picture (before the fix: "Add a source image to begin").
    await ready.getByRole('button', { name: /Preview take/ }).hover()
    await expect(page.getByTestId('shader-studio-sample-hint')).toBeVisible()
    await ready.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(page.getByTestId('prompt-answer')).toContainText('Saved to My effects as')
    expect([...store.values()][0]?.generative).toBe(false) // the case Julien hit: the kept take reads its input
    // The preview is not empty: it draws the effect over the sample picture, and says so quietly.
    await expect(page.getByText('Add a source image to begin')).toHaveCount(0)
    await expect(page.getByTestId('shader-studio-sample-hint')).toHaveText('Shown over a sample picture. Upload an image to see it on yours.')
    const preview = page.getByTestId('shader-studio-preview')
    await expect.poll(() => preview.evaluate((c: HTMLCanvasElement) => {
      if (c.width < 100 || c.height < 100) return 0
      const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
      let lit = 0
      for (let i = 0; i < px.length; i += 4 * 97) if (px[i + 3]! > 0 && px[i]! + px[i + 1]! + px[i + 2]! > 30) lit++
      return lit
    }), { timeout: 15_000 }).toBeGreaterThan(50)
  })

  test('a take whose motion runs on raw u_time is sent back: it does not loop seamlessly', async ({ page }) => {
    // Every slot's first reply is a spike take as written (raw u_time); its second is the same
    // body on the looped clock. The real renderer's loop check rejects the first.
    const raw = SPIKE_TAKES.lava!
    const gen = await mockShaderGen(page, [100, 200, 300], [[raw[0]!, S.lava![0]!], [raw[1]!, S.lava![1]!], [raw[2]!, S.lava![2]!]])
    await mockMyEffects(page); await mockRouter(page)
    await openShaderStudio(page)
    await page.getByRole('button', { name: 'Add layer' }).click()
    await page.getByTestId('shader-add-layer-menu').locator('[data-action-id="new-layer"]').click()
    await prompt(page).fill('molten wax'); await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 20_000 })
    await expect(tileIn(page, 'pending')).toHaveCount(0, { timeout: 60_000 })
    const retries = gen.filter(b => String(b.prompt).includes('the render did not loop seamlessly'))
    expect(retries.length).toBeGreaterThanOrEqual(1)
    expect(await tileIn(page, 'ready').count()).toBeGreaterThanOrEqual(1)
  })

  test('thin beams that teleport at the wrap are caught by the take renderer; the same beams looping pass', async ({ page }) => {
    await page.goto('/_nuxt/lib/shadergen/browserRenderer.ts')
    const flags = await page.evaluate(async (takes) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 384
      const ctx = c.getContext('2d')!
      const g = ctx.createLinearGradient(0, 0, 512, 384); g.addColorStop(0, '#20324a'); g.addColorStop(1, '#e0b080')
      ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 384)
      const { createBrowserTakeRenderer } = await import('/_nuxt/lib/shadergen/browserRenderer.ts' as string)
      const r = createBrowserTakeRenderer(c)
      const out = takes.map((t) => { const take = { ...t }; const err = r.compile(take); return err ? [`compile: ${err}`] : r.judge(take).flags })
      r.dispose?.()
      return out
    }, [TELEPORT_BEAMS, LOOPING_BEAMS])
    expect(flags[0]).toContain('does not loop')
    expect(flags[1]).not.toContain('does not loop')
    expect(flags[1]!.filter(f => f !== 'heavy' && f !== 'does not move')).toEqual([])
  })

  test('a take whose thin beams teleport at the wrap is sent back, and its tile says "Didn’t loop cleanly"', async ({ page }) => {
    const gen = await mockShaderGen(page, [100, 200, 300], [[TELEPORT_BEAMS, TELEPORT_BEAMS], [TELEPORT_BEAMS, TELEPORT_BEAMS], [TELEPORT_BEAMS, TELEPORT_BEAMS]])
    await mockMyEffects(page); await mockRouter(page)
    const warnings: string[] = []
    page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[shader-gen]')) warnings.push(m.text()) })
    await openShaderStudio(page)
    await page.getByRole('button', { name: 'Add layer' }).click()
    await page.getByTestId('shader-add-layer-menu').locator('[data-action-id="new-layer"]').click()
    await prompt(page).fill('make it loop'); await prompt(page).press('Enter')
    await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 20_000 })
    await expect(tileIn(page, 'pending')).toHaveCount(0, { timeout: 60_000 })
    expect(gen.filter(b => String(b.prompt).includes('the render did not loop seamlessly')).length).toBeGreaterThanOrEqual(1)
    await expect(tileIn(page, 'ready')).toHaveCount(0)
    await expect(tileIn(page, 'failed')).toHaveCount(3)
    await expect(tileIn(page, 'failed')).toContainText(['Didn’t loop cleanly', 'Didn’t loop cleanly', 'Didn’t loop cleanly'])
    await expect.poll(() => warnings.filter(w => w.includes('checks: does not loop')).length).toBe(3)
  })

  test('a My effect never visibly resets: the seam blend makes the loop’s end its start, and leaves the rest of the loop alone', async ({ page }) => {
    await page.goto('/_nuxt/lib/shadergen/seamBlend.ts')
    const r = await page.evaluate(async ({ take }) => {
      const { withSeamBlend } = await import('/_nuxt/lib/shadergen/seamBlend.ts' as string)
      const { toEffectDef } = await import('/_nuxt/lib/shadergen/effectDef.ts' as string)
      const { ShaderFxRenderer } = await import('/_nuxt/lib/shaderfx/renderer.ts' as string)
      const src = document.createElement('canvas'); src.width = 256; src.height = 256
      const ctx = src.getContext('2d')!; ctx.fillStyle = '#556677'; ctx.fillRect(0, 0, 256, 256)
      const raw = toEffectDef(take, 'mine_rawrawrawraw~v1')
      const seamed = withSeamBlend({ ...raw, mine: true })
      const renderer = new ShaderFxRenderer()
      const read = (def: any, t: number, loop: number) => {
        const out = renderer.render([{ id: def.id + (def === seamed ? '#s' : ''), source: def.source, uniforms: { u_amount: 0.9, u_width: 1.5, u_dim: 0.2, u_time: t, u_loop: loop, u_seed: 0 } }], src, 256, 256)
        const c = document.createElement('canvas'); c.width = 256; c.height = 256
        const x = c.getContext('2d')!; x.drawImage(out, 0, 0); return x.getImageData(0, 0, 256, 256).data
      }
      /** How much changed, in whole pixels' worth (each pixel's largest channel change). */
      const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < a.length; i += 4) n += Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) / 255; return n }
      const L = 4, D = L / 5000
      const res = {
        wrapped: seamed.source !== raw.source,
        // Across the wrap: the raw body jumps, the seamed one doesn't.
        rawWrap: diff(read(raw, L - D, L), read(raw, 0, L)),
        seamWrap: diff(read(seamed, L - D, L), read(seamed, 0, L)),
        seamStep: diff(read(seamed, 0, L), read(seamed, D, L)),
        // Outside the blend window (last 0.5 s of 4 s) it is the body as written, pixel for pixel.
        outside: diff(read(seamed, 1.7, L), read(raw, 1.7, L)),
        // Inside it, it is between the two.
        inside: diff(read(seamed, 3.8, L), read(raw, 3.8, L)),
        // A host with no loop (u_loop 0: LOOP() is 4 s) and a clock that keeps growing loops at 4 s too.
        growing: diff(read(seamed, 8 + 1.7, 0), read(seamed, 1.7, 0)),
      }
      renderer.dispose()
      return res
    }, { take: TELEPORT_BEAMS })
    expect(r.wrapped).toBe(true)
    expect(r.rawWrap).toBeGreaterThan(10 * r.seamStep)
    expect(r.seamWrap).toBeLessThan(3 * r.seamStep)
    expect(r.outside).toBe(0)
    expect(r.inside).toBeGreaterThan(0)
    expect(r.growing).toBe(0)
  })

  test('a large source photo does not make takes fail: the take renderer judges and times them on a small copy', async ({ page }) => {
    // Julien, 2026-09-25: a Remix over a loaded photo came back "Didn't come back" ×3. The take
    // renderer uploaded the full-size photo on every render, the timed "heavy" frames included, so
    // the cost check measured the photo's upload (≈1 s a frame at 4096², noise ≫ 8 ms), not the shader.
    await page.goto('/_nuxt/lib/shadergen/browserRenderer.ts')
    const flags = await page.evaluate(async (take) => {
      const c = document.createElement('canvas'); c.width = 4096; c.height = 3072
      const ctx = c.getContext('2d')!
      const g = ctx.createLinearGradient(0, 0, 4096, 3072); g.addColorStop(0, '#20324a'); g.addColorStop(1, '#e0b080')
      ctx.fillStyle = g; ctx.fillRect(0, 0, 4096, 3072)
      for (let i = 0; i < 4000; i++) { ctx.fillStyle = `hsl(${i % 360} 60% ${30 + (i % 50)}%)`; ctx.fillRect((i * 7919) % 4096, (i * 104729) % 3072, 40, 40) }
      const blob: Blob = await new Promise(res => c.toBlob(b => res(b!), 'image/jpeg', 0.9))
      const img = new Image(); img.src = URL.createObjectURL(blob); await img.decode()
      const { createBrowserTakeRenderer } = await import('/_nuxt/lib/shadergen/browserRenderer.ts' as string)
      const r = createBrowserTakeRenderer(img)
      const out: string[][] = []
      for (let k = 0; k < 3; k++) { const t = { ...take }; if (r.compile(t)) return [['compile failed']]; out.push(r.judge(t).flags) }
      r.dispose?.()
      return out
    }, CHEAP_LOOPED_TAKE)
    expect(flags).toEqual([[], [], []])
  })

  test('Stop mid-run clears partial takes and puts the layer stack back', async ({ page }) => {
    await mockShaderGen(page, [200, 20_000, 20_000]); await mockMyEffects(page); await mockRouter(page)
    await openShaderStudio(page)
    const layerRows = () => page.getByRole('button', { name: 'Toggle layer' }).count()
    const before = await layerRows()
    await page.getByRole('button', { name: 'Add layer' }).click()
    await page.getByTestId('shader-add-layer-menu').locator('[data-action-id="new-layer"]').click()
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
  test('Shader studio: a pasted picture becomes the reference chip, sets New effect, and goes to the model named as the look to aim for', async ({ page }) => {
    const gen = await mockShaderGen(page, [100, 200, 300]); await mockMyEffects(page); const routed = await mockRouter(page)
    await openShaderStudio(page)
    const box = prompt(page)
    await pastePicture(page)
    const chip = page.getByTestId('studio-prompt').getByTestId('prompt-reference-chip')
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('aria-label', 'Reference picture')
    expect(await chip.locator('img').getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/)
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    await expect(page.getByTestId('studio-prompt').getByTestId('prompt-note')).toHaveText(PRICE_WITH_REFERENCE)
    await expect(box).toHaveValue('') // the picture never lands in the field as text
    await box.fill('like this, but slower'); await box.press('Enter')
    await expect(page.getByTestId('prompt-takes')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => gen.length).toBeGreaterThanOrEqual(3)
    expect(routed).toHaveLength(0) // New effect decided the kind
    // A Shader studio with nothing wired in has no picture to run over: the reference is the only
    // picture on every call, is named so, and the effect is still asked to stand alone.
    // (Frame's background, below, sends both.)
    expect(gen.every(b => Array.isArray(b.images) && b.images.length === 1)).toBe(true)
    expect(gen.every(b => b.images[0] === gen[0].images[0] && /^data:image\/jpeg;base64,/.test(b.images[0]))).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('The one attached picture is the reference picture: the look to aim for'))).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('There is no picture for the effect to run over'))).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('like this, but slower'))).toBe(true)
    // "Three more" carries the higher price; × on the set clears the chip.
    await expect(tileIn(page, 'pending')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByTestId('prompt-takes').getByRole('button', { name: /^Three more/ })).toHaveText(`Three more · ${PRICE_WITH_REFERENCE}`)
    await expect(chip).toBeVisible()
    await page.getByTestId('prompt-takes').getByRole('button', { name: 'Close takes' }).click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
    await expect(chip).toHaveCount(0)
  })
  test('Frame background: a pasted picture goes second, after the Frame the effect runs over', async ({ page }) => {
    const gen = await mockShaderGen(page, [100, 200, 300]); await mockMyEffects(page); const routed = await mockRouter(page)
    await openCompositor(page)
    await pastePicture(page)
    await expect(page.getByTestId('studio-prompt').getByTestId('prompt-reference-chip')).toBeVisible()
    await expect(page.getByTestId('prompt-mode-chip')).toContainText('New effect')
    // No words: the picture is the request.
    await page.getByTestId('studio-prompt').getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => gen.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
    expect(routed).toHaveLength(0)
    expect(gen.every(b => Array.isArray(b.images) && b.images.length === 2)).toBe(true)
    expect(gen.every(b => b.images[1] === gen[0].images[1] && b.images[0] !== b.images[1])).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('Picture 1 is the image the effect runs over. Picture 2 is the reference picture: the look to aim for'))).toBe(true)
    expect(gen.every(b => String(b.prompt).includes('Request: "Match the look of the reference picture"'))).toBe(true)
    expect(gen.some(b => String(b.prompt).includes('There is no picture for the effect to run over'))).toBe(false)
    await page.getByTestId('prompt-stop').click()
    await expect(page.getByTestId('prompt-takes')).toHaveCount(0)
  })
})
